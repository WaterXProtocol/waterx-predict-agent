/**
 * Resolving a job that stopped being sure, by reading the server rather than
 * guessing.
 *
 * `recovery.ts` decides *that* a job is unresolved. This module is the only thing
 * that may decide *what actually happened*, and it does so from one source: an
 * authoritative REST read of an execution the Runner can name. Nothing here
 * infers an outcome from a timeout, a status code, a clock, or the absence of a
 * record.
 *
 * The state machine already encodes the three ways out, and this module is their
 * implementation:
 *
 * - `UNKNOWN_PENDING → RECONCILING` is the single exit from not knowing. It is
 *   taken *before* the read, so a crash mid-read leaves a job in the state that
 *   describes what is happening rather than one that has forgotten.
 * - `RECONCILING → FILLED | FAILED | CANCELLED | EXPIRED` admits a terminal fact,
 *   and only ever one the server reported. `REJECTED` becomes `FAILED` because
 *   WaterX decided it; `CANCELLED` stays `CANCELLED` because the chain did.
 * - `RECONCILING → UNKNOWN_PENDING` is the honest retreat. A reconcile that could
 *   not establish anything puts the job back, rather than downgrading "I cannot
 *   tell" into "nothing happened".
 *
 * A non-terminal read is not a retreat and not a result: `SUBMITTED` and
 * `PENDING_FILL` mean an order exists and a keeper may still fill it, so the job
 * stays in `RECONCILING` and is read again later. Finalizing either by a clock is
 * exactly the failure `SubmitExecutionResponseBody`'s own contract warns about.
 *
 * ## The gap this module cannot close
 *
 * A crash *during* the create — an open attempt with an idempotency key but no
 * execution id — is not resolvable here, and it is not resolvable at all with the
 * API as it stands. Establishing whether that key produced an execution needs a
 * read from `Idempotency-Key` to an execution, and there is none: no endpoint
 * takes the key, and `PredictExecutionSummary` does not carry it. Replaying the
 * create as a probe is not a substitute — a key that never landed would be *made*
 * to land by the probe, turning "nothing happened" into a real order, and the
 * exact request bytes died with the process that held them in any case.
 *
 * So that case returns `INCONCLUSIVE` and the job goes back to `UNKNOWN_PENDING`,
 * where a human can see it. Backlog §6 carries the backend dependency.
 */
import type {
  PredictExecutionStatus,
  PredictTerminalExecutionStatus,
  SubmitExecutionResponseBody,
} from '@waterx/predict-agent-sdk';
import { isTerminalExecutionStatus } from '@waterx/predict-agent-sdk';

import { JobStoreError } from './errors.ts';
import type {
  JobLeg,
  JobLegStatus,
  JobLease,
  SideEffectAttempt,
  SideEffectOutcome,
} from './job.ts';
import type { JobState } from './state-machine.ts';
import type { JobStore, LegPatch } from './store.ts';

/**
 * The one call this module makes. A structural subset of `PredictAgentClient`, so
 * the real client satisfies it and a test does not need a transport.
 */
export interface ReconcileGateway {
  getExecution(executionId: string, signal?: AbortSignal): Promise<SubmitExecutionResponseBody>;
}

export type ReconcileDisposition =
  /** Every leg is resolved and the job took the terminal state the server reported. */
  | 'TERMINAL'
  /** One leg resolved; the job has others still unresolved. */
  | 'LEG_RESOLVED'
  /** The execution exists and has not finished. Nothing is decided; read again. */
  | 'STILL_PENDING'
  /** Nothing could be established. The job is back in `UNKNOWN_PENDING`. */
  | 'INCONCLUSIVE'
  /** The job was not in a state this module may touch. Nothing was written. */
  | 'NOT_APPLICABLE';

export interface ReconcileResult {
  readonly jobId: string;
  readonly from: JobState;
  readonly to: JobState;
  readonly disposition: ReconcileDisposition;
  readonly reason: string;
  readonly legIndex?: number;
  readonly executionId?: string;
  /** What the server said, verbatim, when it was asked. */
  readonly status?: PredictExecutionStatus;
}

export interface ReconcileJobOptions {
  readonly store: JobStore;
  readonly gateway: ReconcileGateway;
  /** Held by this instance. Every write below asserts it. */
  readonly lease: JobLease;
  readonly at: string;
  /**
   * The job's lease signal. A Runner that has been fenced out must stop reading
   * on behalf of a job another instance now owns.
   */
  readonly signal?: AbortSignal;
}

/** WaterX rejected it; the chain cancelled it; the clock expired it. Three facts. */
const JOB_TERMINAL: Readonly<Record<PredictTerminalExecutionStatus, JobState>> = {
  FILLED: 'FILLED',
  REJECTED: 'FAILED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
};

/**
 * A leg records only whether it worked. The distinction between rejected,
 * cancelled and expired lives on the execution the leg points at, which is where
 * an audit should read it from — copying a verdict into a second vocabulary is
 * how the two start disagreeing.
 */
const LEG_TERMINAL: Readonly<Record<PredictTerminalExecutionStatus, JobLegStatus>> = {
  FILLED: 'SUCCEEDED',
  REJECTED: 'FAILED',
  CANCELLED: 'FAILED',
  EXPIRED: 'FAILED',
};

const isResolved = (leg: JobLeg): boolean =>
  leg.status === 'SUCCEEDED' || leg.status === 'FAILED' || leg.status === 'SKIPPED';

/**
 * Reconciles one leg of one job against the server.
 *
 * One leg per call, deliberately. Orders in a chain are independent (ADR-0001
 * §15) and a single call that resolved all of them would have to decide what to
 * do when the second read fails after the first one already committed a terminal
 * fact. The caller loops; each pass is one transaction's worth of truth.
 */
export const reconcileJob = async (options: ReconcileJobOptions): Promise<ReconcileResult> => {
  const { store, gateway, lease, at } = options;
  const job = await store.getJob(lease.jobId);
  if (job === undefined) {
    throw new JobStoreError('UNKNOWN_JOB', `unknown job ${lease.jobId}`, { jobId: lease.jobId });
  }

  if (job.state !== 'UNKNOWN_PENDING' && job.state !== 'RECONCILING') {
    // Not a refusal to be caught — a job that is quietly watching a price has
    // nothing to reconcile, and saying so is cheaper than a thrown error the
    // caller would have to distinguish from a real one.
    return {
      jobId: job.jobId,
      from: job.state,
      to: job.state,
      disposition: 'NOT_APPLICABLE',
      reason: 'NOT_RECONCILABLE',
    };
  }

  const from = job.state;
  if (job.state === 'UNKNOWN_PENDING') {
    // Before the read, not after. A crash between the two leaves the job saying
    // "a reconcile is in progress", which recovery reads correctly; the reverse
    // order would leave a job that had already learned the answer still claiming
    // it did not know.
    await store.transition({ lease, to: 'RECONCILING', reason: 'RECONCILE_STARTED', at });
  }

  const legs = await store.listLegs(job.jobId);
  const unresolved = legs.filter((leg) => !isResolved(leg));
  // A leg with an execution id is a leg this module can actually establish
  // something about, so it goes first. Taking them in index order instead would
  // let one leg whose create was ambiguous — the gap documented above, which
  // returns INCONCLUSIVE every pass — permanently hide the resolvable legs
  // behind it, and a chain of orders would never conclude because of its first.
  const target = unresolved.find((leg) => leg.executionId !== null) ?? unresolved[0];
  if (target === undefined) {
    // Every leg is already resolved; only the job-level summary is outstanding.
    return await concludeJob({ store, lease, at, legs, from });
  }

  const open = (await store.listOpenSideEffects(job.jobId)).find(
    (attempt) => attempt.legIndex === target.legIndex,
  );

  if (target.executionId === null) {
    // The create may or may not have landed and nothing can be read that would
    // say which. The attempt row stays open on purpose: it is the evidence, and
    // closing it would erase the only record that a request may exist.
    await store.transition({
      lease,
      to: 'UNKNOWN_PENDING',
      reason: 'RECONCILE_INCONCLUSIVE',
      at,
      detail: {
        legIndex: target.legIndex,
        missing: 'EXECUTION_ID',
        // Named so an operator reading the log knows this is a known gap with a
        // known fix, not a Runner that failed to try.
        needs: 'A read from Idempotency-Key to an execution. The API exposes none.',
        ...(open === undefined ? {} : { openAttemptId: open.attemptId }),
      },
    });
    return {
      jobId: job.jobId,
      from,
      to: 'UNKNOWN_PENDING',
      disposition: 'INCONCLUSIVE',
      reason: 'NO_EXECUTION_ID',
      legIndex: target.legIndex,
    };
  }

  const read = await gateway.getExecution(target.executionId, options.signal);

  const observed: LegPatch = {
    ...(read.transactionDigest === undefined ? {} : { submissionDigest: read.transactionDigest }),
    ...(read.fill?.txDigest == null ? {} : { keeperDigest: read.fill.txDigest }),
  };

  if (!isTerminalExecutionStatus(read.status)) {
    await applyLeg({ store, lease, at, legIndex: target.legIndex, open, read, patch: observed });
    return {
      jobId: job.jobId,
      from,
      to: 'RECONCILING',
      disposition: 'STILL_PENDING',
      reason: 'EXECUTION_NOT_TERMINAL',
      legIndex: target.legIndex,
      executionId: target.executionId,
      status: read.status,
    };
  }

  await applyLeg({
    store,
    lease,
    at,
    legIndex: target.legIndex,
    open,
    read,
    patch: { ...observed, status: LEG_TERMINAL[read.status] },
  });

  const after = await store.listLegs(job.jobId);
  if (after.some((leg) => !isResolved(leg))) {
    return {
      jobId: job.jobId,
      from,
      to: 'RECONCILING',
      disposition: 'LEG_RESOLVED',
      reason: `EXECUTION_${read.status}`,
      legIndex: target.legIndex,
      executionId: target.executionId,
      status: read.status,
    };
  }

  const concluded = await concludeJob({
    store,
    lease,
    at,
    legs: after,
    from,
    verdict: read.status,
  });
  return {
    ...concluded,
    legIndex: target.legIndex,
    executionId: target.executionId,
    status: read.status,
  };
};

/**
 * Whether the submit itself reached the chain, as opposed to the execution
 * merely existing.
 *
 * A digest is proof. Short of one, only a status at or past `SUBMITTING` says
 * the broker got that far — an execution sitting at `AWAITING_SIGNATURE`, or one
 * `REJECTED` by risk before it was ever sent, is an execution whose submit did
 * *not* take effect. Calling that submit successful would leave a leg the
 * executor believes was sent, which is how a real order goes missing.
 */
const submissionObserved = (read: SubmitExecutionResponseBody): boolean =>
  read.transactionDigest !== undefined ||
  read.status === 'SUBMITTING' ||
  read.status === 'SUBMITTED' ||
  read.status === 'PENDING_FILL' ||
  read.status === 'FILLED';

/**
 * The outcome to record for the attempt the crash left open.
 *
 * "Did my request take effect" is a different question from "how did the order
 * end", and only the first one is answered here. For a create, the execution
 * answering at all settles it. For a submit it does not, so the digest decides.
 */
const attemptOutcome = (
  attempt: SideEffectAttempt,
  read: SubmitExecutionResponseBody,
): SideEffectOutcome =>
  attempt.kind === 'SUBMIT_EXECUTION' && !submissionObserved(read) ? 'FAILED' : 'SUCCEEDED';

interface ApplyLegInput {
  readonly store: JobStore;
  readonly lease: JobLease;
  readonly at: string;
  readonly legIndex: number;
  readonly open: SideEffectAttempt | undefined;
  readonly read: SubmitExecutionResponseBody;
  readonly patch: LegPatch;
}

/**
 * Writes what the read established, closing the open attempt in the SAME
 * transaction when there is one.
 *
 * Two statements would reintroduce the crash window the ledger exists to remove:
 * an attempt resolved without its leg patch, or a leg marked succeeded while its
 * attempt still reads as unresolved, are both states recovery would misread.
 */
const applyLeg = async (input: ApplyLegInput): Promise<void> => {
  const { store, lease, at, legIndex, open, read, patch } = input;
  if (open !== undefined) {
    await store.completeSideEffect({
      lease,
      attemptId: open.attemptId,
      outcome: attemptOutcome(open, read),
      at,
      detail: {
        resolvedBy: 'RECONCILE',
        executionId: read.executionId,
        observedStatus: read.status,
        submissionObserved: submissionObserved(read),
      },
      leg: patch,
    });
    return;
  }
  if (Object.keys(patch).length === 0) return;
  await store.updateLeg({ lease, legIndex, at, ...patch });
};

interface ConcludeInput {
  readonly store: JobStore;
  readonly lease: JobLease;
  readonly at: string;
  readonly legs: readonly JobLeg[];
  readonly from: JobState;
  readonly verdict?: PredictTerminalExecutionStatus;
}

/**
 * The job-level summary, once no leg is outstanding.
 *
 * Legs are independent, so the summary is deliberately coarse and the legs stay
 * authoritative: any leg that succeeded makes the job `FILLED`, because something
 * was traded and a strategy must not read the job as a no-op. Only when nothing
 * succeeded does the server's verdict on the last leg decide between `CANCELLED`,
 * `EXPIRED` and `FAILED` — and a mixed set of failures collapses to `FAILED`,
 * which is the one that cannot be mistaken for a stop that was asked for.
 */
const concludeJob = async (input: ConcludeInput): Promise<ReconcileResult> => {
  const { store, lease, at, legs, from, verdict } = input;
  const succeeded = legs.some((leg) => leg.status === 'SUCCEEDED');
  const to: JobState = succeeded ? 'FILLED' : verdict === undefined ? 'FAILED' : JOB_TERMINAL[verdict];

  const record = await store.transition({
    lease,
    to,
    reason: verdict === undefined ? 'ALL_LEGS_RESOLVED' : `EXECUTION_${verdict}`,
    at,
    detail: {
      legs: legs.map((leg) => ({ legIndex: leg.legIndex, status: leg.status })),
      ...(verdict === undefined ? {} : { lastExecutionStatus: verdict }),
    },
  });

  return {
    jobId: record.jobId,
    from,
    to: record.state,
    disposition: 'TERMINAL',
    reason: verdict === undefined ? 'ALL_LEGS_RESOLVED' : `EXECUTION_${verdict}`,
  };
};
