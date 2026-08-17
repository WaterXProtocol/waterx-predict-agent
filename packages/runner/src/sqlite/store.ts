/**
 * The SQLite/WAL job store (ADR-0001 §8, plan §6.4).
 *
 * Why SQLite at all: funds-moving state needs transactions, unique constraints
 * and a defined recovery story after an unclean shutdown. Rewriting a JSON file
 * has none of the three — a crash mid-write leaves a truncated document, and
 * nothing stops two writers from producing two idempotency keys for one order.
 *
 * Why `node:sqlite` rather than a native package: this module lives inside the
 * signer's trust boundary, so its dependency surface is a security property, not
 * just an install cost. `node:sqlite` is part of the runtime — no compiler, no
 * postinstall script, no third party in the process that holds the keys. The
 * price is a Node floor of 24 for this package, higher than the SDK's 20; that
 * is recorded in ADR-0007 and stated in the README rather than inferred.
 *
 * Pragmas, and why these:
 *
 * - `journal_mode = WAL`, so a reader (`runner status`, the CLI) never blocks
 *   the writer that is mid-order.
 * - `synchronous = FULL`. NORMAL lets the last transactions go missing after a
 *   power loss, and "the last transaction" here is routinely the idempotency key
 *   written immediately before the order that uses it. Losing exactly that row
 *   is the crash this store exists to survive, so the fsync is bought.
 * - `foreign_keys = ON`, so an attempt cannot outlive the leg whose key it
 *   claims to be replaying.
 * - `busy_timeout`, so a concurrent reader gets a wait rather than SQLITE_BUSY.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { JobStoreError } from '../errors.ts';
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
} from '../job.ts';
import { assertNoSecrets } from '../secrets.ts';
import { canTransition, JOB_STATES, type JobState } from '../state-machine.ts';
import type {
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
} from '../store.ts';
import { migrate } from './migrations.ts';

export interface SqliteJobStoreOptions {
  /** File path. A parent directory is created if missing. */
  readonly path: string;
  /**
   * Milliseconds a writer waits for a competing lock before failing. Concurrency
   * here is a reader and one Runner, not a fleet, so this is short.
   */
  readonly busyTimeoutMs?: number;
}

type Row = Record<string, unknown>;

const text = (row: Row, column: string): string => {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new JobStoreError('INVALID_INPUT', `column ${column} is not text`);
  }
  return value;
};

const nullableText = (row: Row, column: string): string | null => {
  const value = row[column];
  return typeof value === 'string' ? value : null;
};

const integer = (row: Row, column: string): number => {
  const value = row[column];
  if (typeof value === 'bigint') return Number(value);
  if (typeof value !== 'number') {
    throw new JobStoreError('INVALID_INPUT', `column ${column} is not an integer`);
  }
  return value;
};

const parseJson = <T>(raw: string): T => JSON.parse(raw) as T;

const encodeJson = (value: unknown): string => {
  assertNoSecrets(value);
  return JSON.stringify(value);
};

/**
 * SQLite names the *column* in a uniqueness failure, not the index — the message
 * is `UNIQUE constraint failed: job_legs.idempotency_key` — so the caller passes
 * the qualified column rather than the index it created.
 */
const isUniqueViolation = (error: unknown, column: string): boolean =>
  error instanceof Error && error.message.includes(`UNIQUE constraint failed: ${column}`);

export class SqliteJobStore implements JobStore {
  readonly kind = 'sqlite';

  private readonly db: DatabaseSync;

  constructor(options: SqliteJobStoreOptions) {
    const directory = dirname(options.path);
    if (directory && directory !== '.') mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(options.path);
    this.db.exec(`PRAGMA busy_timeout = ${String(options.busyTimeoutMs ?? 5_000)}`);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec('PRAGMA foreign_keys = ON');
    migrate(this.db);
  }

  // ---------------------------------------------------------------- instances

  async registerInstance(input: RegisterInstanceInput): Promise<RunnerInstance> {
    return this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO runner_instances(instance_id, pid, host, started_at, heartbeat_at, stopped_at)
           VALUES(?, ?, ?, ?, ?, NULL)
           ON CONFLICT(instance_id) DO UPDATE SET
             pid = excluded.pid,
             host = excluded.host,
             heartbeat_at = excluded.heartbeat_at,
             stopped_at = NULL`,
        )
        .run(input.instanceId, input.pid, input.host, input.at, input.at);
      return this.requireInstance(input.instanceId);
    });
  }

  async heartbeat(instanceId: string, at: string): Promise<RunnerInstance> {
    return this.tx(() => {
      const changed = this.db
        .prepare('UPDATE runner_instances SET heartbeat_at = ? WHERE instance_id = ?')
        .run(at, instanceId);
      if (changed.changes === 0) {
        throw new JobStoreError('INVALID_INPUT', `unknown runner instance ${instanceId}`);
      }
      return this.requireInstance(instanceId);
    });
  }

  async stopInstance(instanceId: string, at: string): Promise<void> {
    this.tx(() => {
      // A clean stop releases every lease this instance held, so the next Runner
      // does not have to wait out a TTL for a job nobody is running. The fence is
      // untouched: releasing is not claiming.
      this.db
        .prepare(
          `UPDATE jobs SET lease_instance_id = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE lease_instance_id = ?`,
        )
        .run(at, instanceId);
      this.db
        .prepare('UPDATE runner_instances SET stopped_at = ?, heartbeat_at = ? WHERE instance_id = ?')
        .run(at, at, instanceId);
    });
  }

  async listInstances(): Promise<readonly RunnerInstance[]> {
    const rows = this.db
      .prepare('SELECT * FROM runner_instances ORDER BY started_at ASC, instance_id ASC')
      .all() as Row[];
    return rows.map(toInstance);
  }

  // --------------------------------------------------------------------- jobs

  async createJob(input: CreateJobInput): Promise<JobRecord> {
    if (input.intent.length === 0) {
      throw new JobStoreError('INVALID_INPUT', 'a job needs at least one leg intent');
    }
    if (!Number.isFinite(Date.parse(input.expiresAt))) {
      // ADR-0005: `expiresAt` is mandatory. A job with an unreadable expiry would
      // be a permanent watcher, which is the thing that decision forbids.
      throw new JobStoreError('INVALID_INPUT', 'expiresAt must be an ISO-8601 instant');
    }
    return this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO jobs(
             job_id, strategy_id, owner_address, account_id, agent_wallet, state,
             intent_json, trigger_json, policy_json, created_at, updated_at, expires_at,
             lease_instance_id, lease_expires_at, lease_fence, cancel_requested_at,
             cancel_reason, terminal_at)
           VALUES(?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL, NULL, NULL)`,
        )
        .run(
          input.jobId,
          input.strategyId,
          input.ownerAddress,
          input.accountId,
          input.agentWallet,
          encodeJson(input.intent),
          encodeJson(input.trigger),
          encodeJson(input.policy),
          input.at,
          input.at,
          input.expiresAt,
        );
      this.appendTransition({
        jobId: input.jobId,
        fromState: null,
        toState: 'DRAFT',
        reason: 'JOB_CREATED',
        instanceId: null,
        at: input.at,
        detail: null,
      });
      return this.requireJob(input.jobId);
    });
  }

  async getJob(jobId: string): Promise<JobRecord | undefined> {
    const row = this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId) as
      | Row
      | undefined;
    return row === undefined ? undefined : toJob(row);
  }

  async listJobs(filter: JobFilter = {}): Promise<readonly JobRecord[]> {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (filter.states !== undefined && filter.states.length > 0) {
      clauses.push(`state IN (${filter.states.map(() => '?').join(', ')})`);
      params.push(...filter.states);
    }
    if (filter.accountId !== undefined) {
      clauses.push('account_id = ?');
      params.push(filter.accountId);
    }
    if (filter.unleasedAt !== undefined) {
      clauses.push('(lease_instance_id IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)');
      params.push(filter.unleasedAt);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM jobs${where} ORDER BY created_at ASC, job_id ASC`)
      .all(...params) as Row[];
    return rows.map(toJob);
  }

  async requestCancel(jobId: string, reason: string, at: string): Promise<JobRecord> {
    return this.tx(() => {
      const job = this.requireJob(jobId);
      if (JOB_STATES[job.state].terminal) {
        throw new JobStoreError(
          'ILLEGAL_TRANSITION',
          `job ${jobId} is already ${job.state}; a cancellation cannot reach it`,
          { state: job.state },
        );
      }
      // Recorded, not applied. Only the lease holder ends a job, and only from a
      // state that has not started a write — a "cancelled" reply while a submit
      // is in flight would report a stop that did not happen (ADR-0001 §15).
      this.db
        .prepare(
          `UPDATE jobs SET cancel_requested_at = COALESCE(cancel_requested_at, ?),
             cancel_reason = COALESCE(cancel_reason, ?), updated_at = ?
           WHERE job_id = ?`,
        )
        .run(at, reason, at, jobId);
      return this.requireJob(jobId);
    });
  }

  // ------------------------------------------------------------------- leases

  async claimJob(input: ClaimJobInput): Promise<JobLease | undefined> {
    return this.tx(() => {
      // Ahead of the foreign key, so an unregistered instance reads as a store
      // error naming the instance rather than as `FOREIGN KEY constraint failed`.
      this.requireInstance(input.instanceId);
      const job = this.requireJob(input.jobId);
      if (JOB_STATES[job.state].terminal) return undefined;
      const heldByAnother =
        job.leaseInstanceId !== null && job.leaseInstanceId !== input.instanceId;
      const stillLive =
        job.leaseExpiresAt !== null && Date.parse(job.leaseExpiresAt) > Date.parse(input.at);
      if (heldByAnother && stillLive) return undefined;
      const fence = job.leaseFence + 1;
      const expiresAt = new Date(Date.parse(input.at) + input.leaseTtlMs).toISOString();
      this.db
        .prepare(
          `UPDATE jobs SET lease_instance_id = ?, lease_expires_at = ?, lease_fence = ?, updated_at = ?
           WHERE job_id = ? AND lease_fence = ?`,
        )
        .run(input.instanceId, expiresAt, fence, input.at, input.jobId, job.leaseFence);
      return { jobId: input.jobId, instanceId: input.instanceId, fence, expiresAt };
    });
  }

  async renewLease(lease: JobLease, at: string, leaseTtlMs: number): Promise<JobLease> {
    return this.tx(() => {
      this.assertLease(lease);
      const expiresAt = new Date(Date.parse(at) + leaseTtlMs).toISOString();
      // Renewal does not bump the fence: it is the same claim, extended. Bumping
      // would invalidate the lease the caller is holding in a local variable.
      this.db
        .prepare('UPDATE jobs SET lease_expires_at = ?, updated_at = ? WHERE job_id = ?')
        .run(expiresAt, at, lease.jobId);
      return { ...lease, expiresAt };
    });
  }

  async releaseJob(lease: JobLease, at: string): Promise<void> {
    this.tx(() => {
      this.assertLease(lease);
      this.db
        .prepare(
          `UPDATE jobs SET lease_instance_id = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE job_id = ?`,
        )
        .run(at, lease.jobId);
    });
  }

  // -------------------------------------------------------------- transitions

  async transition(input: TransitionInput): Promise<JobRecord> {
    return this.tx(() => {
      this.assertLease(input.lease);
      const job = this.requireJob(input.lease.jobId);
      if (!canTransition(job.state, input.to)) {
        throw new JobStoreError(
          'ILLEGAL_TRANSITION',
          `job ${job.jobId} cannot move ${job.state} -> ${input.to}`,
          { from: job.state, to: input.to },
        );
      }
      if (JOB_STATES[input.to].requiresLeg && this.countLegs(job.jobId) === 0) {
        // The store-enforced half of "persist before the side effect": a state
        // whose next act may create or submit an order is unreachable until the
        // idempotency key for the leg is on disk.
        throw new JobStoreError(
          'NO_IDEMPOTENCY_KEY',
          `job ${job.jobId} cannot enter ${input.to} before a leg and its idempotency key are persisted`,
          { to: input.to },
        );
      }
      const terminal = JOB_STATES[input.to].terminal;
      this.db
        .prepare(
          `UPDATE jobs SET state = ?, updated_at = ?, terminal_at = ?,
             lease_instance_id = CASE WHEN ? THEN NULL ELSE lease_instance_id END,
             lease_expires_at = CASE WHEN ? THEN NULL ELSE lease_expires_at END
           WHERE job_id = ?`,
        )
        .run(
          input.to,
          input.at,
          terminal ? input.at : null,
          terminal ? 1 : 0,
          terminal ? 1 : 0,
          job.jobId,
        );
      this.appendTransition({
        jobId: job.jobId,
        fromState: job.state,
        toState: input.to,
        reason: input.reason,
        instanceId: input.lease.instanceId,
        at: input.at,
        detail: input.detail ?? null,
      });
      return this.requireJob(job.jobId);
    });
  }

  async listTransitions(jobId: string): Promise<readonly JobTransitionRecord[]> {
    const rows = this.db
      .prepare('SELECT * FROM job_transitions WHERE job_id = ? ORDER BY seq ASC')
      .all(jobId) as Row[];
    return rows.map(toTransition);
  }

  // --------------------------------------------------------------------- legs

  async reserveLeg(input: ReserveLegInput): Promise<JobLeg> {
    return this.tx(() => {
      this.assertLease(input.lease);
      const existing = this.findLeg(input.lease.jobId, input.legIndex);
      if (existing !== undefined) {
        // Reserving twice is how a restarted Runner picks a leg back up. The same
        // key is the same intent; a different one would be a second logical order
        // wearing the first one's leg index.
        if (existing.idempotencyKey !== input.idempotencyKey) {
          throw new JobStoreError(
            'REPLAY_MISMATCH',
            `leg ${String(input.legIndex)} of job ${input.lease.jobId} already holds a different idempotency key`,
            { legIndex: input.legIndex },
          );
        }
        return existing;
      }
      const intentJson = encodeJson(input.intent);
      try {
        this.db
          .prepare(
            `INSERT INTO job_legs(
               job_id, leg_index, idempotency_key, intent_json, status,
               reference_quote_id, submission_quote_id, quoted_at, execution_id,
               submission_digest, keeper_digest, created_at, updated_at)
             VALUES(?, ?, ?, ?, 'PENDING', NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
          )
          .run(
            input.lease.jobId,
            input.legIndex,
            input.idempotencyKey,
            intentJson,
            input.at,
            input.at,
          );
      } catch (error) {
        if (isUniqueViolation(error, 'job_legs.idempotency_key')) {
          throw new JobStoreError(
            'DUPLICATE_IDEMPOTENCY_KEY',
            'that idempotency key already belongs to another leg',
            { legIndex: input.legIndex },
          );
        }
        throw error;
      }
      return this.requireLeg(input.lease.jobId, input.legIndex);
    });
  }

  async listLegs(jobId: string): Promise<readonly JobLeg[]> {
    const rows = this.db
      .prepare('SELECT * FROM job_legs WHERE job_id = ? ORDER BY leg_index ASC')
      .all(jobId) as Row[];
    return rows.map(toLeg);
  }

  async updateLeg(input: UpdateLegInput): Promise<JobLeg> {
    return this.tx(() => {
      this.assertLease(input.lease);
      return this.patchLeg(input.lease.jobId, input.legIndex, input, input.at);
    });
  }

  // ------------------------------------------------------------- side effects

  async beginSideEffect(input: BeginSideEffectInput): Promise<SideEffectAttempt> {
    return this.tx(() => {
      this.assertLease(input.lease);
      const leg = this.findLeg(input.lease.jobId, input.legIndex);
      if (leg === undefined) {
        throw new JobStoreError(
          'NO_IDEMPOTENCY_KEY',
          `leg ${String(input.legIndex)} of job ${input.lease.jobId} has no persisted idempotency key; nothing may be sent for it`,
          { legIndex: input.legIndex },
        );
      }
      const open = this.findOpenAttempt(input.lease.jobId, input.legIndex);
      if (open !== undefined) {
        // A replay of the same request reuses the open attempt rather than
        // opening a second one — that is what makes "at most one logical
        // execution" survive a crash mid-request.
        if (open.kind !== input.kind) {
          throw new JobStoreError(
            'OPEN_SIDE_EFFECT',
            `leg ${String(input.legIndex)} still has an unresolved ${open.kind}; resolve it before starting a ${input.kind}`,
            { attemptId: open.attemptId, kind: open.kind },
          );
        }
        if (open.requestFingerprint !== input.requestFingerprint) {
          throw new JobStoreError(
            'REPLAY_MISMATCH',
            `replaying ${open.kind} for leg ${String(input.legIndex)} requires the exact bytes of the first attempt`,
            { attemptId: open.attemptId },
          );
        }
        return open;
      }
      this.db
        .prepare(
          `INSERT INTO side_effects(
             attempt_id, job_id, leg_index, kind, idempotency_key, request_fingerprint,
             instance_id, started_at, outcome, outcome_at, detail_json)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
        )
        .run(
          input.attemptId,
          input.lease.jobId,
          input.legIndex,
          input.kind,
          // Copied from the leg, never taken from the caller: an attempt cannot
          // carry a key the leg did not mint.
          leg.idempotencyKey,
          input.requestFingerprint,
          input.lease.instanceId,
          input.at,
        );
      return this.requireAttempt(input.attemptId);
    });
  }

  async completeSideEffect(input: CompleteSideEffectInput): Promise<SideEffectAttempt> {
    return this.tx(() => {
      this.assertLease(input.lease);
      const attempt = this.requireAttempt(input.attemptId);
      if (attempt.outcome !== null) {
        throw new JobStoreError(
          'UNKNOWN_SIDE_EFFECT',
          `attempt ${input.attemptId} is already ${attempt.outcome}`,
          { attemptId: input.attemptId },
        );
      }
      this.db
        .prepare('UPDATE side_effects SET outcome = ?, outcome_at = ?, detail_json = ? WHERE attempt_id = ?')
        .run(
          input.outcome,
          input.at,
          input.detail === undefined ? null : encodeJson(input.detail),
          input.attemptId,
        );
      // Same transaction as the outcome: see `CompleteSideEffectInput.leg`.
      if (input.leg !== undefined) {
        this.patchLeg(attempt.jobId, attempt.legIndex, input.leg, input.at);
      }
      return this.requireAttempt(input.attemptId);
    });
  }

  async listOpenSideEffects(jobId?: string): Promise<readonly SideEffectAttempt[]> {
    const rows =
      jobId === undefined
        ? (this.db
            .prepare('SELECT * FROM side_effects WHERE outcome IS NULL ORDER BY started_at ASC')
            .all() as Row[])
        : (this.db
            .prepare(
              'SELECT * FROM side_effects WHERE job_id = ? AND outcome IS NULL ORDER BY started_at ASC',
            )
            .all(jobId) as Row[]);
    return rows.map(toAttempt);
  }

  async listSideEffects(jobId: string): Promise<readonly SideEffectAttempt[]> {
    const rows = this.db
      .prepare('SELECT * FROM side_effects WHERE job_id = ? ORDER BY started_at ASC, attempt_id ASC')
      .all(jobId) as Row[];
    return rows.map(toAttempt);
  }

  // ------------------------------------------------------------------ cursors

  async saveCursor(scope: string, cursor: string, at: string): Promise<string> {
    if (!/^\d+$/u.test(cursor)) {
      // Mirrors the SDK stream client: a malformed cursor is not a cursor, and
      // persisting one would make the next reconnect ask for a window that does
      // not exist.
      throw new JobStoreError('INVALID_INPUT', 'a stream cursor is a decimal digit string');
    }
    return this.tx(() => {
      const row = this.db.prepare('SELECT cursor FROM stream_cursors WHERE scope = ?').get(scope) as
        | Row
        | undefined;
      if (row !== undefined) {
        const held = text(row, 'cursor');
        if (BigInt(cursor) < BigInt(held)) {
          throw new JobStoreError(
            'CURSOR_REWIND',
            `stream cursor for ${scope} may not move backwards`,
            { held, offered: cursor },
          );
        }
        if (BigInt(cursor) === BigInt(held)) return held;
      }
      this.db
        .prepare(
          `INSERT INTO stream_cursors(scope, cursor, updated_at) VALUES(?, ?, ?)
           ON CONFLICT(scope) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
        )
        .run(scope, cursor, at);
      return cursor;
    });
  }

  async readCursor(scope: string): Promise<string | undefined> {
    const row = this.db.prepare('SELECT cursor FROM stream_cursors WHERE scope = ?').get(scope) as
      | Row
      | undefined;
    return row === undefined ? undefined : text(row, 'cursor');
  }

  async close(): Promise<void> {
    this.db.close();
  }

  // ------------------------------------------------------------------ private

  private tx<T>(body: () => T): T {
    // IMMEDIATE, not DEFERRED: every one of these reads a row and writes it back,
    // so taking the write lock up front turns a lost update into a wait.
    this.db.exec('BEGIN IMMEDIATE');
    let result: T;
    try {
      result = body();
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // A rollback that fails because the transaction already aborted must not
        // replace the error that caused it.
      }
      throw error;
    }
    this.db.exec('COMMIT');
    return result;
  }

  /**
   * The fencing check. The fence, not the clock, is what makes a stale writer
   * fail: an expired lease that nobody reclaimed still has the original fence, so
   * its holder may finish safely, while a lease someone else claimed has a higher
   * one and every write under the old value is refused.
   */
  private assertLease(lease: JobLease): void {
    const job = this.requireJob(lease.jobId);
    if (job.leaseInstanceId !== lease.instanceId || job.leaseFence !== lease.fence) {
      throw new JobStoreError(
        'LEASE_LOST',
        `job ${lease.jobId} is no longer held by ${lease.instanceId} at fence ${String(lease.fence)}`,
        { heldBy: job.leaseInstanceId, fence: job.leaseFence },
      );
    }
  }

  private appendTransition(record: {
    jobId: string;
    fromState: JobState | null;
    toState: JobState;
    reason: string;
    instanceId: string | null;
    at: string;
    detail: Readonly<Record<string, unknown>> | null;
  }): void {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM job_transitions WHERE job_id = ?')
      .get(record.jobId) as Row;
    this.db
      .prepare(
        `INSERT INTO job_transitions(job_id, seq, from_state, to_state, reason, instance_id, at, detail_json)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.jobId,
        integer(row, 'seq') + 1,
        record.fromState,
        record.toState,
        record.reason,
        record.instanceId,
        record.at,
        record.detail === null ? null : encodeJson(record.detail),
      );
  }

  /** Caller must already hold the transaction and have asserted the lease. */
  private patchLeg(jobId: string, legIndex: number, patch: LegPatch, at: string): JobLeg {
    this.requireLeg(jobId, legIndex);
    const assignments: string[] = ['updated_at = ?'];
    const params: (string | number)[] = [at];
    const set = (column: string, value: string | undefined): void => {
      if (value === undefined) return;
      assignments.push(`${column} = ?`);
      params.push(value);
    };
    set('status', patch.status);
    set('reference_quote_id', patch.referenceQuoteId);
    set('submission_quote_id', patch.submissionQuoteId);
    set('quoted_at', patch.quotedAt);
    set('execution_id', patch.executionId);
    set('submission_digest', patch.submissionDigest);
    set('keeper_digest', patch.keeperDigest);
    params.push(jobId, legIndex);
    try {
      this.db
        .prepare(`UPDATE job_legs SET ${assignments.join(', ')} WHERE job_id = ? AND leg_index = ?`)
        .run(...params);
    } catch (error) {
      if (isUniqueViolation(error, 'job_legs.execution_id')) {
        throw new JobStoreError(
          'DUPLICATE_EXECUTION',
          'that execution id already backs another leg',
          { legIndex },
        );
      }
      throw error;
    }
    return this.requireLeg(jobId, legIndex);
  }

  private countLegs(jobId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS legs FROM job_legs WHERE job_id = ?')
      .get(jobId) as Row;
    return integer(row, 'legs');
  }

  private findLeg(jobId: string, legIndex: number): JobLeg | undefined {
    const row = this.db
      .prepare('SELECT * FROM job_legs WHERE job_id = ? AND leg_index = ?')
      .get(jobId, legIndex) as Row | undefined;
    return row === undefined ? undefined : toLeg(row);
  }

  private findOpenAttempt(jobId: string, legIndex: number): SideEffectAttempt | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM side_effects WHERE job_id = ? AND leg_index = ? AND outcome IS NULL',
      )
      .get(jobId, legIndex) as Row | undefined;
    return row === undefined ? undefined : toAttempt(row);
  }

  private requireJob(jobId: string): JobRecord {
    const row = this.db.prepare('SELECT * FROM jobs WHERE job_id = ?').get(jobId) as Row | undefined;
    if (row === undefined) throw new JobStoreError('UNKNOWN_JOB', `unknown job ${jobId}`);
    return toJob(row);
  }

  private requireLeg(jobId: string, legIndex: number): JobLeg {
    const leg = this.findLeg(jobId, legIndex);
    if (leg === undefined) {
      throw new JobStoreError('UNKNOWN_LEG', `job ${jobId} has no leg ${String(legIndex)}`);
    }
    return leg;
  }

  private requireAttempt(attemptId: string): SideEffectAttempt {
    const row = this.db.prepare('SELECT * FROM side_effects WHERE attempt_id = ?').get(attemptId) as
      | Row
      | undefined;
    if (row === undefined) {
      throw new JobStoreError('UNKNOWN_SIDE_EFFECT', `unknown attempt ${attemptId}`);
    }
    return toAttempt(row);
  }

  private requireInstance(instanceId: string): RunnerInstance {
    const row = this.db
      .prepare('SELECT * FROM runner_instances WHERE instance_id = ?')
      .get(instanceId) as Row | undefined;
    if (row === undefined) {
      throw new JobStoreError('INVALID_INPUT', `unknown runner instance ${instanceId}`);
    }
    return toInstance(row);
  }
}

const toInstance = (row: Row): RunnerInstance => ({
  instanceId: text(row, 'instance_id'),
  pid: integer(row, 'pid'),
  host: text(row, 'host'),
  startedAt: text(row, 'started_at'),
  heartbeatAt: text(row, 'heartbeat_at'),
  stoppedAt: nullableText(row, 'stopped_at'),
});

const toJob = (row: Row): JobRecord => ({
  jobId: text(row, 'job_id'),
  strategyId: text(row, 'strategy_id'),
  ownerAddress: text(row, 'owner_address'),
  accountId: text(row, 'account_id'),
  agentWallet: text(row, 'agent_wallet'),
  state: text(row, 'state') as JobState,
  intent: parseJson<JobLegIntent[]>(text(row, 'intent_json')),
  trigger: parseJson<JobTrigger>(text(row, 'trigger_json')),
  policy: parseJson<JobPolicySnapshot>(text(row, 'policy_json')),
  createdAt: text(row, 'created_at'),
  updatedAt: text(row, 'updated_at'),
  expiresAt: text(row, 'expires_at'),
  leaseInstanceId: nullableText(row, 'lease_instance_id'),
  leaseExpiresAt: nullableText(row, 'lease_expires_at'),
  leaseFence: integer(row, 'lease_fence'),
  cancelRequestedAt: nullableText(row, 'cancel_requested_at'),
  cancelReason: nullableText(row, 'cancel_reason'),
  terminalAt: nullableText(row, 'terminal_at'),
});

const toLeg = (row: Row): JobLeg => ({
  jobId: text(row, 'job_id'),
  legIndex: integer(row, 'leg_index'),
  idempotencyKey: text(row, 'idempotency_key'),
  intent: parseJson<JobLegIntent>(text(row, 'intent_json')),
  status: text(row, 'status') as JobLegStatus,
  referenceQuoteId: nullableText(row, 'reference_quote_id'),
  submissionQuoteId: nullableText(row, 'submission_quote_id'),
  quotedAt: nullableText(row, 'quoted_at'),
  executionId: nullableText(row, 'execution_id'),
  submissionDigest: nullableText(row, 'submission_digest'),
  keeperDigest: nullableText(row, 'keeper_digest'),
  createdAt: text(row, 'created_at'),
  updatedAt: text(row, 'updated_at'),
});

const toAttempt = (row: Row): SideEffectAttempt => {
  const detail = nullableText(row, 'detail_json');
  return {
    attemptId: text(row, 'attempt_id'),
    jobId: text(row, 'job_id'),
    legIndex: integer(row, 'leg_index'),
    kind: text(row, 'kind') as SideEffectKind,
    idempotencyKey: text(row, 'idempotency_key'),
    requestFingerprint: text(row, 'request_fingerprint'),
    instanceId: text(row, 'instance_id'),
    startedAt: text(row, 'started_at'),
    outcome: nullableText(row, 'outcome') as SideEffectOutcome | null,
    outcomeAt: nullableText(row, 'outcome_at'),
    detail: detail === null ? null : parseJson<Record<string, unknown>>(detail),
  };
};

const toTransition = (row: Row): JobTransitionRecord => {
  const detail = nullableText(row, 'detail_json');
  return {
    jobId: text(row, 'job_id'),
    seq: integer(row, 'seq'),
    fromState: nullableText(row, 'from_state') as JobState | null,
    toState: text(row, 'to_state') as JobState,
    reason: text(row, 'reason'),
    instanceId: nullableText(row, 'instance_id'),
    at: text(row, 'at'),
    detail: detail === null ? null : parseJson<Record<string, unknown>>(detail),
  };
};
