/**
 * Crash recovery, and the only place `UNKNOWN_PENDING` is entered on purpose.
 *
 * A Runner that starts and finds jobs in the store has to answer one question
 * per job: *did anything leave this process?* The store is arranged so that the
 * answer is a fact on disk rather than a guess, and this module is the reading
 * of it. Its rule, in one line: **only evidence ends a job; absence of evidence
 * ends nothing.**
 *
 * The five crash points from the threat model (backlog 0.4) and what happens:
 *
 * | crash between… | on disk | decision |
 * | --- | --- | --- |
 * | key persisted, create not yet begun | leg, no attempt | `WATCHING` — nothing was sent, and the SAME key is reused when it is |
 * | attempt begun, request maybe sent | open attempt | `UNKNOWN_PENDING` — a request may exist; only a reconcile under the original key may resolve it |
 * | create returned, state not yet moved | resolved attempt + execution id | `RECONCILING` — the execution exists, read it back |
 * | submit in flight | open attempt | `UNKNOWN_PENDING` |
 * | duplicate Runner on one store | live lease held elsewhere | skipped; the fence keeps the other writer authoritative |
 *
 * `expiresAt` and a pending cancellation are honoured only from a state that has
 * not started a write. A clock passing an expiry cannot un-send an order, and
 * ADR-0001 §15 forbids reporting a stop that did not happen — so an in-flight job
 * is reconciled first and expires, if at all, through its terminal facts.
 */
import { JobStoreError } from './errors.ts';
import type { JobLease, RunnerInstance } from './job.ts';
import type { JobStore } from './store.ts';
import { JOB_STATES, NON_TERMINAL_JOB_STATES, type JobState } from './state-machine.ts';

export type RecoveryDisposition =
  /** An external request may have been sent and nothing observed the reply. */
  | 'UNKNOWN_PENDING'
  /** An execution id is on disk; its authoritative state must be read back. */
  | 'RECONCILE'
  /** Nothing was sent. The job re-arms and reuses the key it already minted. */
  | 'REARMED'
  /** Left where it was, now leased by this instance. */
  | 'RESUMED'
  /** `expiresAt` passed while the job had not started a write (ADR-0005). */
  | 'EXPIRED'
  /** A cancellation was requested while the job had not started a write. */
  | 'CANCELLED'
  /** Another live Runner holds the lease. This instance must not touch it. */
  | 'HELD_ELSEWHERE'
  /**
   * The store refused the transition recovery derived. Reported, never forced:
   * an inconsistency here is a bug worth seeing, and driving the job anyway is
   * how one job's bug becomes a duplicate order.
   */
  | 'UNRESOLVED';

export interface RecoveredJob {
  readonly jobId: string;
  readonly from: JobState;
  readonly to: JobState;
  readonly disposition: RecoveryDisposition;
  /** Held by this instance for every disposition that left the job runnable. */
  readonly lease?: JobLease;
  readonly openAttemptId?: string;
  readonly executionId?: string;
  readonly error?: string;
}

export interface RecoveryReport {
  readonly instanceId: string;
  readonly at: string;
  readonly jobs: readonly RecoveredJob[];
  /**
   * Instances whose heartbeat is older than `staleAfterMs`. Product-visible:
   * with a self-hosted Runner these are strategies nobody was watching.
   */
  readonly staleInstances: readonly RunnerInstance[];
}

export interface RecoveryOptions {
  readonly store: JobStore;
  /** Must already be registered: recovery claims leases in this instance's name. */
  readonly instanceId: string;
  readonly at: string;
  readonly leaseTtlMs: number;
  /** How long a silent instance may be presumed alive. */
  readonly staleAfterMs: number;
}

export const recoverJobs = async (options: RecoveryOptions): Promise<RecoveryReport> => {
  const { store, instanceId, at, leaseTtlMs } = options;
  const nowMs = Date.parse(at);

  const staleInstances = (await store.listInstances()).filter(
    (instance) =>
      instance.instanceId !== instanceId &&
      instance.stoppedAt === null &&
      nowMs - Date.parse(instance.heartbeatAt) > options.staleAfterMs,
  );

  // Every non-terminal job, not only the unleased ones. A job another live
  // Runner holds still belongs in the report — "someone else is running this" is
  // the answer to the duplicate-instance question, and silently omitting it
  // would read as "there was nothing to recover".
  const candidates = await store.listJobs({ states: NON_TERMINAL_JOB_STATES });
  const jobs: RecoveredJob[] = [];

  for (const candidate of candidates) {
    const lease = await store.claimJob({ jobId: candidate.jobId, instanceId, at, leaseTtlMs });
    if (lease === undefined) {
      jobs.push({
        jobId: candidate.jobId,
        from: candidate.state,
        to: candidate.state,
        disposition: 'HELD_ELSEWHERE',
      });
      continue;
    }

    const [legs, open] = await Promise.all([
      store.listLegs(candidate.jobId),
      store.listOpenSideEffects(candidate.jobId),
    ]);
    const openAttempt = open[0];
    const withExecution = legs.find((leg) => leg.executionId !== null);
    const abandoned = (await store.listSideEffects(candidate.jobId)).some(
      (attempt) => attempt.outcome === 'ABANDONED',
    );

    const plan = classify({
      state: candidate.state,
      hasOpenAttempt: openAttempt !== undefined,
      hasAbandonedAttempt: abandoned,
      hasExecution: withExecution !== undefined,
      cancelRequested: candidate.cancelRequestedAt !== null,
      expired: Date.parse(candidate.expiresAt) <= nowMs,
    });

    if (plan.to === candidate.state) {
      jobs.push({
        jobId: candidate.jobId,
        from: candidate.state,
        to: candidate.state,
        disposition: plan.disposition,
        lease,
        ...(openAttempt === undefined ? {} : { openAttemptId: openAttempt.attemptId }),
        ...(withExecution?.executionId == null
          ? {}
          : { executionId: withExecution.executionId }),
      });
      continue;
    }

    try {
      await store.transition({
        lease,
        to: plan.to,
        reason: plan.reason,
        at,
        detail: { recoveredBy: instanceId, disposition: plan.disposition },
      });
      jobs.push({
        jobId: candidate.jobId,
        from: candidate.state,
        to: plan.to,
        disposition: plan.disposition,
        // A job that reached a terminal state has no lease left to hand back —
        // `transition` clears it — so reporting one would be a lie a caller
        // could act on.
        ...(JOB_STATES[plan.to].terminal ? {} : { lease }),
        ...(openAttempt === undefined ? {} : { openAttemptId: openAttempt.attemptId }),
        ...(withExecution?.executionId == null
          ? {}
          : { executionId: withExecution.executionId }),
      });
    } catch (error) {
      jobs.push({
        jobId: candidate.jobId,
        from: candidate.state,
        to: candidate.state,
        disposition: 'UNRESOLVED',
        lease,
        error: error instanceof JobStoreError ? `${error.code}: ${error.message}` : String(error),
      });
    }
  }

  return { instanceId, at, jobs, staleInstances };
};

interface Facts {
  readonly state: JobState;
  readonly hasOpenAttempt: boolean;
  readonly hasAbandonedAttempt: boolean;
  readonly hasExecution: boolean;
  readonly cancelRequested: boolean;
  readonly expired: boolean;
}

interface Plan {
  readonly to: JobState;
  readonly disposition: RecoveryDisposition;
  readonly reason: string;
}

/**
 * The decision, separated from the store so the table above is testable as a
 * table rather than only through a database.
 */
export const classify = (facts: Facts): Plan => {
  // Order matters. Evidence that something left the process outranks every
  // local reason to end the job.
  if (facts.hasOpenAttempt) {
    return {
      to: 'UNKNOWN_PENDING',
      disposition: 'UNKNOWN_PENDING',
      reason: 'CRASH_DURING_SIDE_EFFECT',
    };
  }
  if (facts.state === 'UNKNOWN_PENDING') {
    return { to: 'RECONCILING', disposition: 'RECONCILE', reason: 'RESOLVE_UNKNOWN_PENDING' };
  }
  if (facts.hasExecution) {
    return { to: 'RECONCILING', disposition: 'RECONCILE', reason: 'EXECUTION_EXISTS' };
  }
  if (JOB_STATES[facts.state].inFlight || facts.hasAbandonedAttempt) {
    // The state says an order may exist but no execution id was ever recorded.
    // That is exactly the case where the Runner cannot tell, and the honest
    // answer is UNKNOWN_PENDING rather than a re-arm that could double-send.
    return {
      to: 'UNKNOWN_PENDING',
      disposition: 'UNKNOWN_PENDING',
      reason: 'IN_FLIGHT_WITHOUT_EXECUTION',
    };
  }
  if (facts.cancelRequested) {
    return { to: 'CANCELLED', disposition: 'CANCELLED', reason: 'CANCEL_REQUESTED' };
  }
  if (facts.expired) {
    return { to: 'EXPIRED', disposition: 'EXPIRED', reason: 'EXPIRES_AT_PASSED' };
  }
  if (facts.state === 'TRIGGERED' || facts.state === 'QUOTING') {
    // Nothing was sent, so the trigger has to be observed again from scratch —
    // a quote from before the crash is stale and a target seen before it is not
    // evidence about now (ADR-0001 §14).
    return { to: 'WATCHING', disposition: 'REARMED', reason: 'NOTHING_WAS_SENT' };
  }
  return { to: facts.state, disposition: 'RESUMED', reason: 'RESUMED' };
};
