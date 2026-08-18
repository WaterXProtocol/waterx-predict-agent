/**
 * Draining: refusing new work while finishing what is already in flight.
 *
 * `runner.shutdown` stops the process cleanly — it closes the socket, then awaits
 * the pass in flight before handing back the leases that pass is writing under.
 * That is a correct *stop*, and ADR-0009 forbids calling it a drain, because it
 * is missing the first step of the sequence an upgrade needs:
 *
 *     refuse new admission → let in-flight work reach a terminal or safely
 *     resumable state → persist → exit
 *
 * Without that first step, a `strategy create` arriving during a planned upgrade
 * meets a closed socket and fails on a dropped connection, which is
 * indistinguishable from a Runner that crashed. With it, the caller is told the
 * Runner is draining and that the strategy was not armed — a fact it can act on.
 *
 * ## What a drain waits for, and what it deliberately does not
 *
 * The tempting definition is "wait until no job is non-terminal". It is wrong,
 * and wrong in the direction that makes the feature useless: a `WATCHING`
 * strategy with a seven-day expiry is non-terminal for seven days, so a drain
 * defined that way *always* ends by crossing its deadline, and an operator learns
 * to ignore the one signal that was supposed to mean something.
 *
 * ADR-0009 says "terminal **or safely resumable**", and the distinction is
 * already recorded in the store. A job sitting in `WATCHING` is safely resumable
 * right now: everything the next process needs is persisted, and recovery adopts
 * it without ambiguity. A job with an **open side-effect attempt** is not — it has
 * a request that may or may not have reached the server, and stopping there is
 * precisely how a job becomes `UNKNOWN_PENDING`. So that, and only that, is what
 * a drain waits on.
 *
 * ## Whose in-flight work
 *
 * Only this instance's. An open attempt inherited from a dead predecessor is
 * already ambiguous — nothing this process does or does not do makes it more so —
 * and one of them, the create-phase case, is unresolvable against the current API
 * (backlog B9) and would block every drain forever. Waiting on those would
 * convert "the deadline means something" back into "the deadline always fires".
 * They are reported as `inherited` instead, so nothing is hidden; they are simply
 * not something this process can settle by staying alive.
 *
 * ## One way only
 *
 * There is no `undrain`. Admission is refused for the life of the process, and
 * the way to admit again is to start a Runner — which is the operation a drain
 * exists to prepare for. Re-opening admission would let an operator resume a
 * process they had already decided to replace, and would leave a client that was
 * told `RUNNER_DRAINING` holding an answer that had quietly stopped being true.
 *
 * ## Draining does not exit
 *
 * A drain that shut the process down on its own would kill it mid-write on
 * exactly the runs where the deadline was exceeded — the runs where something was
 * still settling. That is the failure this whole module exists to avoid, so the
 * two steps stay two commands: `runner.drain` settles and reports,
 * `runner.shutdown` exits. `docs/RELEASE.md` documents the pair as the upgrade
 * sequence.
 */
import type { Clock } from './clock.ts';
import type { SideEffectAttempt } from './job.ts';
import { NON_TERMINAL_JOB_STATES } from './state-machine.ts';
import type { JobStore } from './store.ts';
import type { LeaseKeeper } from './supervisor.ts';

/** A request this instance sent, or may have sent, and has not yet resolved. */
export interface DrainAttempt {
  readonly attemptId: string;
  readonly jobId: string;
  readonly legIndex: number;
  readonly kind: SideEffectAttempt['kind'];
  readonly startedAt: string;
}

export interface DrainReport {
  readonly instanceId: string;
  /** When admission was first refused. Stable across repeated calls. */
  readonly beganAt: string;
  readonly at: string;
  /** Always false once a drain has started; there is no way back. */
  readonly admitting: false;
  /** Whether a loop is still ticking. A drain on a Runner that never drove settles at once. */
  readonly driving: boolean;
  /** True only when this instance has nothing left in flight. */
  readonly settled: boolean;
  readonly deadlineMs: number;
  readonly deadlineAt: string;
  /**
   * True when the wait ended because time ran out rather than because everything
   * settled. Reported, never silently crossed: an operator who shuts down now is
   * choosing to create the ambiguity, and has to be able to see that.
   */
  readonly deadlineExceeded: boolean;
  readonly waitedMs: number;
  /** Jobs this instance holds a lease on. Informational: holding one does not block. */
  readonly held: readonly string[];
  /** What this drain is waiting on. Empty means settled. */
  readonly settling: readonly DrainAttempt[];
  /**
   * Open attempts belonging to some other instance. Never waited on — see the
   * header — and surfaced so a drain that settled cannot be read as a store with
   * nothing unresolved in it.
   */
  readonly inherited: readonly DrainAttempt[];
  /**
   * Non-terminal jobs store-wide. Purely informational, and expected to be
   * non-zero on a healthy drain: a watching strategy is safely resumable, and the
   * next Runner adopts it.
   */
  readonly nonTerminal: number;
  /** True when this call joined a drain already in progress rather than starting one. */
  readonly joined?: boolean;
}

export interface DrainOptions {
  /** How long to wait for this instance's own work to settle. */
  readonly deadlineMs?: number;
  readonly pollIntervalMs?: number;
}

export interface DrainControllerOptions {
  readonly store: JobStore;
  readonly leases: LeaseKeeper;
  readonly instanceId: string;
  readonly now: Clock;
  /** Read live, because a scheduler stopping mid-drain changes the answer. */
  readonly driving: () => boolean;
  /**
   * Advance held jobs one pass, if anything drives.
   *
   * A drain calls this rather than waiting out the tick interval, so it converges
   * as fast as the passes allow instead of as fast as the timer. `JobScheduler.tick`
   * is guarded — a call arriving during a pass joins it — so this cannot put two
   * passes on one job.
   */
  readonly tick?: () => Promise<unknown>;
  /** Injectable so a test settles a drain without real time passing. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export const DRAIN_DEFAULTS = {
  deadlineMs: 30_000,
  pollIntervalMs: 250,
} as const;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // A drain must never be the reason the process outlives its own shutdown.
    timer.unref?.();
  });

const toAttempt = (attempt: SideEffectAttempt): DrainAttempt => ({
  attemptId: attempt.attemptId,
  jobId: attempt.jobId,
  legIndex: attempt.legIndex,
  kind: attempt.kind,
  startedAt: attempt.startedAt,
});

export class DrainController {
  private beganAtValue: string | undefined;
  private inFlight: Promise<DrainReport> | undefined;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: DrainControllerOptions) {
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Whether this Runner still takes new work.
   *
   * Consulted by the scheduler before it claims and by the dispatcher before it
   * arms a strategy. Those are the two doors: one lets a job in from the store,
   * the other from a socket peer, and a drain that closed only one of them would
   * keep finding new work to do.
   */
  get admitting(): boolean {
    return this.beganAtValue === undefined;
  }

  get beganAt(): string | undefined {
    return this.beganAtValue;
  }

  /** The shape `runner.status` reports. `null` while admission is open. */
  async state(): Promise<unknown> {
    if (this.beganAtValue === undefined) return null;
    const snapshot = await this.snapshot();
    return {
      beganAt: this.beganAtValue,
      settled: snapshot.settling.length === 0,
      settling: snapshot.settling.length,
      inherited: snapshot.inherited.length,
    };
  }

  /**
   * Refuse admission, then wait for this instance's in-flight work.
   *
   * Idempotent by joining: a second caller during a drain gets the first one's
   * report rather than starting a second wait with its own deadline. The refusal
   * takes effect on the first call, before any awaiting, so a `strategy.create`
   * racing this one is refused rather than admitted into a process that is
   * leaving.
   */
  async drain(options: DrainOptions = {}): Promise<DrainReport> {
    this.beganAtValue ??= this.options.now();
    if (this.inFlight !== undefined) {
      return { ...(await this.inFlight), joined: true };
    }
    const running = this.runDrain(options);
    this.inFlight = running;
    try {
      return await running;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async runDrain(options: DrainOptions): Promise<DrainReport> {
    const deadlineMs = options.deadlineMs ?? DRAIN_DEFAULTS.deadlineMs;
    const pollIntervalMs = options.pollIntervalMs ?? DRAIN_DEFAULTS.pollIntervalMs;
    const beganAt = this.beganAtValue ?? this.options.now();
    const startedMs = Date.parse(this.options.now());
    const deadlineAt = new Date(startedMs + deadlineMs).toISOString();

    for (;;) {
      const snapshot = await this.snapshot();
      const at = this.options.now();
      const waitedMs = Math.max(0, Date.parse(at) - startedMs);

      if (snapshot.settling.length === 0) {
        return this.report({ beganAt, at, deadlineMs, deadlineAt, waitedMs, snapshot, settled: true });
      }
      if (waitedMs >= deadlineMs) {
        return this.report({
          beganAt,
          at,
          deadlineMs,
          deadlineAt,
          waitedMs,
          snapshot,
          settled: false,
        });
      }

      // Drive rather than wait for the interval. Guarded upstream, so a pass
      // already running is joined instead of doubled.
      if (this.options.tick !== undefined) {
        try {
          await this.options.tick();
        } catch {
          // A failed pass is reported through the scheduler's own events, and a
          // drain must keep converging: the job it failed on is exactly the one
          // whose open attempt this loop is still waiting to see resolved.
        }
      }
      await this.sleep(pollIntervalMs);
    }
  }

  private async snapshot(): Promise<{
    readonly held: readonly string[];
    readonly settling: readonly DrainAttempt[];
    readonly inherited: readonly DrainAttempt[];
    readonly nonTerminal: number;
  }> {
    const [open, nonTerminal] = await Promise.all([
      this.options.store.listOpenSideEffects(),
      this.options.store.listJobs({ states: NON_TERMINAL_JOB_STATES }),
    ]);
    const mine: DrainAttempt[] = [];
    const theirs: DrainAttempt[] = [];
    for (const attempt of open) {
      (attempt.instanceId === this.options.instanceId ? mine : theirs).push(toAttempt(attempt));
    }
    return {
      held: this.options.leases.held(),
      settling: mine,
      inherited: theirs,
      nonTerminal: nonTerminal.length,
    };
  }

  private report(input: {
    readonly beganAt: string;
    readonly at: string;
    readonly deadlineMs: number;
    readonly deadlineAt: string;
    readonly waitedMs: number;
    readonly settled: boolean;
    readonly snapshot: {
      readonly held: readonly string[];
      readonly settling: readonly DrainAttempt[];
      readonly inherited: readonly DrainAttempt[];
      readonly nonTerminal: number;
    };
  }): DrainReport {
    return {
      instanceId: this.options.instanceId,
      beganAt: input.beganAt,
      at: input.at,
      admitting: false,
      driving: this.options.driving(),
      settled: input.settled,
      deadlineMs: input.deadlineMs,
      deadlineAt: input.deadlineAt,
      deadlineExceeded: !input.settled,
      waitedMs: input.waitedMs,
      held: input.snapshot.held,
      settling: input.snapshot.settling,
      inherited: input.snapshot.inherited,
      nonTerminal: input.snapshot.nonTerminal,
    };
  }
}
