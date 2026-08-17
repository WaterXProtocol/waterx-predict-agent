/**
 * The self-hosted local Runner daemon.
 *
 * This is the process the plan (§6.4) puts the signer and the long-lived job
 * state inside. Starting it is a fixed sequence, and the order is the interesting
 * part:
 *
 * 1. **Prove the runtime directory is private, before opening anything.** The
 *    directory mode is what keeps another local account off the socket
 *    (`ipc/runtime-dir.ts`), so a Runner that cannot prove it refuses to start
 *    rather than starting insecurely.
 * 2. **Open the store and register this instance.** Registration is what makes
 *    the heartbeat meaningful and what a later Runner reads to decide whether
 *    anyone was watching.
 * 3. **Recover before listening.** Recovery decides what happened to every job
 *    the last process left behind, and it claims their leases. Accepting IPC
 *    first would let a client read — or cancel — a job whose disposition had not
 *    been determined yet.
 * 4. **Start the supervisor, then the socket.** The lease keeper must already be
 *    renewing before anything can act on a lease.
 *
 * Stopping runs the same sequence backwards, and the last two steps matter:
 * leases are handed back and the instance is marked stopped, so the next Runner
 * does not have to wait out a TTL for jobs nobody is running.
 *
 * **Whether this daemon drives jobs is a decision, not an inference.** Give it a
 * `driver` — a gateway, a signer and a price observer, supplied together — and it
 * starts a {@link JobScheduler} that claims runnable jobs and calls `driveJob` on
 * them every tick; omit it and the process recovers, supervises and answers,
 * while every job sits in the state recovery assigned it. The two are reported
 * apart, on the IPC handshake and in `runner.status`: `driving` is true only when
 * a scheduler is actually ticking, and `driverGaps` names what is missing when it
 * is not. A reachable Runner that isn't executing looks exactly like one that is
 * until you ask (ADR-0001 §6), so the answer has to be a field rather than an
 * impression.
 *
 * Nothing in *this package* constructs a driver. `runnerd` starts a daemon with
 * no `driver`: a signer does not exist here at all, and while
 * `QuoteStreamPriceObserver` does, opening the stream behind it takes credentials
 * and an endpoint this build has no file format for yet. An embedding application
 * supplies all three.
 */
import { hostname } from 'node:os';
import { join } from 'node:path';

import { systemClock, type Clock } from './clock.ts';
import { newInstanceId } from './ids.ts';
import { dispatch, toErrorBody, type RunnerCommandContext } from './ipc/dispatch.ts';
import { RunnerIpcServer } from './ipc/server.ts';
import {
  ensureRuntimeDir,
  mintIpcToken,
  writeIpcToken,
} from './ipc/runtime-dir.ts';
import { recoverJobs, type RecoveryReport } from './recovery.ts';
import {
  JobScheduler,
  type SchedulerDriver,
  type SchedulerEvent,
  type SchedulerTickReport,
} from './scheduler.ts';
import type { JobStore } from './store.ts';
import { LeaseKeeper, type LeaseLossReason } from './supervisor.ts';

/**
 * The pieces a daemon started with no `driver` is missing.
 *
 * This is a list of what a daemon INSTANCE was not handed, not of what the
 * package can build. Both `JobScheduler` and `QuoteStreamPriceObserver` exist;
 * a daemon started with no `driver` still has neither, because nothing wired one
 * up, and it still has no signer because none exists to wire. The consequence is
 * the loop: starting one that could not act would be worse than not starting it.
 */
export const RUNNER_DRIVER_GAPS: readonly string[] = ['scheduler', 'signer', 'price-watcher'];

export interface RunnerDaemonOptions {
  /** Already open. The daemon closes it on `stop` only if it opened it. */
  readonly store: JobStore;
  /** Must be `0700` and owned by this uid, or the daemon refuses to start. */
  readonly runtimeDir: string;
  readonly instanceId?: string;
  readonly now?: Clock;
  readonly leaseTtlMs?: number;
  readonly renewIntervalMs?: number;
  readonly safetyMarginMs?: number;
  /** How long a silent instance may be presumed alive during recovery. */
  readonly staleAfterMs?: number;
  readonly authTimeoutMs?: number;
  /**
   * Supply this and the daemon drives. Its presence is the whole difference
   * between a Runner that answers and a Runner that runs, so it is one option
   * carrying all three collaborators rather than three that can be half-given.
   */
  readonly driver?: SchedulerDriver;
  /** Only meaningful with a `driver`. How often each held job gets a pass. */
  readonly tickIntervalMs?: number;
  /** Only meaningful with a `driver`. The most jobs this instance holds at once. */
  readonly maxJobs?: number;
  /** Diagnostics. Never given a token, a signature or transaction bytes. */
  readonly onEvent?: (event: RunnerDaemonEvent) => void;
}

export type RunnerDaemonEvent =
  | { readonly kind: 'started'; readonly instanceId: string; readonly socketPath: string }
  | { readonly kind: 'recovered'; readonly report: RecoveryReport }
  | { readonly kind: 'lease-lost'; readonly jobId: string; readonly reason: LeaseLossReason }
  /** One scheduler event, forwarded verbatim. Absent when nothing drives. */
  | { readonly kind: 'scheduler'; readonly event: SchedulerEvent }
  | { readonly kind: 'shutdown-requested'; readonly reason: string }
  | { readonly kind: 'stopped'; readonly instanceId: string }
  | { readonly kind: 'error'; readonly context: string; readonly message: string };

const DEFAULTS = {
  leaseTtlMs: 30_000,
  renewIntervalMs: 5_000,
  safetyMarginMs: 10_000,
  staleAfterMs: 60_000,
  // A pass costs one market read per involved market plus, at the trigger, a
  // quote per leg. One second would be a read bill nobody asked for; two is the
  // server's own quote-cache poll interval, so a faster tick buys nothing.
  tickIntervalMs: 2_000,
} as const;

export interface RunnerDaemonHandle {
  readonly instanceId: string;
  readonly socketPath: string;
  readonly tokenPath: string;
  /**
   * The bearer token for this run. Returned so an in-process caller (a test, or
   * an embedding application) need not read the file. It is never logged, never
   * put in an event, and never included in an error body.
   */
  readonly token: string;
  readonly recovery: RecoveryReport;
  /** Whether a scheduler is ticking. The one field that means "running". */
  readonly driving: boolean;
}

export class RunnerDaemon {
  private readonly instanceIdValue: string;
  private readonly now: Clock;
  private readonly leases: LeaseKeeper;
  private readonly scheduler: JobScheduler | undefined;
  private server: RunnerIpcServer | undefined;
  private recovery: RecoveryReport | undefined;
  private startedAt: string | undefined;
  private stopping: Promise<void> | undefined;
  private shutdownTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: RunnerDaemonOptions) {
    this.instanceIdValue = options.instanceId ?? newInstanceId();
    this.now = options.now ?? systemClock;
    this.leases = new LeaseKeeper({
      store: options.store,
      instanceId: this.instanceIdValue,
      now: this.now,
      leaseTtlMs: options.leaseTtlMs ?? DEFAULTS.leaseTtlMs,
      renewIntervalMs: options.renewIntervalMs ?? DEFAULTS.renewIntervalMs,
      safetyMarginMs: options.safetyMarginMs ?? DEFAULTS.safetyMarginMs,
      onLeaseLost: (jobId, reason) => {
        this.emit({ kind: 'lease-lost', jobId, reason });
      },
      onError: (error, context) => {
        this.emit({
          kind: 'error',
          context,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    });

    this.scheduler =
      options.driver === undefined
        ? undefined
        : new JobScheduler({
            store: options.store,
            leases: this.leases,
            instanceId: this.instanceIdValue,
            now: this.now,
            driver: options.driver,
            leaseTtlMs: options.leaseTtlMs ?? DEFAULTS.leaseTtlMs,
            tickIntervalMs: options.tickIntervalMs ?? DEFAULTS.tickIntervalMs,
            ...(options.maxJobs === undefined ? {} : { maxJobs: options.maxJobs }),
            onEvent: (event) => {
              this.emit({ kind: 'scheduler', event });
            },
          });
  }

  get instanceId(): string {
    return this.instanceIdValue;
  }

  /**
   * Whether this process is advancing jobs *right now*.
   *
   * Read from the scheduler rather than from the constructor argument: between
   * `stop` and the next `start` a daemon that was configured to drive is not
   * driving, and a client that read a configured flag would be told a strategy
   * is running while the loop is stopped.
   */
  get driving(): boolean {
    return this.scheduler?.started ?? false;
  }

  /**
   * Advance every held job by one pass, now, without waiting for a tick.
   *
   * For a caller that wants a deterministic Runner — a test, or a one-shot
   * "catch up" — and it is the same guarded tick the timer calls, so invoking it
   * beside a running loop joins the pass in flight rather than starting a second.
   * Absent a `driver` there is nothing to run, and this says so rather than
   * silently succeeding.
   */
  async tick(): Promise<SchedulerTickReport> {
    if (this.scheduler === undefined) {
      throw new Error(
        'this Runner was started without a driver: it holds leases and answers, but nothing advances a job',
      );
    }
    return await this.scheduler.tick();
  }

  get socketPath(): string {
    return join(this.options.runtimeDir, 'runner.sock');
  }

  get tokenPath(): string {
    return join(this.options.runtimeDir, 'runner.token');
  }

  async start(): Promise<RunnerDaemonHandle> {
    const at = this.now();
    this.startedAt = at;

    // Before the store, before the socket: if this cannot be proved, nothing else
    // about the trust boundary holds.
    ensureRuntimeDir(this.options.runtimeDir);

    await this.options.store.registerInstance({
      instanceId: this.instanceIdValue,
      pid: process.pid,
      host: hostname(),
      at,
    });

    const report = await recoverJobs({
      store: this.options.store,
      instanceId: this.instanceIdValue,
      at,
      leaseTtlMs: this.options.leaseTtlMs ?? DEFAULTS.leaseTtlMs,
      staleAfterMs: this.options.staleAfterMs ?? DEFAULTS.staleAfterMs,
    });
    this.recovery = report;
    for (const recovered of report.jobs) {
      if (recovered.lease !== undefined) this.leases.hold(recovered.lease);
    }
    this.emit({ kind: 'recovered', report });

    this.leases.start();
    // After the keeper, before the socket. A pass must never run for a lease
    // nothing is renewing, and a client must never reach a Runner that has begun
    // driving before it could be told what state its jobs are in.
    this.scheduler?.start();

    const token = mintIpcToken();
    // Rewritten every start: a token a crashed Runner left behind must stop
    // working the moment a new one takes over.
    writeIpcToken(this.tokenPath, token);

    const server = new RunnerIpcServer({
      socketPath: this.socketPath,
      token,
      instanceId: this.instanceIdValue,
      driving: this.driving,
      handle: async (command, input) => dispatch(command, input, this.context()),
      toErrorBody,
      ...(this.options.authTimeoutMs === undefined
        ? {}
        : { authTimeoutMs: this.options.authTimeoutMs }),
      onError: (error, context) => {
        this.emit({
          kind: 'error',
          context,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    });
    try {
      await server.start();
    } catch (error) {
      // The socket is the last thing to come up, so a failure here leaves a
      // registered instance holding leases nobody can reach — and, worse, a
      // scheduler placing orders for a Runner nobody can inspect or cancel
      // through. Undo both rather than leaving a half-started Runner that looks
      // alive to the next one.
      await this.scheduler?.stop();
      await this.leases.stop();
      await this.options.store.stopInstance(this.instanceIdValue, this.now());
      throw error;
    }
    this.server = server;

    this.emit({ kind: 'started', instanceId: this.instanceIdValue, socketPath: this.socketPath });

    return {
      instanceId: this.instanceIdValue,
      socketPath: this.socketPath,
      tokenPath: this.tokenPath,
      token,
      recovery: report,
      driving: this.driving,
    };
  }

  async stop(): Promise<void> {
    this.stopping ??= this.doStop();
    return this.stopping;
  }

  /** The last recovery report, for a caller that wants it without an IPC round trip. */
  lastRecovery(): RecoveryReport | undefined {
    return this.recovery;
  }

  private async doStop(): Promise<void> {
    if (this.shutdownTimer !== undefined) {
      clearTimeout(this.shutdownTimer);
      this.shutdownTimer = undefined;
    }
    await this.server?.stop();
    this.server = undefined;
    // The loop before the leases, and awaited: a pass in flight owns a lease it
    // is writing under, and handing that lease back underneath it would be this
    // process fencing itself out mid-order.
    await this.scheduler?.stop();
    // Leases first, then the instance: `stopInstance` also clears this
    // instance's leases, but going through the keeper is what aborts anything
    // still holding a `HeldLease.signal`.
    await this.leases.stop();
    await this.options.store.stopInstance(this.instanceIdValue, this.now());
    this.emit({ kind: 'stopped', instanceId: this.instanceIdValue });
  }

  private context(): RunnerCommandContext {
    return {
      store: this.options.store,
      instanceId: this.instanceIdValue,
      pid: process.pid,
      host: hostname(),
      startedAt: this.startedAt ?? this.now(),
      now: this.now,
      leases: this.leases,
      driving: this.driving,
      // Empty only when a loop is actually ticking. This is read only while the
      // socket is up, and the socket's lifetime sits strictly inside the
      // scheduler's, so `driving` false here means no driver was ever supplied —
      // which is exactly the list below.
      driverGaps: this.driving ? [] : RUNNER_DRIVER_GAPS,
      recovery: this.recovery,
      requestShutdown: (reason) => {
        this.emit({ kind: 'shutdown-requested', reason });
        // Deferred by a tick so the reply is written before the socket closes.
        // A client that asked for a shutdown and got a dropped connection could
        // not tell it from a Runner that crashed on the request.
        const timer = setTimeout(() => {
          void this.stop();
        }, 0);
        timer.unref();
        this.shutdownTimer = timer;
      },
    };
  }

  private emit(event: RunnerDaemonEvent): void {
    this.options.onEvent?.(event);
  }
}

/**
 * Wires process signals to a clean stop.
 *
 * Separate from the daemon and taking the emitter as an argument so it can be
 * tested without signalling a real process. `SIGINT` and `SIGTERM` are the two
 * that arrive from a terminal and from a service manager; `SIGKILL` cannot be
 * handled, which is exactly why the store is arranged to survive it.
 */
export const installShutdownHandlers = (
  daemon: Pick<RunnerDaemon, 'stop'>,
  emitter: Pick<NodeJS.Process, 'once'> = process,
): void => {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    emitter.once(signal, () => {
      void daemon.stop();
    });
  }
};
