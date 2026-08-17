/**
 * The loop. The thing that turns a claimed job into a job that is actually
 * running.
 *
 * `driveJob` advances one job by one pass and returns; `recoverJobs` decides what
 * the last process left behind; `LeaseKeeper` proves this instance still owns
 * what it is writing for. None of them runs on its own. This module is the only
 * place in the package that calls the driver on a schedule, and starting one is
 * the difference between a Runner that is *reachable* and a Runner that is
 * *running* (ADR-0001 §6) — which is why the daemon reports `driving` from
 * whether one of these exists rather than from a constant.
 *
 * Four properties are load-bearing, and each one is a way a scheduler places an
 * order twice.
 *
 * 1. **A tick never overlaps itself.** {@link JobScheduler.tick} is guarded: a
 *    call that arrives while one is in flight *joins* it. Without that, a tick
 *    interval shorter than a slow pass would put two passes on one job
 *    concurrently — both would read `WATCHING`, both would reserve, and the
 *    second would mint a key for an intent that already had one.
 * 2. **One pass per job per tick, in sequence.** Not for the store's sake — it is
 *    a single writer already — but because the bound on how many orders a Runner
 *    can have in flight should be a number someone chose, not however many jobs
 *    happened to trigger in the same second.
 * 3. **A lease that was lost stops the job before the pass, not during it.** The
 *    keeper aborts a job's signal the instant this instance may no longer write
 *    for it; a pass is skipped outright if that already happened, and the signal
 *    is handed to `driveJob` so one that happens mid-pass aborts the request.
 * 4. **A failing job cannot stop the others.** A pass that throws is recorded
 *    against its job and the loop carries on. The alternative — one bad job
 *    silently ending the loop — is the failure mode where every *other* strategy
 *    stops watching and nothing says so.
 *
 * What this module does not do: decide anything about an order. It chooses when
 * `driveJob` runs and which jobs it runs for. Every question about what a pass
 * may send, and every terminal state, belongs to the driver and the reconciler.
 */
import type { Clock } from './clock.ts';
import { isJobStoreError } from './errors.ts';
import { isTerminalJobState, NON_TERMINAL_JOB_STATES, type JobState } from './state-machine.ts';
import type { JobStore } from './store.ts';
import { driveJob, type DriveResult } from './strategy/driver.ts';
import type { PriceObserver, StrategyGateway, StrategySigner } from './strategy/gateway.ts';
import type { LeaseKeeper } from './supervisor.ts';

/**
 * The three collaborators a pass cannot be made without.
 *
 * Supplied together, and only together: a scheduler holding two of them would be
 * a loop that watches prices it can never act on, or one that signs for a trigger
 * it can never observe. The daemon treats the presence of this object as the
 * decision that this process drives.
 */
export interface SchedulerDriver {
  readonly gateway: StrategyGateway;
  /** Inside the Runner trust boundary. Never handed to a model or a subprocess. */
  readonly signer: StrategySigner;
  readonly prices: PriceObserver;
}

export interface JobSchedulerOptions {
  readonly store: JobStore;
  readonly leases: LeaseKeeper;
  readonly instanceId: string;
  readonly now: Clock;
  readonly driver: SchedulerDriver;
  readonly leaseTtlMs: number;
  /** How often a tick runs. A pass costs reads, so this is also the read bill. */
  readonly tickIntervalMs: number;
  /**
   * The most jobs this instance will hold at once. A bound, not a queue: jobs
   * over it are left unclaimed for another Runner and counted in the tick report
   * rather than dropped quietly.
   */
  readonly maxJobs?: number;
  /** Diagnostics. Never given a signature, transaction bytes or a token. */
  readonly onEvent?: (event: SchedulerEvent) => void;
}

export type SchedulerEvent =
  /** This instance took responsibility for a job nobody was running. */
  | { readonly kind: 'claimed'; readonly jobId: string }
  /** A pass ran. The result is the driver's, verbatim. */
  | { readonly kind: 'pass'; readonly result: DriveResult }
  /** The job ended. Its lease was cleared by the terminal transition itself. */
  | { readonly kind: 'released'; readonly jobId: string; readonly state: JobState }
  /**
   * Runnable jobs this instance declined to claim because it is at `maxJobs`.
   * Emitted rather than inferred: a capacity bound that says nothing looks
   * exactly like a store with fewer jobs in it.
   */
  | { readonly kind: 'at-capacity'; readonly held: number; readonly deferred: number }
  | {
      readonly kind: 'error';
      readonly jobId?: string;
      readonly context: string;
      readonly message: string;
    };

/** What one tick did. Returned so a caller can assert on it without a clock. */
export interface SchedulerTickReport {
  readonly at: string;
  readonly claimed: readonly string[];
  readonly passes: readonly DriveResult[];
  readonly released: readonly string[];
  /** A pass that threw, by job. The loop continued past every one of these. */
  readonly failures: readonly { readonly jobId: string; readonly message: string }[];
  /** Runnable and unclaimed, because this instance is at `maxJobs`. */
  readonly deferred: number;
  /** True when this call joined a tick already in flight rather than running one. */
  readonly joined?: boolean;
}

const DEFAULT_MAX_JOBS = 64;

export class JobScheduler {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<SchedulerTickReport> | undefined;
  private stopped = false;

  constructor(private readonly options: JobSchedulerOptions) {}

  /** Whether the interval is live. This is what `driving` means to a client. */
  get started(): boolean {
    return this.timer !== undefined;
  }

  start(): void {
    if (this.timer !== undefined || this.stopped) return;
    const timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, this.options.tickIntervalMs);
    // The Runner's lifetime is its socket's and its signal handlers'. A tick
    // timer must never be the reason the process stays up after `stop`.
    timer.unref();
    this.timer = timer;
  }

  /**
   * Stops ticking and waits for the pass in flight.
   *
   * The wait is the point. A `SIGKILL` mid-create is survivable by design, but a
   * *clean* shutdown that abandoned a half-finished pass would manufacture the
   * ambiguity the store exists to recover from, on purpose, every time the
   * operator pressed Ctrl-C.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    try {
      await this.inFlight;
    } catch {
      // A failed final tick has already been reported through `onEvent`; a stop
      // must complete regardless of how the last pass ended.
    }
  }

  /**
   * One round: claim what nobody is running, then advance everything held.
   *
   * Public so a test — or a one-shot `runner tick` — can drive the Runner
   * deterministically with no timer at all. Two concurrent callers get one tick:
   * the second joins the first rather than starting a second pass over the same
   * jobs.
   */
  async tick(): Promise<SchedulerTickReport> {
    if (this.inFlight !== undefined) {
      const joined = await this.inFlight;
      return { ...joined, joined: true };
    }
    const running = this.runTick();
    this.inFlight = running;
    try {
      return await running;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async runTick(): Promise<SchedulerTickReport> {
    const at = this.options.now();
    const { claimed, deferred } = await this.claim(at);

    const passes: DriveResult[] = [];
    const released: string[] = [];
    const failures: { jobId: string; message: string }[] = [];

    for (const jobId of this.options.leases.held()) {
      const outcome = await this.pass(jobId);
      if (outcome === undefined) continue;
      if ('message' in outcome) {
        failures.push({ jobId, message: outcome.message });
        continue;
      }
      passes.push(outcome.result);
      if (isTerminalJobState(outcome.result.to)) {
        // The terminal transition cleared the lease inside its own transaction,
        // so the keeper must *forget* it rather than hand back a lease the store
        // no longer records — `release` would fail `LEASE_LOST` against a lease
        // that was correctly given up.
        this.options.leases.forget(jobId, 'RELEASED');
        released.push(jobId);
        this.emit({ kind: 'released', jobId, state: outcome.result.to });
      }
    }

    return {
      at,
      claimed,
      passes,
      released,
      failures,
      deferred,
    };
  }

  /**
   * Take responsibility for runnable jobs nobody is running.
   *
   * Start-up recovery claims everything that existed then; this covers what
   * appears afterwards — a strategy created by another process against the same
   * store, and a job whose previous owner died between recoveries. `claimJob`
   * answers `undefined` when a live lease is held elsewhere, which is a normal
   * outcome with two Runners up and is not an error.
   */
  private async claim(at: string): Promise<{ claimed: readonly string[]; deferred: number }> {
    const maxJobs = this.options.maxJobs ?? DEFAULT_MAX_JOBS;
    const held = this.options.leases.held().length;
    let room = maxJobs - held;

    let candidates: readonly { readonly jobId: string }[];
    try {
      candidates = await this.options.store.listJobs({
        states: NON_TERMINAL_JOB_STATES,
        unleasedAt: at,
      });
    } catch (error) {
      this.emit({ kind: 'error', context: 'list-claimable', message: describe(error) });
      return { claimed: [], deferred: 0 };
    }

    const claimable = candidates.filter((job) => !this.options.leases.isHeld(job.jobId));
    const claimed: string[] = [];
    let deferred = 0;
    for (const job of claimable) {
      if (room <= 0) {
        deferred += 1;
        continue;
      }
      try {
        const lease = await this.options.store.claimJob({
          jobId: job.jobId,
          instanceId: this.options.instanceId,
          at,
          leaseTtlMs: this.options.leaseTtlMs,
        });
        // `undefined` means another live Runner owns it. Expected, not a failure.
        if (lease === undefined) continue;
        this.options.leases.hold(lease);
        room -= 1;
        claimed.push(job.jobId);
        this.emit({ kind: 'claimed', jobId: job.jobId });
      } catch (error) {
        this.emit({ kind: 'error', jobId: job.jobId, context: 'claim', message: describe(error) });
      }
    }
    if (deferred > 0) this.emit({ kind: 'at-capacity', held, deferred });
    return { claimed, deferred };
  }

  /**
   * One job, one pass.
   *
   * `undefined` means the pass was skipped — this instance no longer holds the
   * job. The clock is read here rather than once per tick: a tick that spends a
   * second on its first job must not stamp the second job's expiry check with an
   * instant from before that second elapsed.
   */
  private async pass(
    jobId: string,
  ): Promise<{ result: DriveResult } | { message: string } | undefined> {
    const lease = this.options.leases.lease(jobId);
    if (lease === undefined) return undefined;
    const held = this.options.leases.hold(lease);
    // Fenced out, unrenewable, or shutting down. The store would refuse the
    // writes anyway; refusing to start the pass means no read is paid for either.
    if (held.signal.aborted) return undefined;

    try {
      const result = await driveJob({
        store: this.options.store,
        gateway: this.options.driver.gateway,
        signer: this.options.driver.signer,
        prices: this.options.driver.prices,
        lease: held.current(),
        at: this.options.now(),
        signal: held.signal,
      });
      this.emit({ kind: 'pass', result });
      return { result };
    } catch (error) {
      if (isJobStoreError(error) && error.code === 'LEASE_LOST') {
        // Another Runner owns this job now. Stop holding it locally so the next
        // tick does not pay for a pass that can only fail the same way.
        this.options.leases.forget(jobId, 'LEASE_LOST');
      }
      const message = describe(error);
      this.emit({ kind: 'error', jobId, context: 'drive', message });
      return { message };
    }
  }

  private emit(event: SchedulerEvent): void {
    this.options.onEvent?.(event);
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
