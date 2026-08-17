/**
 * The store interface (ADR-0001 §8).
 *
 * SQLite/WAL is the local implementation; the interface exists so a managed
 * Runner could put the same semantics on an existing transactional database
 * without the daemon learning a second set of rules.
 *
 * Two shape decisions matter:
 *
 * - **Every method is one transaction, and no transaction is exposed.** There is
 *   no `begin()`/`commit()` a caller could leave open across an `await` — a
 *   half-applied "persist the key, then mark the state" is precisely the crash
 *   the store exists to survive, so it is unrepresentable rather than discouraged.
 * - **Every mutating job method takes a `JobLease`.** Writing without a claim is
 *   not a convenience, it is the duplicate-Runner failure, so it has no API.
 */
import type {
  JobLeg,
  JobLegIntent,
  JobLegStatus,
  JobLease,
  JobPolicySnapshot,
  JobRecord,
  JobTransitionRecord,
  JobTrigger,
  RunnerInstance,
  SideEffectAttempt,
  SideEffectKind,
  SideEffectOutcome,
} from './job.ts';
import type { JobState } from './state-machine.ts';

export interface RegisterInstanceInput {
  readonly instanceId: string;
  readonly pid: number;
  readonly host: string;
  readonly at: string;
}

export interface CreateJobInput {
  readonly jobId: string;
  readonly strategyId: string;
  readonly ownerAddress: string;
  readonly accountId: string;
  readonly agentWallet: string;
  readonly intent: readonly JobLegIntent[];
  readonly trigger: JobTrigger;
  readonly policy: JobPolicySnapshot;
  readonly expiresAt: string;
  readonly at: string;
}

export interface ClaimJobInput {
  readonly jobId: string;
  readonly instanceId: string;
  readonly at: string;
  readonly leaseTtlMs: number;
}

export interface TransitionInput {
  readonly lease: JobLease;
  readonly to: JobState;
  /** Why, in a form an audit can read. Required: an unexplained edge is noise. */
  readonly reason: string;
  readonly at: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface ReserveLegInput {
  readonly lease: JobLease;
  readonly legIndex: number;
  readonly idempotencyKey: string;
  readonly intent: JobLegIntent;
  readonly at: string;
}

/** The fields of a leg a Runner learns as an order progresses. */
export interface LegPatch {
  readonly status?: JobLegStatus;
  readonly referenceQuoteId?: string;
  readonly submissionQuoteId?: string;
  readonly quotedAt?: string;
  readonly executionId?: string;
  readonly submissionDigest?: string;
  readonly keeperDigest?: string;
}

export interface UpdateLegInput extends LegPatch {
  readonly lease: JobLease;
  readonly legIndex: number;
  readonly at: string;
}

export interface BeginSideEffectInput {
  readonly lease: JobLease;
  readonly attemptId: string;
  readonly legIndex: number;
  readonly kind: SideEffectKind;
  /**
   * A digest of the exact request bytes. The store never sees the bytes; it only
   * enforces that a replay presents the same digest.
   */
  readonly requestFingerprint: string;
  readonly at: string;
}

export interface CompleteSideEffectInput {
  readonly lease: JobLease;
  readonly attemptId: string;
  readonly outcome: SideEffectOutcome;
  readonly at: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  /**
   * Applied in the SAME transaction that resolves the attempt.
   *
   * This is not a convenience. Recovery reads "no open attempt and no execution
   * id" as "nothing was ever sent" and re-arms the job; if resolving the attempt
   * and recording the execution id it returned were two transactions, a crash
   * between them would make a created order look like an order that never
   * happened, and the job would go on to create a second one.
   */
  readonly leg?: LegPatch;
}

export interface JobFilter {
  readonly states?: readonly JobState[];
  readonly accountId?: string;
  /**
   * One strategy's jobs. A strategy is the unit a caller named and can cancel;
   * the job is the unit this store runs, and today they are one to one.
   */
  readonly strategyId?: string;
  /** Only jobs whose lease is absent or expired as of this instant. */
  readonly unleasedAt?: string;
}

/**
 * A durable, transactional job store.
 *
 * Methods are async so a non-embedded implementation is possible. The SQLite one
 * is synchronous underneath and resolves immediately; that is why no method
 * spans two round trips.
 */
export interface JobStore {
  /** Identifies the backing engine, for `runner status` and for tests. */
  readonly kind: string;

  registerInstance(input: RegisterInstanceInput): Promise<RunnerInstance>;
  heartbeat(instanceId: string, at: string): Promise<RunnerInstance>;
  stopInstance(instanceId: string, at: string): Promise<void>;
  listInstances(): Promise<readonly RunnerInstance[]>;

  createJob(input: CreateJobInput): Promise<JobRecord>;
  getJob(jobId: string): Promise<JobRecord | undefined>;
  listJobs(filter?: JobFilter): Promise<readonly JobRecord[]>;
  /**
   * Records a cancellation request. It is not a transition: only the instance
   * holding the lease may end a job, and only from a state that has not started
   * a write (ADR-0001 §15). A job nobody is running keeps the request until a
   * Runner claims it, which is the honest outcome when nothing is monitoring it.
   */
  requestCancel(jobId: string, reason: string, at: string): Promise<JobRecord>;

  /** Returns `undefined` when a live lease is held by another instance. */
  claimJob(input: ClaimJobInput): Promise<JobLease | undefined>;
  renewLease(lease: JobLease, at: string, leaseTtlMs: number): Promise<JobLease>;
  releaseJob(lease: JobLease, at: string): Promise<void>;

  transition(input: TransitionInput): Promise<JobRecord>;
  listTransitions(jobId: string): Promise<readonly JobTransitionRecord[]>;

  reserveLeg(input: ReserveLegInput): Promise<JobLeg>;
  listLegs(jobId: string): Promise<readonly JobLeg[]>;
  updateLeg(input: UpdateLegInput): Promise<JobLeg>;

  beginSideEffect(input: BeginSideEffectInput): Promise<SideEffectAttempt>;
  completeSideEffect(input: CompleteSideEffectInput): Promise<SideEffectAttempt>;
  /** Attempts with no outcome: what a crash left behind. */
  listOpenSideEffects(jobId?: string): Promise<readonly SideEffectAttempt[]>;
  listSideEffects(jobId: string): Promise<readonly SideEffectAttempt[]>;

  /**
   * Persists a stream resume point. Monotonic: a rewind is refused, because a
   * cursor that moved backwards asks the next reconnect for a window the server
   * no longer has.
   */
  saveCursor(scope: string, cursor: string, at: string): Promise<string>;
  readCursor(scope: string): Promise<string | undefined>;

  close(): Promise<void>;
}
