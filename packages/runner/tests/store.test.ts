/**
 * The durable store's money-sensitive guarantees.
 *
 * Every test here corresponds to a way a Runner could otherwise place a
 * duplicate or unintended order: two keys for one leg, two Runners on one store,
 * a state that can write reached before its key was on disk, a cursor that
 * rewound, or a secret written to a file the store is not allowed to hold.
 */
import { DatabaseSync } from 'node:sqlite';

import { isJobStoreError, JobStoreError } from '../src/errors.ts';
import { fingerprintRequest } from '../src/ids.ts';
import type { JobLease } from '../src/job.ts';
import { assertNoSecrets, FORBIDDEN_STORE_KEYS } from '../src/secrets.ts';
import { LATEST_SCHEMA_VERSION } from '../src/sqlite/migrations.ts';
import { SqliteJobStore } from '../src/sqlite/store.ts';
import { jobInput, later, LEG, T0, tempStoreDir, type TempStoreDir } from './harness.ts';

const KEY = '4c1c9d2e-0000-4000-8000-000000000001';

let dir: TempStoreDir;
let store: SqliteJobStore;

const open = (): SqliteJobStore => new SqliteJobStore({ path: dir.path });

/** Creates a job, registers an instance and claims it. The common preamble. */
const claimed = async (at = T0): Promise<JobLease> => {
  await store.registerInstance({ instanceId: 'run_a', pid: 4242, host: 'laptop', at });
  await store.createJob(jobInput({ at }));
  const lease = await store.claimJob({
    jobId: 'job_1',
    instanceId: 'run_a',
    at,
    leaseTtlMs: 30_000,
  });
  if (lease === undefined) throw new Error('claim failed');
  return lease;
};

const code = async (body: () => Promise<unknown>): Promise<string> => {
  try {
    await body();
  } catch (error) {
    if (isJobStoreError(error)) return error.code;
    throw error;
  }
  throw new Error('expected a JobStoreError');
};

beforeEach(() => {
  dir = tempStoreDir();
  store = open();
});

afterEach(async () => {
  await store.close();
  dir.cleanup();
});

describe('the database itself', () => {
  it('creates its directory, runs to the latest schema, and is in WAL', async () => {
    await store.close();
    const db = new DatabaseSync(dir.path);
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe(
      'wal',
    );
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(
      LATEST_SCHEMA_VERSION,
    );
    db.close();
    store = open();
  });

  it('is idempotent to reopen', async () => {
    await store.close();
    store = open();
    await store.close();
    store = open();
    expect(await store.listJobs()).toEqual([]);
  });

  it('refuses a database written by a newer Runner', async () => {
    await store.close();
    const db = new DatabaseSync(dir.path);
    db.exec(`PRAGMA user_version = ${String(LATEST_SCHEMA_VERSION + 1)}`);
    db.close();
    // Writing rows through an older schema is how a job silently loses the
    // column that says an order is in flight, so this is fatal rather than a
    // warning.
    expect(() => open()).toThrow(JobStoreError);
    const db2 = new DatabaseSync(dir.path);
    db2.exec(`PRAGMA user_version = ${String(LATEST_SCHEMA_VERSION)}`);
    db2.close();
    store = open();
  });
});

describe('jobs and the audit log', () => {
  it('persists a job, its intent and its expiry across a reopen', async () => {
    await store.createJob(jobInput());
    await store.close();
    store = open();

    const job = await store.getJob('job_1');
    expect(job?.state).toBe('DRAFT');
    expect(job?.intent).toEqual([LEG]);
    expect(job?.trigger.targetPrice).toBe('0.8200');
    expect(job?.policy.mode).toBe('delegated-auto');
    expect(job?.leaseFence).toBe(0);
    // The frozen SELL size is stored as an absolute decimal string, so a
    // percentage can never be re-evaluated at trigger time (ADR-0001 §13).
    expect(job?.intent[0]?.sellShares).toBe('25.000000');
  });

  it('demands a readable expiry, because a job without one is a permanent watcher', async () => {
    expect(await code(() => store.createJob(jobInput({ expiresAt: 'whenever' })))).toBe(
      'INVALID_INPUT',
    );
  });

  it('writes an append-only transition log with a per-job sequence', async () => {
    const lease = await claimed();
    await store.transition({ lease, to: 'WATCHING', reason: 'ADMITTED', at: later(T0, 1_000) });
    await store.transition({ lease, to: 'TRIGGERED', reason: 'TARGET_SEEN', at: later(T0, 2_000) });

    const log = await store.listTransitions('job_1');
    expect(log.map((entry) => [entry.seq, entry.fromState, entry.toState])).toEqual([
      [1, null, 'DRAFT'],
      [2, 'DRAFT', 'WATCHING'],
      [3, 'WATCHING', 'TRIGGERED'],
    ]);
    expect(log[2]?.instanceId).toBe('run_a');
  });

  it('refuses an edge the state machine does not have', async () => {
    const lease = await claimed();
    expect(await code(() => store.transition({ lease, to: 'FILLED', reason: 'x', at: T0 }))).toBe(
      'ILLEGAL_TRANSITION',
    );
  });

  it('records a cancellation request without applying it', async () => {
    const lease = await claimed();
    await store.transition({ lease, to: 'WATCHING', reason: 'ADMITTED', at: later(T0, 1) });
    const job = await store.requestCancel('job_1', 'user asked', later(T0, 2));
    // Recorded, not applied: only the lease holder ends a job. A store that
    // flipped the state here would report a stop while a write was in flight.
    expect(job.state).toBe('WATCHING');
    expect(job.cancelRequestedAt).toBe(later(T0, 2));
    expect(job.cancelReason).toBe('user asked');
  });

  it('will not accept a cancellation for a job that already ended', async () => {
    const lease = await claimed();
    await store.transition({ lease, to: 'CANCELLED', reason: 'STOPPED', at: later(T0, 1) });
    expect(await code(() => store.requestCancel('job_1', 'too late', later(T0, 2)))).toBe(
      'ILLEGAL_TRANSITION',
    );
  });
});

describe('leases, and two Runners on one store', () => {
  it('refuses a second instance while the first lease is live', async () => {
    await claimed();
    await store.registerInstance({ instanceId: 'run_b', pid: 99, host: 'laptop', at: T0 });
    const stolen = await store.claimJob({
      jobId: 'job_1',
      instanceId: 'run_b',
      at: later(T0, 1_000),
      leaseTtlMs: 30_000,
    });
    expect(stolen).toBeUndefined();
  });

  it('lets a later instance reclaim an expired lease and fences the older writer out', async () => {
    const first = await claimed();
    await store.registerInstance({ instanceId: 'run_b', pid: 99, host: 'laptop', at: T0 });
    const second = await store.claimJob({
      jobId: 'job_1',
      instanceId: 'run_b',
      at: later(T0, 60_000),
      leaseTtlMs: 30_000,
    });
    expect(second?.fence).toBe(first.fence + 1);

    // The whole point of the fence: the first instance may still be alive and
    // mid-order. Its next write fails instead of racing the new owner.
    expect(
      await code(() =>
        store.transition({ lease: first, to: 'WATCHING', reason: 'ADMITTED', at: later(T0, 61_000) }),
      ),
    ).toBe('LEASE_LOST');
  });

  it('lets the holder of an expired-but-unclaimed lease finish safely', async () => {
    // Expiry is a signal to others, not a revocation. Nobody reclaimed, so the
    // fence still matches and the in-flight instance is not forced to abandon an
    // order half-way.
    const lease = await claimed();
    const job = await store.transition({
      lease,
      to: 'WATCHING',
      reason: 'ADMITTED',
      at: later(T0, 600_000),
    });
    expect(job.state).toBe('WATCHING');
  });

  it('renews without bumping the fence', async () => {
    const lease = await claimed();
    const renewed = await store.renewLease(lease, later(T0, 10_000), 30_000);
    expect(renewed.fence).toBe(lease.fence);
    expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(lease.expiresAt));
  });

  it('releases every lease an instance held when it stops cleanly', async () => {
    await claimed();
    await store.stopInstance('run_a', later(T0, 5_000));
    const job = await store.getJob('job_1');
    expect(job?.leaseInstanceId).toBeNull();
    const instance = (await store.listInstances())[0];
    expect(instance?.stoppedAt).toBe(later(T0, 5_000));
  });

  it('reports the last heartbeat, which is what says a strategy is monitored', async () => {
    await store.registerInstance({ instanceId: 'run_a', pid: 1, host: 'laptop', at: T0 });
    await store.heartbeat('run_a', later(T0, 15_000));
    const instance = (await store.listInstances())[0];
    expect(instance?.heartbeatAt).toBe(later(T0, 15_000));
    expect(instance?.stoppedAt).toBeNull();
  });
});

describe('idempotency keys, before any side effect', () => {
  it('will not enter a state that can write before the key is on disk', async () => {
    const lease = await claimed();
    await store.transition({ lease, to: 'WATCHING', reason: 'ADMITTED', at: later(T0, 1) });
    await store.transition({ lease, to: 'TRIGGERED', reason: 'TARGET', at: later(T0, 2) });
    await store.transition({ lease, to: 'QUOTING', reason: 'QUOTING', at: later(T0, 3) });

    expect(
      await code(() => store.transition({ lease, to: 'CREATING', reason: 'CREATE', at: later(T0, 4) })),
    ).toBe('NO_IDEMPOTENCY_KEY');

    await store.reserveLeg({ lease, legIndex: 0, idempotencyKey: KEY, intent: LEG, at: later(T0, 5) });
    const job = await store.transition({
      lease,
      to: 'CREATING',
      reason: 'CREATE',
      at: later(T0, 6),
    });
    expect(job.state).toBe('CREATING');
  });

  it('refuses to send anything for a leg that has no key', async () => {
    const lease = await claimed();
    expect(
      await code(() =>
        store.beginSideEffect({
          lease,
          attemptId: 'att_1',
          legIndex: 0,
          kind: 'CREATE_EXECUTION',
          requestFingerprint: fingerprintRequest({ a: 1 }),
          at: T0,
        }),
      ),
    ).toBe('NO_IDEMPOTENCY_KEY');
  });

  it('returns the same leg when a restarted Runner reserves it again', async () => {
    const lease = await claimed();
    const first = await store.reserveLeg({
      lease,
      legIndex: 0,
      idempotencyKey: KEY,
      intent: LEG,
      at: T0,
    });
    const again = await store.reserveLeg({
      lease,
      legIndex: 0,
      idempotencyKey: KEY,
      intent: LEG,
      at: later(T0, 1_000),
    });
    expect(again).toEqual(first);
  });

  it('refuses a second key for one leg', async () => {
    const lease = await claimed();
    await store.reserveLeg({ lease, legIndex: 0, idempotencyKey: KEY, intent: LEG, at: T0 });
    expect(
      await code(() =>
        store.reserveLeg({
          lease,
          legIndex: 0,
          idempotencyKey: 'a-different-key',
          intent: LEG,
          at: T0,
        }),
      ),
    ).toBe('REPLAY_MISMATCH');
  });

  it('refuses one key across two legs', async () => {
    const lease = await claimed();
    await store.reserveLeg({ lease, legIndex: 0, idempotencyKey: KEY, intent: LEG, at: T0 });
    // The server would dedupe the second order into the first and report a fill
    // belonging to the wrong leg.
    expect(
      await code(() =>
        store.reserveLeg({ lease, legIndex: 1, idempotencyKey: KEY, intent: LEG, at: T0 }),
      ),
    ).toBe('DUPLICATE_IDEMPOTENCY_KEY');
  });

  it('survives a reopen with the key intact', async () => {
    const lease = await claimed();
    await store.reserveLeg({ lease, legIndex: 0, idempotencyKey: KEY, intent: LEG, at: T0 });
    await store.close();
    store = open();
    expect((await store.listLegs('job_1'))[0]?.idempotencyKey).toBe(KEY);
  });
});

describe('the side-effect ledger', () => {
  const fingerprint = fingerprintRequest({ marketId: 'mkt_btts_yes', size: '25.000000' });

  const withLeg = async (): Promise<JobLease> => {
    const lease = await claimed();
    await store.reserveLeg({ lease, legIndex: 0, idempotencyKey: KEY, intent: LEG, at: T0 });
    return lease;
  };

  it('copies the key from the leg rather than trusting the caller', async () => {
    const lease = await withLeg();
    const attempt = await store.beginSideEffect({
      lease,
      attemptId: 'att_1',
      legIndex: 0,
      kind: 'CREATE_EXECUTION',
      requestFingerprint: fingerprint,
      at: T0,
    });
    expect(attempt.idempotencyKey).toBe(KEY);
    expect(attempt.outcome).toBeNull();
  });

  it('reuses the open attempt when the same request is replayed', async () => {
    const lease = await withLeg();
    const first = await store.beginSideEffect({
      lease,
      attemptId: 'att_1',
      legIndex: 0,
      kind: 'CREATE_EXECUTION',
      requestFingerprint: fingerprint,
      at: T0,
    });
    const replay = await store.beginSideEffect({
      lease,
      attemptId: 'att_2',
      legIndex: 0,
      kind: 'CREATE_EXECUTION',
      requestFingerprint: fingerprint,
      at: later(T0, 5_000),
    });
    expect(replay.attemptId).toBe(first.attemptId);
    expect(await store.listSideEffects('job_1')).toHaveLength(1);
  });

  it('refuses a replay whose bytes changed', async () => {
    const lease = await withLeg();
    await store.beginSideEffect({
      lease,
      attemptId: 'att_1',
      legIndex: 0,
      kind: 'CREATE_EXECUTION',
      requestFingerprint: fingerprint,
      at: T0,
    });
    // Retrying under the same key with a different body is not a retry — the
    // server would either dedupe it into the original or reject it, and either
    // way the Runner's picture of what it asked for is wrong.
    expect(
      await code(() =>
        store.beginSideEffect({
          lease,
          attemptId: 'att_2',
          legIndex: 0,
          kind: 'CREATE_EXECUTION',
          requestFingerprint: fingerprintRequest({ size: '50.000000' }),
          at: later(T0, 1_000),
        }),
      ),
    ).toBe('REPLAY_MISMATCH');
  });

  it('refuses a different call while one is unresolved', async () => {
    const lease = await withLeg();
    await store.beginSideEffect({
      lease,
      attemptId: 'att_1',
      legIndex: 0,
      kind: 'CREATE_EXECUTION',
      requestFingerprint: fingerprint,
      at: T0,
    });
    expect(
      await code(() =>
        store.beginSideEffect({
          lease,
          attemptId: 'att_2',
          legIndex: 0,
          kind: 'SUBMIT_EXECUTION',
          requestFingerprint: fingerprintRequest({ signed: true }),
          at: later(T0, 1_000),
        }),
      ),
    ).toBe('OPEN_SIDE_EFFECT');
  });

  it('resolves the attempt and records the execution id in one transaction', async () => {
    const lease = await withLeg();
    await store.beginSideEffect({
      lease,
      attemptId: 'att_1',
      legIndex: 0,
      kind: 'CREATE_EXECUTION',
      requestFingerprint: fingerprint,
      at: T0,
    });
    await store.completeSideEffect({
      lease,
      attemptId: 'att_1',
      outcome: 'SUCCEEDED',
      at: later(T0, 800),
      leg: { executionId: 'exec_1', referenceQuoteId: 'quote_1' },
    });

    await store.close();
    store = open();
    // Recovery reads "no open attempt and no execution id" as "nothing was
    // sent". If these two writes could interleave with a crash, a created order
    // would look like one that never happened.
    expect(await store.listOpenSideEffects()).toEqual([]);
    expect((await store.listLegs('job_1'))[0]?.executionId).toBe('exec_1');
  });

  it('refuses to resolve an attempt twice', async () => {
    const lease = await withLeg();
    await store.beginSideEffect({
      lease,
      attemptId: 'att_1',
      legIndex: 0,
      kind: 'CREATE_EXECUTION',
      requestFingerprint: fingerprint,
      at: T0,
    });
    await store.completeSideEffect({ lease, attemptId: 'att_1', outcome: 'FAILED', at: T0 });
    expect(
      await code(() =>
        store.completeSideEffect({ lease, attemptId: 'att_1', outcome: 'SUCCEEDED', at: T0 }),
      ),
    ).toBe('UNKNOWN_SIDE_EFFECT');
  });

  it('refuses to hang one execution id off two legs', async () => {
    const lease = await withLeg();
    await store.reserveLeg({
      lease,
      legIndex: 1,
      idempotencyKey: '4c1c9d2e-0000-4000-8000-000000000002',
      intent: LEG,
      at: T0,
    });
    await store.updateLeg({ lease, legIndex: 0, at: T0, executionId: 'exec_1' });
    expect(
      await code(() => store.updateLeg({ lease, legIndex: 1, at: T0, executionId: 'exec_1' })),
    ).toBe('DUPLICATE_EXECUTION');
  });

  it('keeps the submit digest apart from the keeper digest', async () => {
    const lease = await withLeg();
    const leg = await store.updateLeg({
      lease,
      legIndex: 0,
      at: T0,
      submissionDigest: '0xsubmit',
      keeperDigest: '0xkeeper',
    });
    expect(leg.submissionDigest).toBe('0xsubmit');
    expect(leg.keeperDigest).toBe('0xkeeper');
  });
});

describe('stream cursors', () => {
  it('persists a resume point across a restart', async () => {
    await store.saveCursor('executions:acct_1', '1024', T0);
    await store.close();
    store = open();
    expect(await store.readCursor('executions:acct_1')).toBe('1024');
  });

  it('refuses to rewind, and tolerates a repeat', async () => {
    await store.saveCursor('executions:acct_1', '1024', T0);
    expect(await store.saveCursor('executions:acct_1', '1024', later(T0, 1))).toBe('1024');
    // A cursor that moved backwards asks the next reconnect for a window the
    // server no longer has, and the gap it hides is silent.
    expect(await code(() => store.saveCursor('executions:acct_1', '1023', later(T0, 2)))).toBe(
      'CURSOR_REWIND',
    );
    expect(await store.readCursor('executions:acct_1')).toBe('1024');
  });

  it('compares as a number, not as text', async () => {
    await store.saveCursor('executions:acct_1', '9', T0);
    expect(await store.saveCursor('executions:acct_1', '10', later(T0, 1))).toBe('10');
  });

  it('rejects a cursor that is not a cursor', async () => {
    expect(await code(() => store.saveCursor('executions:acct_1', 'latest', T0))).toBe(
      'INVALID_INPUT',
    );
    expect(await store.readCursor('nothing-here')).toBeUndefined();
  });
});

describe('what the store refuses to hold', () => {
  it('keeps every category of secret material on the refusal list', () => {
    // Pinned rather than left to review: an entry disappearing from this list is
    // a silent decision to start writing that field to disk.
    for (const key of [
      'privatekey',
      'secretkey',
      'seedphrase',
      'mnemonic',
      'keypair',
      'signature',
      'sponsoredtransactionbytes',
      'accesstoken',
      'authorization',
    ]) {
      expect(FORBIDDEN_STORE_KEYS, key).toContain(key);
    }
  });

  it('matches a secret name however it was spelled, and names the path not the value', () => {
    const secret = 'suiprivkey1qq0000000000000000000000000';
    try {
      assertNoSecrets({ signer: { 'PRIVATE-KEY': secret } });
      throw new Error('expected a refusal');
    } catch (error) {
      expect(isJobStoreError(error)).toBe(true);
      expect((error as JobStoreError).code).toBe('SECRET_REJECTED');
      // An error that quoted the secret to explain the refusal would have leaked
      // it into the log the refusal exists to keep clean.
      expect((error as JobStoreError).message).toContain('$.signer.PRIVATE-KEY');
      expect((error as JobStoreError).message).not.toContain(secret);
    }
  });

  it('rejects secret-shaped detail before it reaches the file', async () => {
    const lease = await claimed();
    await store.reserveLeg({ lease, legIndex: 0, idempotencyKey: KEY, intent: LEG, at: T0 });
    await store.beginSideEffect({
      lease,
      attemptId: 'att_1',
      legIndex: 0,
      kind: 'SUBMIT_EXECUTION',
      requestFingerprint: fingerprintRequest({ signed: true }),
      at: T0,
    });
    expect(
      await code(() =>
        store.completeSideEffect({
          lease,
          attemptId: 'att_1',
          outcome: 'SUCCEEDED',
          at: T0,
          detail: { response: { signature: 'AQID', executionId: 'exec_1' } },
        }),
      ),
    ).toBe('SECRET_REJECTED');
  });

  it('never writes signatures or transaction bytes, only a digest of them', async () => {
    const lease = await claimed();
    await store.reserveLeg({ lease, legIndex: 0, idempotencyKey: KEY, intent: LEG, at: T0 });
    const secret = 'AQIDBAUGBwgJCg==';
    await store.beginSideEffect({
      lease,
      attemptId: 'att_1',
      legIndex: 0,
      kind: 'SUBMIT_EXECUTION',
      requestFingerprint: fingerprintRequest({ sponsoredTransactionBytes: secret }),
      at: T0,
    });
    await store.completeSideEffect({
      lease,
      attemptId: 'att_1',
      outcome: 'SUCCEEDED',
      at: T0,
      leg: { executionId: 'exec_1', submissionDigest: '0xsubmit' },
    });
    await store.close();

    const attempts = await open().listSideEffects('job_1');
    const serialized = JSON.stringify(attempts);
    expect(serialized).not.toContain(secret);
    // A digest is enough to prove a replay is byte-identical, and reveals
    // nothing that could be submitted by whoever can read the file.
    expect(attempts[0]?.requestFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    store = open();
  });
});
