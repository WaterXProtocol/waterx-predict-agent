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
 * - `strategy.*` delegates to the **same** {@link StrategyService} an embedding
 *   application would construct. Not a re-implementation over the store: a second
 *   copy of sizing, expiry or cancellation here is how a socket client and a
 *   library client end up disagreeing about what "sell half" means.
 * - `strategy.create` takes its policy snapshot from `context.admissionPolicy` —
 *   this machine's configuration — and never from the request, which carries no
 *   `policy` field at all. A peer that could name its own mode would be granting
 *   itself the mandate.
 */
import type { Clock } from '../clock.ts';
import type { DrainController, DrainOptions } from '../drain.ts';
import { isJobStoreError, JobStoreError } from '../errors.ts';
import type { JobPolicySnapshot } from '../job.ts';
import type { PriceTopicStatus } from '../prices.ts';
import type { RecoveryReport } from '../recovery.ts';
import type { JobState } from '../state-machine.ts';
import type { JobStore } from '../store.ts';
import { isStrategyError } from '../strategy/errors.ts';
import type { StrategyRequest } from '../strategy/intent.ts';
import { cancelStrategy, type StrategyService } from '../strategy/service.ts';
import type { LeaseKeeper } from '../supervisor.ts';
import { validateRunnerCommand } from './commands.ts';
import {
  isRunnerIpcError,
  RunnerIpcError,
  RUNNER_IPC_PROTOCOL_VERSION,
  type ResponseErrorBody,
} from './protocol.ts';

export interface RunnerCommandContext {
  readonly store: JobStore;
  readonly instanceId: string;
  readonly pid: number;
  readonly host: string;
  readonly startedAt: string;
  readonly now: Clock;
  readonly leases: LeaseKeeper;
  /**
   * The one strategy implementation this process has. Shared with any embedder,
   * so the socket cannot acquire its own rules.
   */
  readonly strategies: StrategyService;
  /**
   * The mandate a job created over this socket is admitted under, resolved from
   * local configuration at start-up. Requests never contribute to it.
   */
  readonly admissionPolicy: JobPolicySnapshot;
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
  /**
   * The drain state of this process. Held by the daemon rather than reconstructed
   * here, because the scheduler consults the same object before it claims: one
   * answer to "may this Runner take new work", not two that can disagree.
   */
  readonly drain: DrainController;
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
    case 'runner.drain':
      return drain(input, context);
    case 'runner.shutdown': {
      const reason = typeof input['reason'] === 'string' ? input['reason'] : 'IPC_REQUEST';
      context.requestShutdown(reason);
      return { stopping: true, instanceId: context.instanceId, reason };
    }
    case 'strategy.create':
      return createStrategy(input, context);
    case 'strategy.get':
      return getStrategy(input, context);
    case 'strategy.list':
      return listStrategies(input, context);
    // Two names, one implementation. `runner.cancel-job` is the lifecycle-shaped
    // name and this is the strategy-shaped one; they must not diverge.
    case 'strategy.cancel':
      return cancelJob(input, context);
    case 'strategy.events':
      return strategyEvents(input, context);
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
    // `null` while admission is open. Non-null means this Runner is leaving and
    // has already refused at least one door, which a client polling status must
    // see without having to call `runner.drain` to find out.
    draining: await context.drain.state(),
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

/**
 * Close admission and wait, then answer with what settled and what did not.
 *
 * The reply is the whole point of the command: an operator deciding whether it is
 * safe to stop the process needs `settled` and, when it is false, the attempts
 * that are still open. A drain that reported only success would be a sleep.
 */
const drain = async (
  input: Readonly<Record<string, unknown>>,
  context: RunnerCommandContext,
): Promise<unknown> => {
  const deadlineMs = input['deadlineMs'];
  const pollIntervalMs = input['pollIntervalMs'];
  const options: DrainOptions = {
    ...(typeof deadlineMs === 'number' ? { deadlineMs } : {}),
    ...(typeof pollIntervalMs === 'number' ? { pollIntervalMs } : {}),
  };
  return await context.drain.drain(options);
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
 * Arm a durable strategy, under this machine's mandate.
 *
 * The reply carries `driving` and `driverGaps` beside the job, because a Runner
 * that is not driving accepts this call and writes a real, durable job that
 * nothing will ever advance. A client that printed only the job id would be
 * telling its user a strategy is watching the market when no part of this process
 * is watching anything.
 */
const createStrategy = async (
  input: Readonly<Record<string, unknown>>,
  context: RunnerCommandContext,
): Promise<unknown> => {
  if (!context.drain.admitting) {
    // The refusal a drain exists to make possible. Before this existed the socket
    // simply closed, and a caller could not tell a planned upgrade from a crash —
    // so it could not tell "your strategy was not armed" from "your strategy may
    // have been armed". Named, so it can.
    throw new RunnerIpcError(
      'RUNNER_DRAINING',
      `this Runner stopped admitting work at ${context.drain.beganAt ?? 'an earlier instant'} and is finishing what it holds; the strategy was NOT armed. Arm it against the Runner that replaces this one.`,
      { beganAt: context.drain.beganAt ?? null, instanceId: context.instanceId },
    );
  }
  const expiresAt = input['expiresAt'];
  const strategyId = input['strategyId'];
  const request: StrategyRequest = {
    ...(typeof strategyId === 'string' ? { strategyId } : {}),
    ownerAddress: input['ownerAddress'] as string,
    accountId: input['accountId'] as string,
    agentWallet: input['agentWallet'] as string,
    legs: input['legs'] as StrategyRequest['legs'],
    trigger: input['trigger'] as StrategyRequest['trigger'],
    ...(expiresAt === undefined
      ? // Passed through absent rather than defaulted, so the service answers
        // `EXPIRY_REQUIRED` — the rule, named — instead of this layer inventing a
        // horizon nobody asked for.
        {}
      : { expiresAt: expiresAt as NonNullable<StrategyRequest['expiresAt']> }),
    // Deliberately not read from the request — there is no such input. The
    // mandate is configuration on this host; see the file header.
    policy: context.admissionPolicy,
  };

  const strategy = await context.strategies.create(request);
  return {
    strategy,
    policy: { mode: context.admissionPolicy.mode, source: context.admissionPolicy.source },
    driving: context.driving,
    driverGaps: [...context.driverGaps],
  };
};

const getStrategy = async (
  input: Readonly<Record<string, unknown>>,
  context: RunnerCommandContext,
): Promise<unknown> => {
  const jobId = input['jobId'] as string;
  const strategy = await context.strategies.get(jobId);
  if (strategy === undefined) {
    throw new JobStoreError('UNKNOWN_JOB', `unknown job ${jobId}`, { jobId });
  }
  return { strategy, leasedHere: context.leases.isHeld(jobId) };
};

const listStrategies = async (
  input: Readonly<Record<string, unknown>>,
  context: RunnerCommandContext,
): Promise<unknown> => {
  const accountId = input['accountId'];
  const strategyId = input['strategyId'];
  const state = input['state'];
  const strategies = await context.strategies.list({
    ...(typeof accountId === 'string' ? { accountId } : {}),
    ...(typeof strategyId === 'string' ? { strategyId } : {}),
    ...(typeof state === 'string' ? { states: [state as JobState] } : {}),
  });
  return { strategies };
};

/**
 * The transition and side-effect feed for one job.
 *
 * The presence check is here rather than in the service, which answers `[]` for
 * a job it has never heard of — correct for a library caller merging feeds, and
 * wrong for a socket, where an empty list would let a typo'd id read as a job
 * that simply has not done anything yet.
 */
const strategyEvents = async (
  input: Readonly<Record<string, unknown>>,
  context: RunnerCommandContext,
): Promise<unknown> => {
  const jobId = input['jobId'] as string;
  const record = await context.store.getJob(jobId);
  if (record === undefined) {
    throw new JobStoreError('UNKNOWN_JOB', `unknown job ${jobId}`, { jobId });
  }
  return { jobId, state: record.state, events: await context.strategies.events(jobId) };
};

/**
 * Maps a thrown value onto the wire error body.
 *
 * Store refusals keep their own codes — `ILLEGAL_TRANSITION`, `LEASE_LOST`,
 * `NO_IDEMPOTENCY_KEY` — because those name rules a caller must branch on, and
 * flattening them into `INTERNAL` would turn a refusal that protects funds into
 * an unexplained failure. Strategy refusals are the same argument twice over:
 * `SIZE_AMBIGUOUS`, `EXPIRY_TOO_FAR` and `POLICY_REQUIRES_DELEGATION` each tell
 * the caller what to change, and none of them is fixed by retrying.
 */
export const toErrorBody = (error: unknown): ResponseErrorBody => {
  if (isStrategyError(error)) {
    return {
      code: error.code,
      message: error.message,
      ...(error.detail === undefined ? {} : { detail: error.detail }),
    };
  }
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
