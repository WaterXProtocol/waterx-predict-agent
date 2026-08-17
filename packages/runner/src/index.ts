/**
 * @waterx/predict-agent-runner — the self-hosted local Runner.
 *
 * What ships here today: the SQLite/WAL job store behind a store interface, the
 * job state machine, crash recovery into `UNKNOWN_PENDING`, the daemon process,
 * its authenticated local IPC socket, the heartbeat/lease supervisor that stops
 * a fenced-out Runner from writing, `reconcileJob`, which resolves an
 * `UNKNOWN_PENDING` job from an authoritative REST read, `StrategyService`:
 * create/get/list/cancel/events over the durable store, with mandatory capped
 * expiry, frozen-share percentage SELLs and an explicit dynamic fraction mode,
 * and — new — `driveJob`, which advances one job by one pass: watch, pause,
 * fresh authorization/market/position/quote checks at the trigger, independent
 * multi-leg create/sign/submit under per-leg idempotency keys, and reconcile —
 * and, new, `JobScheduler`, the loop that claims runnable jobs and calls
 * `driveJob` on each of them on a tick, so a job finally moves without anyone
 * asking it to.
 *
 * and, new, `QuoteStreamPriceObserver`, which answers a `PriceObserver` from the
 * SDK's indicative quote stream and reports nothing — never a remembered number
 * — the moment that feed can no longer prove it is live.
 *
 * What is still missing is the other collaborator a pass cannot happen without:
 * there is no signer behind `StrategySigner` in this package, only the
 * interface, and no local configuration from which a quote stream could be
 * opened. So a daemon started from `runnerd` supplies no `driver`, starts no
 * scheduler and advances nothing;
 * an embedding application that supplies all three gets a Runner that does. The
 * daemon reports which it is rather than implying — `driving` is read from
 * whether a scheduler is ticking, and `driverGaps` names what is absent when it
 * is not. Every agent command contract name is refused `NOT_IMPLEMENTED` on the
 * socket either way: this Runner drives durable jobs, not one-shot intents. See
 * the README and `docs/IMPLEMENTATION_BACKLOG.md` 2.6.
 *
 * The Runner is local and self-hosted. The device and the process must stay
 * awake, online and running; nothing here is a managed service (ADR-0001 §6).
 */
export { systemClock, type Clock } from './clock.ts';
export {
  installShutdownHandlers,
  RUNNER_DRIVER_GAPS,
  RunnerDaemon,
  type RunnerDaemonEvent,
  type RunnerDaemonHandle,
  type RunnerDaemonOptions,
} from './daemon.ts';
export { isJobStoreError, JobStoreError, type JobStoreErrorCode } from './errors.ts';
export {
  QuoteStreamPriceObserver,
  type PriceTopicStatus,
  type QuoteStreamPriceObserverOptions,
} from './prices.ts';
export { RunnerIpcClient, type RunnerIpcClientOptions } from './ipc/client.ts';
export {
  listRunnerIpcCommands,
  RUNNER_IPC_COMMANDS,
  validateRunnerCommand,
} from './ipc/commands.ts';
export { dispatch, toErrorBody, type RunnerCommandContext } from './ipc/dispatch.ts';
export {
  decodeClientFrame,
  decodeServerFrame,
  encodeFrame,
  FrameReader,
  isRunnerIpcError,
  MAX_FRAME_BYTES,
  RUNNER_IPC_PROTOCOL_VERSION,
  RunnerIpcError,
  tokensMatch,
  UNSOLICITED_FRAME_ID,
  type ClientFrame,
  type HelloFrame,
  type HelloOkFrame,
  type RequestFrame,
  type ResponseErrorBody,
  type ResponseFrame,
  type RunnerIpcErrorCode,
  type ServerFrame,
} from './ipc/protocol.ts';
export {
  assertPrivatePath,
  assertSocketPathLength,
  assertUnixPlatform,
  ensureRuntimeDir,
  MAX_SOCKET_PATH_BYTES,
  mintIpcToken,
  readIpcToken,
  RUNTIME_DIR_MODE,
  SECRET_FILE_MODE,
  writeIpcToken,
} from './ipc/runtime-dir.ts';
export { RunnerIpcServer, type RunnerIpcServerOptions } from './ipc/server.ts';
export {
  LeaseKeeper,
  type HeldLease,
  type LeaseKeeperOptions,
  type LeaseLossReason,
} from './supervisor.ts';
export {
  fingerprintRequest,
  newAttemptId,
  newIdempotencyKey,
  newInstanceId,
  newJobId,
  newStrategyId,
} from './ids.ts';
export type {
  JobLeg,
  JobLegIntent,
  JobLegSizing,
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
export {
  reconcileJob,
  type ReconcileDisposition,
  type ReconcileGateway,
  type ReconcileJobOptions,
  type ReconcileResult,
} from './reconciler.ts';
export {
  classify,
  type RecoveredJob,
  type RecoveryDisposition,
  type RecoveryOptions,
  type RecoveryReport,
  recoverJobs,
} from './recovery.ts';
export {
  JobScheduler,
  type JobSchedulerOptions,
  type SchedulerDriver,
  type SchedulerEvent,
  type SchedulerTickReport,
} from './scheduler.ts';
export { assertNoSecrets, FORBIDDEN_STORE_KEYS } from './secrets.ts';
export {
  canEndLocally,
  canTransition,
  isInFlightJobState,
  isTerminalJobState,
  JOB_STATES,
  JOB_TRANSITIONS,
  type JobState,
  type JobStateEffect,
  type JobStateSpec,
} from './state-machine.ts';
export type {
  BeginSideEffectInput,
  ClaimJobInput,
  CompleteSideEffectInput,
  CreateJobInput,
  JobFilter,
  JobStore,
  LegPatch,
  RegisterInstanceInput,
  ReserveLegInput,
  TransitionInput,
  UpdateLegInput,
} from './store.ts';
export {
  buildStrategyEvents,
  type StrategyEvent,
  type StrategyEventKind,
  type StrategySideEffectEvent,
  type StrategyTransitionEvent,
} from './strategy/events.ts';
export {
  driveJob,
  verifyQuote,
  watchKeyOf,
  type DriveAction,
  type DriveJobOptions,
  type DriveLegReport,
  type DriveResult,
} from './strategy/driver.ts';
export { isStrategyError, StrategyError, type StrategyErrorCode } from './strategy/errors.ts';
export {
  buildCreateRequest,
  quoteRequestFor,
  sizeOf,
  type PriceObserver,
  type StrategyGateway,
  type StrategySigner,
  type WatchKey,
} from './strategy/gateway.ts';
export {
  BETA_MAX_EXPIRY_MS,
  normalizeStrategy,
  resolveExpiry,
  type NormalizeOptions,
  type NormalizedStrategy,
  type ResolvedExpiry,
  type StrategyLegRequest,
  type StrategyRequest,
  type StrategyTriggerRequest,
} from './strategy/intent.ts';
export {
  classifyMarket,
  type MarketDisposition,
  type MarketDispositionReason,
  type MarketLifecycleFacts,
  type MarketVerdict,
} from './strategy/lifecycle.ts';
export {
  checkMarkets,
  classifyAuthorization,
  marketsInvolved,
  permissionsNeeded,
  preflight,
  type LegSkip,
  type LegSkipReason,
  type PermissionsNeeded,
  type PreflightInput,
  type PreflightPauseReason,
  type PreflightStopReason,
  type PreflightVerdict,
  type PreparedLeg,
} from './strategy/preflight.ts';
export {
  findPosition,
  type FindPositionOptions,
  type PositionLookup,
  type StrategyPositionReader,
} from './strategy/positions.ts';
export {
  cancelStrategy,
  StrategyService,
  type CancelContext,
  type StrategyCancelResult,
  type StrategyDetail,
  type StrategyExpiry,
  type StrategyLeaseHolder,
  type StrategyListFilter,
  type StrategyServiceOptions,
  type StrategySummary,
} from './strategy/service.ts';
export { LATEST_SCHEMA_VERSION, MIGRATIONS, migrate } from './sqlite/migrations.ts';
export { SqliteJobStore, type SqliteJobStoreOptions } from './sqlite/store.ts';
