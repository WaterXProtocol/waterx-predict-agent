/**
 * Forward-only schema migrations, keyed on SQLite's `user_version`.
 *
 * Each step runs inside one transaction, so an interrupted upgrade leaves the
 * database at the previous version rather than half-migrated. A database whose
 * `user_version` is *higher* than this build knows is refused outright: an older
 * Runner writing rows into a newer schema is how a job silently loses the column
 * that says an order is in flight.
 */
import type { DatabaseSync } from 'node:sqlite';

import { JobStoreError } from '../errors.ts';

export interface Migration {
  readonly version: number;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE runner_instances (
        instance_id   TEXT PRIMARY KEY,
        pid           INTEGER NOT NULL,
        host          TEXT NOT NULL,
        started_at    TEXT NOT NULL,
        heartbeat_at  TEXT NOT NULL,
        stopped_at    TEXT
      ) STRICT;

      CREATE TABLE jobs (
        job_id              TEXT PRIMARY KEY,
        strategy_id         TEXT NOT NULL,
        owner_address       TEXT NOT NULL,
        account_id          TEXT NOT NULL,
        agent_wallet        TEXT NOT NULL,
        state               TEXT NOT NULL,
        intent_json         TEXT NOT NULL,
        trigger_json        TEXT NOT NULL,
        policy_json         TEXT NOT NULL,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        expires_at          TEXT NOT NULL,
        lease_instance_id   TEXT REFERENCES runner_instances(instance_id),
        lease_expires_at    TEXT,
        lease_fence         INTEGER NOT NULL DEFAULT 0,
        cancel_requested_at TEXT,
        cancel_reason       TEXT,
        terminal_at         TEXT
      ) STRICT;

      CREATE INDEX jobs_by_state ON jobs(state);
      CREATE INDEX jobs_by_account ON jobs(account_id);

      CREATE TABLE job_transitions (
        job_id      TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
        seq         INTEGER NOT NULL,
        from_state  TEXT,
        to_state    TEXT NOT NULL,
        reason      TEXT NOT NULL,
        instance_id TEXT,
        at          TEXT NOT NULL,
        detail_json TEXT,
        PRIMARY KEY (job_id, seq)
      ) STRICT;

      CREATE TABLE job_legs (
        job_id              TEXT NOT NULL REFERENCES jobs(job_id) ON DELETE CASCADE,
        leg_index           INTEGER NOT NULL,
        idempotency_key     TEXT NOT NULL,
        intent_json         TEXT NOT NULL,
        status              TEXT NOT NULL,
        reference_quote_id  TEXT,
        submission_quote_id TEXT,
        quoted_at           TEXT,
        execution_id        TEXT,
        submission_digest   TEXT,
        keeper_digest       TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        PRIMARY KEY (job_id, leg_index)
      ) STRICT;

      -- One key per logical order intent, globally. Two legs sharing a key would
      -- let the server dedupe the second one into the first and report a fill
      -- that belongs to a different order.
      CREATE UNIQUE INDEX job_legs_key ON job_legs(idempotency_key);
      -- And the converse: one execution can back only one leg.
      CREATE UNIQUE INDEX job_legs_execution
        ON job_legs(execution_id) WHERE execution_id IS NOT NULL;

      CREATE TABLE side_effects (
        attempt_id          TEXT PRIMARY KEY,
        job_id              TEXT NOT NULL,
        leg_index           INTEGER NOT NULL,
        kind                TEXT NOT NULL,
        idempotency_key     TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        instance_id         TEXT NOT NULL,
        started_at          TEXT NOT NULL,
        outcome             TEXT,
        outcome_at          TEXT,
        detail_json         TEXT,
        FOREIGN KEY (job_id, leg_index)
          REFERENCES job_legs(job_id, leg_index) ON DELETE CASCADE
      ) STRICT;

      -- At most one unresolved attempt per leg: a second in-flight request for
      -- one logical order is the duplicate this whole table exists to prevent.
      CREATE UNIQUE INDEX side_effects_open_leg
        ON side_effects(job_id, leg_index) WHERE outcome IS NULL;
      CREATE INDEX side_effects_by_job ON side_effects(job_id);

      CREATE TABLE stream_cursors (
        scope      TEXT PRIMARY KEY,
        cursor     TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `,
  },
];

export const LATEST_SCHEMA_VERSION: number = MIGRATIONS.reduce(
  (highest, migration) => Math.max(highest, migration.version),
  0,
);

const readUserVersion = (db: DatabaseSync): number => {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return row?.user_version ?? 0;
};

/** Applies every migration above the database's current version, in order. */
export const migrate = (db: DatabaseSync): number => {
  const current = readUserVersion(db);
  if (current > LATEST_SCHEMA_VERSION) {
    throw new JobStoreError(
      'SCHEMA_TOO_NEW',
      `job store schema v${String(current)} was written by a newer Runner; this build knows v${String(LATEST_SCHEMA_VERSION)}`,
      { found: current, supported: LATEST_SCHEMA_VERSION },
    );
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migration.sql);
      // `PRAGMA user_version` takes no bound parameter, and the value is an
      // integer from this module rather than from input.
      db.exec(`PRAGMA user_version = ${String(migration.version)}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return LATEST_SCHEMA_VERSION;
};
