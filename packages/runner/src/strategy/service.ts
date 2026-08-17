/**
 * Create, read, list, cancel and follow a durable strategy.
 *
 * This is the command core the CLI, the IPC surface and any adapter will sit on:
 * one implementation of what a strategy *is*, so that a second surface cannot
 * quietly acquire a second set of rules about sizing, expiry or cancellation.
 *
 * What it does NOT do, today, is make a strategy run. `create` normalizes an
 * intent and writes a durable job in `DRAFT`; no executor, signer or price
 * watcher exists yet (`docs/IMPLEMENTATION_BACKLOG.md` 2.6), so nothing advances
 * it and no order is ever placed. That is why `create` returns the job's state
 * rather than a word like "armed", and why {@link StrategySummary} carries
 * `pastExpiry` as a fact about the clock rather than as a state: a job can be
 * past its expiry and still sitting in `WATCHING`, because only a running Runner
 * may end it, and reporting otherwise would describe a stop that did not happen.
 *
 * Cancellation has the same shape for the same reason. It is *recorded* by
 * anyone and *applied* only by the instance holding the lease, and only from a
 * state that has not begun a write (ADR-0001 §15).
 */
import type { Iso8601 } from '@waterx/predict-agent-sdk';

import type { Clock } from '../clock.ts';
import { newJobId, newStrategyId } from '../ids.ts';
import type { JobLease, JobLeg, JobRecord, SideEffectAttempt } from '../job.ts';
import { canEndLocally, isTerminalJobState, type JobState } from '../state-machine.ts';
import type { JobStore } from '../store.ts';
import { buildStrategyEvents, type StrategyEvent } from './events.ts';
import { normalizeStrategy, type StrategyRequest } from './intent.ts';
import type { StrategyPositionReader } from './positions.ts';

/**
 * The part of the lease keeper a cancellation needs.
 *
 * Structural, so the service can be used with no daemon at all — a CLI process
 * that shares the store holds no leases, records the request, and says so.
 */
export interface StrategyLeaseHolder {
  lease(jobId: string): JobLease | undefined;
  forget(jobId: string, reason: 'RELEASED'): void;
}

export interface StrategyServiceOptions {
  readonly store: JobStore;
  readonly now: Clock;
  /** Required only by percentage SELLs, which resolve against a real position. */
  readonly positions?: StrategyPositionReader;
  /** Present in a Runner daemon; absent in a plain client process. */
  readonly leases?: StrategyLeaseHolder;
  /** Overridable for tests; the ADR-0005 beta cap is the default. */
  readonly maxExpiryMs?: number;
}

export interface StrategyExpiry {
  readonly expiresAt: Iso8601;
  /** Clamped at zero. Negative time remaining is not a thing a caller should render. */
  readonly remainingMs: number;
  /**
   * The expiry instant has passed. NOT the same as the `EXPIRED` state: only a
   * Runner holding the lease ends a job, so this is true for a while before the
   * state changes — and stays true forever if nothing is running the job.
   */
  readonly pastExpiry: boolean;
}

export interface StrategySummary {
  readonly jobId: string;
  readonly strategyId: string;
  readonly accountId: string;
  readonly state: JobState;
  readonly terminal: boolean;
  readonly createdAt: Iso8601;
  readonly updatedAt: Iso8601;
  readonly expiry: StrategyExpiry;
  readonly cancelRequestedAt: Iso8601 | null;
  readonly terminalAt: Iso8601 | null;
}

export interface StrategyDetail extends StrategySummary {
  readonly job: JobRecord;
  readonly legs: readonly JobLeg[];
  /**
   * Attempts with no recorded outcome. Surfaced rather than summarized: this is
   * the evidence that a request may have left the process unanswered.
   */
  readonly openSideEffects: readonly SideEffectAttempt[];
}

export interface StrategyListFilter {
  readonly accountId?: string;
  readonly strategyId?: string;
  readonly states?: readonly JobState[];
}

export interface StrategyCancelResult {
  readonly jobId: string;
  readonly state: JobState;
  /** The request is durable either way. */
  readonly recorded: true;
  readonly applied: boolean;
  /** Why it was not applied. Absent when it was. */
  readonly pending?: 'NOT_LEASED_BY_THIS_RUNNER' | 'IN_FLIGHT';
  readonly cancelRequestedAt: Iso8601 | null;
  readonly terminalAt?: Iso8601 | null;
}

export class StrategyService {
  constructor(private readonly options: StrategyServiceOptions) {}

  /**
   * Normalize an intent and write it down.
   *
   * One clock read covers the whole call, so the instant a fraction was frozen
   * at, the instant expiry is measured from and the job's `createdAt` are the
   * same instant rather than three that drift under a slow position read.
   */
  async create(request: StrategyRequest, signal?: AbortSignal): Promise<StrategyDetail> {
    const at = this.options.now();
    const normalized = await normalizeStrategy(request, {
      at,
      ...(this.options.positions === undefined ? {} : { positions: this.options.positions }),
      ...(this.options.maxExpiryMs === undefined ? {} : { maxExpiryMs: this.options.maxExpiryMs }),
      ...(signal === undefined ? {} : { signal }),
    });

    const job = await this.options.store.createJob({
      jobId: newJobId(),
      strategyId: request.strategyId ?? newStrategyId(),
      ownerAddress: request.ownerAddress,
      accountId: request.accountId,
      agentWallet: request.agentWallet,
      intent: normalized.legs,
      trigger: normalized.trigger,
      policy: request.policy,
      expiresAt: normalized.expiresAt,
      at,
    });

    return await this.detail(job, at);
  }

  async get(jobId: string): Promise<StrategyDetail | undefined> {
    const job = await this.options.store.getJob(jobId);
    if (job === undefined) return undefined;
    return await this.detail(job, this.options.now());
  }

  /** Summaries only: a list that read every job's legs would fan out per row. */
  async list(filter: StrategyListFilter = {}): Promise<readonly StrategySummary[]> {
    const at = this.options.now();
    const jobs = await this.options.store.listJobs({
      ...(filter.accountId === undefined ? {} : { accountId: filter.accountId }),
      ...(filter.strategyId === undefined ? {} : { strategyId: filter.strategyId }),
      ...(filter.states === undefined ? {} : { states: filter.states }),
    });
    return jobs.map((job) => summarize(job, at));
  }

  /** The merged transition and side-effect feed. See {@link buildStrategyEvents}. */
  async events(jobId: string): Promise<readonly StrategyEvent[]> {
    const [transitions, attempts] = await Promise.all([
      this.options.store.listTransitions(jobId),
      this.options.store.listSideEffects(jobId),
    ]);
    return buildStrategyEvents(jobId, transitions, attempts);
  }

  async cancel(jobId: string, reason: string): Promise<StrategyCancelResult> {
    return await cancelStrategy(
      {
        store: this.options.store,
        now: this.options.now,
        ...(this.options.leases === undefined ? {} : { leases: this.options.leases }),
      },
      jobId,
      reason,
    );
  }

  private async detail(job: JobRecord, at: Iso8601): Promise<StrategyDetail> {
    const [legs, openSideEffects] = await Promise.all([
      this.options.store.listLegs(job.jobId),
      this.options.store.listOpenSideEffects(job.jobId),
    ]);
    return { ...summarize(job, at), job, legs, openSideEffects };
  }
}

export interface CancelContext {
  readonly store: JobStore;
  readonly now: Clock;
  readonly leases?: StrategyLeaseHolder;
  /** Recorded on the transition so an audit can tell which surface asked. */
  readonly via?: string;
}

/**
 * The one implementation of cancellation, shared by the service and the IPC
 * dispatcher.
 *
 * Two surfaces with two copies of this would eventually disagree about whether a
 * job that may have an order in flight counts as cancelled, and that disagreement
 * is a caller believing a submit was stopped when nothing stopped it.
 */
export const cancelStrategy = async (
  context: CancelContext,
  jobId: string,
  reason: string,
): Promise<StrategyCancelResult> => {
  const at = context.now();
  const record = await context.store.requestCancel(jobId, reason, at);
  const lease = context.leases?.lease(jobId);

  if (lease === undefined) {
    return {
      jobId,
      state: record.state,
      recorded: true,
      applied: false,
      // Honest, and product-visible: nothing is running this job, so the request
      // sits until some Runner claims it.
      pending: 'NOT_LEASED_BY_THIS_RUNNER',
      cancelRequestedAt: record.cancelRequestedAt,
    };
  }

  if (!canEndLocally(record.state)) {
    return {
      jobId,
      state: record.state,
      recorded: true,
      applied: false,
      pending: 'IN_FLIGHT',
      cancelRequestedAt: record.cancelRequestedAt,
    };
  }

  const cancelled = await context.store.transition({
    lease,
    to: 'CANCELLED',
    reason: 'CANCEL_REQUESTED',
    at,
    detail: {
      requestedReason: reason,
      ...(context.via === undefined ? {} : { requestedVia: context.via }),
    },
  });
  // The terminal transition cleared the lease inside its own transaction, so the
  // keeper must forget it rather than try to hand back a lease it no longer has.
  context.leases?.forget(jobId, 'RELEASED');
  return {
    jobId,
    state: cancelled.state,
    recorded: true,
    applied: true,
    cancelRequestedAt: cancelled.cancelRequestedAt,
    terminalAt: cancelled.terminalAt,
  };
};

const summarize = (job: JobRecord, at: Iso8601): StrategySummary => {
  const remaining = Date.parse(job.expiresAt) - Date.parse(at);
  return {
    jobId: job.jobId,
    strategyId: job.strategyId,
    accountId: job.accountId,
    state: job.state,
    terminal: isTerminalJobState(job.state),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    expiry: {
      expiresAt: job.expiresAt,
      remainingMs: Math.max(0, remaining),
      pastExpiry: remaining <= 0,
    },
    cancelRequestedAt: job.cancelRequestedAt,
    terminalAt: job.terminalAt,
  };
};
