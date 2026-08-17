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
 * and, new, `createExternalCommandSigner`, the signer inside the trust boundary:
 * it signs sponsored bytes through a keystore command that holds the key, only
 * for a job admitted under a `delegated-auto` policy, and refuses `interactive`
 * and `read-only` before it starts anything.
 *
 * and, new, `resolveRunnerConfig` and `buildRunnerDriver`: the configuration a
 * `runnerd` process reads from its environment and its runtime directory, and the
 * one place that turns it into the three collaborators a scheduler drives with. A
 * process configured with all of a base URL, an agent wallet and a keystore
 * command now starts a scheduler and reports `driving: true`. Anything missing
 * builds **no** driver at all — a gateway without a signer would create an order
 * it could not authorize — and names the missing piece in `driverGaps`, so an
 * operator is told what to set rather than what is absent.
 *
 * The daemon reports which it is rather than implying: `driving` is read from
 * whether a scheduler is ticking, `driverGaps` names what is missing when it is
 * not, and `runner.status` carries per-topic price health so a feed that has given
 * up cannot pass for a quiet market. Every agent command contract name is refused
 * `NOT_IMPLEMENTED` on the socket either way: this Runner drives durable jobs, not
 * one-shot intents.
 *
 * and, new, `strategy.create`, `strategy.get`, `strategy.list`, `strategy.cancel`
 * and `strategy.events` on that socket, served by the very `StrategyService` the
 * library exposes — one set of sizing, expiry and cancellation rules for a socket
 * client and an embedder alike. The mandate a job is admitted under comes from
 * this host's `policy` configuration and never from the request, which has no such
 * field: a peer that could name its own mode would be granting itself the
 * authority to sign unattended. The default is `interactive`, which refuses.
 * There is still no CLI for any of it (`docs/IMPLEMENTATION_BACKLOG.md` 2.8).
 *
 * The Runner is local and self-hosted. The device and the process must stay
 * awake, online and running; nothing here is a managed service (ADR-0001 §6).
 */
export { systemClock, type Clock } from './clock.ts';
export {
  createNodeRunnerConfigSources,
  describeRunnerConfig,
  isRunnerConfigError,
  resolveRunnerConfig,
  RUNNER_ENV_KEYS,
  RUNNER_FILE_KEYS,
  RUNNER_POLICY_KEYS,
  RUNNER_POLICY_MODES,
  RunnerConfigError,
  type RunnerConfig,
  type RunnerConfigDiagnostics,
  type RunnerConfigErrorCode,
  type RunnerConfigSources,
  type RunnerDriverConfig,
  type RunnerDriverGap,
  type RunnerEnv,
  type RunnerPolicyConfig,
  type RunnerPolicyMode,
} from './config.ts';
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
  RUNNER_IPC_PROTOCOL,
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
export {
  buildRunnerDriver,
  type BuildRunnerDriverOptions,
  type RunnerDriverBundle,
} from './runtime.ts';
export { assertNoSecrets, FORBIDDEN_STORE_KEYS } from './secrets.ts';
export {
  createChildProcessSignerRunner,
  createExternalCommandAuthSigner,
  createExternalCommandSigner,
  isPreSpawnRefusal,
  isSignerError,
  refusePolicy,
  signerExecutableName,
  SIGNER_PROTOCOL,
  SignerError,
  type ExternalCommandAuthSignerOptions,
  type ExternalCommandSignerOptions,
  type PolicyRefusal,
  type RunnerSignerRequest,
  type SignerErrorCode,
  type SignerRunResult,
  type SignerRunner,
} from './signer.ts';
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
  type StrategySignRequest,
  type StrategySigner,
  type WatchKey,
} from './strategy/gateway.ts';
export {
  BETA_MAX_EXPIRY_MS,
  isIsoInstant,
  normalizeStrategy,
  requirePolicyThatCanSignUnattended,
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
