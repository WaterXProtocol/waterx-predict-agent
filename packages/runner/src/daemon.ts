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
 * **This daemon does not drive jobs.** There is no executor, no signer and no
 * reconciler yet, so a recovered job sits in the state recovery assigned it. That
 * is reported as `driving: false` on the IPC handshake and in `runner.status`,
 * because a reachable Runner that isn't executing looks exactly like one that is
 * until you ask.
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
import type { JobStore } from './store.ts';
import { LeaseKeeper, type LeaseLossReason } from './supervisor.ts';

/** The pieces that would make a job progress, and do not exist yet. */
export const RUNNER_DRIVER_GAPS: readonly string[] = [
  'executor',
  'signer',
  'reconciler',
  'price-watcher',
];

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
  /** Diagnostics. Never given a token, a signature or transaction bytes. */
  readonly onEvent?: (event: RunnerDaemonEvent) => void;
}

export type RunnerDaemonEvent =
  | { readonly kind: 'started'; readonly instanceId: string; readonly socketPath: string }
  | { readonly kind: 'recovered'; readonly report: RecoveryReport }
  | { readonly kind: 'lease-lost'; readonly jobId: string; readonly reason: LeaseLossReason }
  | { readonly kind: 'shutdown-requested'; readonly reason: string }
  | { readonly kind: 'stopped'; readonly instanceId: string }
  | { readonly kind: 'error'; readonly context: string; readonly message: string };

const DEFAULTS = {
  leaseTtlMs: 30_000,
  renewIntervalMs: 5_000,
  safetyMarginMs: 10_000,
  staleAfterMs: 60_000,
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
}

export class RunnerDaemon {
  private readonly instanceIdValue: string;
  private readonly now: Clock;
  private readonly leases: LeaseKeeper;
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
  }

  get instanceId(): string {
    return this.instanceIdValue;
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

    const token = mintIpcToken();
    // Rewritten every start: a token a crashed Runner left behind must stop
    // working the moment a new one takes over.
    writeIpcToken(this.tokenPath, token);

    const server = new RunnerIpcServer({
      socketPath: this.socketPath,
      token,
      instanceId: this.instanceIdValue,
      driving: false,
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
      // registered instance holding leases nobody can reach. Undo it rather than
      // leaving a half-started Runner that looks alive to the next one.
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
      driving: false,
      driverGaps: RUNNER_DRIVER_GAPS,
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
