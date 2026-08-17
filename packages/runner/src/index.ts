/**
 * @waterx/predict-agent-runner — the self-hosted local Runner.
 *
 * What ships here today is the durable half: the SQLite/WAL job store behind a
 * store interface, the job state machine, leases and heartbeats, and crash
 * recovery into `UNKNOWN_PENDING`. There is **no daemon and no IPC yet**, so
 * nothing in this package makes a job progress on its own — see the README and
 * `docs/IMPLEMENTATION_BACKLOG.md` 2.5/2.6 for exactly what is and is not built.
 *
 * The Runner is local and self-hosted. The device and the process must stay
 * awake, online and running; nothing here is a managed service (ADR-0001 §6).
 */
export { isJobStoreError, JobStoreError, type JobStoreErrorCode } from './errors.ts';
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
