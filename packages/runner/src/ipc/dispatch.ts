/**
 * Turning a validated IPC request into an answer.
 *
 * The dispatcher is where the Runner's honesty rules become machine-readable
 * rather than documentary:
 *
 * - `runner.status` reports `driving` from whether a scheduler is actually
 *   ticking in *this* process — not from whether the package contains a loop,
 *   and not from whether one was configured. A client that treats a reachable
 *   Runner as a running strategy is making exactly the mistake ADR-0001 §6 is
 *   about, and a boolean in the reply is the only form of that warning a program
 *   can act on. `driverGaps` names what is absent when the answer is no.
 * - `runner.cancel-job` distinguishes *recorded* from *applied*. Only the lease
 *   holder may end a job, and only from a state that has not started a write —
 *   replying "cancelled" while a submit may be in flight would report a stop that
 *   did not happen (ADR-0001 §15). The store already refuses to apply it; this
 *   layer refuses to describe it as applied.
 */
import type { Clock } from '../clock.ts';
import { isJobStoreError, JobStoreError } from '../errors.ts';
import type { PriceTopicStatus } from '../prices.ts';
import type { RecoveryReport } from '../recovery.ts';
import type { JobState } from '../state-machine.ts';
import type { JobStore } from '../store.ts';
import { cancelStrategy } from '../strategy/service.ts';
import type { LeaseKeeper } from '../supervisor.ts';
import { validateRunnerCommand } from './commands.ts';
import { isRunnerIpcError, RUNNER_IPC_PROTOCOL_VERSION, type ResponseErrorBody } from './protocol.ts';

export interface RunnerCommandContext {
  readonly store: JobStore;
  readonly instanceId: string;
  readonly pid: number;
  readonly host: string;
  readonly startedAt: string;
  readonly now: Clock;
  readonly leases: LeaseKeeper;
  /** Whether anything in this build actually advances a job. */
  readonly driving: boolean;
  /** Named, so a client can report which pieces are absent rather than guessing. */
  readonly driverGaps: readonly string[];
  /**
   * Live topic health from the driver's price source. Absent when nothing is
   * watching prices, which is not the same as watching them and seeing none.
   */
  readonly priceTopics?: () => readonly PriceTopicStatus[];
  readonly recovery: RecoveryReport | undefined;
  requestShutdown(reason: string): void;
}

export const dispatch = async (
  command: string,
  rawInput: unknown,
  context: RunnerCommandContext,
): Promise<unknown> => {
  const input = validateRunnerCommand(command, rawInput, { driverGaps: context.driverGaps });

  switch (command) {
    case 'runner.status':
      return status(context);
    case 'runner.jobs':
      return jobs(input, context);
    case 'runner.job':
      return job(input, context);
    case 'runner.cancel-job':
      return cancelJob(input, context);
    case 'runner.shutdown': {
      const reason = typeof input['reason'] === 'string' ? input['reason'] : 'IPC_REQUEST';
      context.requestShutdown(reason);
      return { stopping: true, instanceId: context.instanceId, reason };
    }
    /* c8 ignore next 3 -- unreachable: validateRunnerCommand rejects every other name */
    default:
      throw new Error(`unhandled runner command ${command}`);
  }
};

/**
 * What the price feed is actually saying, per topic.
 *
 * `null` when nothing is watching prices at all — which a client must be able to
 * tell from a feed that is watching and reporting nothing. `degraded` is counted
 * out separately because it is the one status that never recovers on its own:
 * the stream has given up for the life of the process, so those topics will
 * answer `null` forever and every job watching them will wait forever without
 * erroring. A silent strategy and a dead feed look identical without this.
 */
const priceHealth = (context: RunnerCommandContext): unknown => {
  if (context.priceTopics === undefined) return null;
  const topics = context.priceTopics();
  return {
    watching: topics.length,
    degraded: topics.filter((topic) => topic.unavailable === 'DEGRADED').length,
    /** Subscribed, but nothing has ever been observed on it. */
    silent: topics.filter((topic) => topic.lastObservedAt === undefined).length,
    topics: topics.map((topic) => ({
      marketId: topic.marketId,
      outcomeId: topic.outcomeId,
      subscribedAt: topic.subscribedAt,
      lastObservedAt: topic.lastObservedAt ?? null,
      lastAskedAt: topic.lastAskedAt,
      unavailable: topic.unavailable ?? null,
      gapped: topic.gapped,
    })),
  };
};

const status = async (context: RunnerCommandContext): Promise<unknown> => {
  const all = await context.store.listJobs();
  const byState: Record<string, number> = {};
  for (const record of all) byState[record.state] = (byState[record.state] ?? 0) + 1;

  return {
    protocol: RUNNER_IPC_PROTOCOL_VERSION,
    instanceId: context.instanceId,
    pid: context.pid,
    host: context.host,
    startedAt: context.startedAt,
    at: context.now(),
    store: { kind: context.store.kind },
    // The two fields a caller must read before believing a strategy is running.
    driving: context.driving,
    driverGaps: [...context.driverGaps],
    prices: priceHealth(context),
    jobs: { total: all.length, byState },
    leasedHere: context.leases.held(),
    recovery:
      context.recovery === undefined
        ? null
        : {
            at: context.recovery.at,
            jobs: context.recovery.jobs.map((entry) => ({
              jobId: entry.jobId,
              from: entry.from,
              to: entry.to,
              disposition: entry.disposition,
            })),
            staleInstances: context.recovery.staleInstances.map((instance) => ({
              instanceId: instance.instanceId,
              host: instance.host,
              heartbeatAt: instance.heartbeatAt,
            })),
          },
  };
};

const jobs = async (
  input: Readonly<Record<string, unknown>>,
  context: RunnerCommandContext,
): Promise<unknown> => {
  const state = input['state'];
  const accountId = input['accountId'];
  const records = await context.store.listJobs({
    ...(typeof state === 'string' ? { states: [state as JobState] } : {}),
    ...(typeof accountId === 'string' ? { accountId } : {}),
  });
  return {
    jobs: records.map((record) => ({
      jobId: record.jobId,
      strategyId: record.strategyId,
      accountId: record.accountId,
      state: record.state,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      expiresAt: record.expiresAt,
      terminalAt: record.terminalAt,
      cancelRequestedAt: record.cancelRequestedAt,
      leasedHere: context.leases.isHeld(record.jobId),
      leaseInstanceId: record.leaseInstanceId,
    })),
  };
};

const job = async (
  input: Readonly<Record<string, unknown>>,
  context: RunnerCommandContext,
): Promise<unknown> => {
  const jobId = input['jobId'] as string;
  const record = await context.store.getJob(jobId);
  if (record === undefined) {
    throw new JobStoreError('UNKNOWN_JOB', `unknown job ${jobId}`, { jobId });
  }
  const [legs, transitions, open] = await Promise.all([
    context.store.listLegs(jobId),
    context.store.listTransitions(jobId),
    context.store.listOpenSideEffects(jobId),
  ]);
  return {
    job: record,
    legs,
    transitions,
    // The evidence that a request may have left this process. Surfaced rather
    // than summarized: "unknown" is the answer, and it should look like one.
    openSideEffects: open,
    leasedHere: context.leases.isHeld(jobId),
  };
};

/**
 * Delegated, not reimplemented. The recorded/applied distinction has exactly one
 * implementation ({@link cancelStrategy}), so the IPC surface and any other
 * client of the store cannot drift into disagreeing about whether a job with a
 * write in flight counts as stopped.
 */
const cancelJob = async (
  input: Readonly<Record<string, unknown>>,
  context: RunnerCommandContext,
): Promise<unknown> =>
  await cancelStrategy(
    { store: context.store, now: context.now, leases: context.leases, via: 'ipc' },
    input['jobId'] as string,
    input['reason'] as string,
  );

/**
 * Maps a thrown value onto the wire error body.
 *
 * Store refusals keep their own codes — `ILLEGAL_TRANSITION`, `LEASE_LOST`,
 * `NO_IDEMPOTENCY_KEY` — because those name rules a caller must branch on, and
 * flattening them into `INTERNAL` would turn a refusal that protects funds into
 * an unexplained failure.
 */
export const toErrorBody = (error: unknown): ResponseErrorBody => {
  if (isRunnerIpcError(error)) {
    return {
      code: error.code,
      message: error.message,
      ...(error.detail === undefined ? {} : { detail: error.detail }),
    };
  }
  if (isJobStoreError(error)) {
    return {
      code: error.code,
      message: error.message,
      ...(error.detail === undefined ? {} : { detail: error.detail }),
    };
  }
  // No stack on the wire. A local peer already knows where the Runner lives; the
  // stack only adds paths and internals to whatever is reading the reply.
  return { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) };
};
