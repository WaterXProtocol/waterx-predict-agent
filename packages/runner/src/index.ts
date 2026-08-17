/**
 * @waterx/predict-agent-runner — the self-hosted local Runner.
 *
 * What ships here today: the SQLite/WAL job store behind a store interface, the
 * job state machine, crash recovery into `UNKNOWN_PENDING`, the daemon process,
 * its authenticated local IPC socket, the heartbeat/lease supervisor that stops
 * a fenced-out Runner from writing, and — new — `reconcileJob`, which resolves an
 * `UNKNOWN_PENDING` job from an authoritative REST read.
 *
 * What is still missing is the part that makes a job *move*: there is no
 * executor and no signer, so nothing calls the reconciler on a schedule and a
 * recovered job sits in the state recovery assigned it. The daemon says so
 * rather than implying otherwise
 * — `driving: false` on the IPC handshake and in `runner.status`, and every agent
 * command contract name is refused `NOT_IMPLEMENTED`. See the README and
 * `docs/IMPLEMENTATION_BACKLOG.md` 2.6.
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
} from './ids.ts';
export type {
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
export { LATEST_SCHEMA_VERSION, MIGRATIONS, migrate } from './sqlite/migrations.ts';
export { SqliteJobStore, type SqliteJobStoreOptions } from './sqlite/store.ts';
