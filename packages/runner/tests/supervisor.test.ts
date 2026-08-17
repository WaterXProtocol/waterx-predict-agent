/**
 * The two clocks a Runner keeps, and what it stops the moment one of them fails.
 *
 * The tests that matter here are the two abort paths. A Runner that has been
 * fenced out must stop *before* it discovers why, and a Runner that merely cannot
 * reach its store must stop too once the lease it is holding is close enough to
 * expiry that another Runner could legitimately claim the job. Both are the
 * difference between one order and two.
 */
import { JobStoreError } from '../src/errors.ts';
import type { JobLease } from '../src/job.ts';
import { SqliteJobStore } from '../src/sqlite/store.ts';
import type { JobStore } from '../src/store.ts';
import { LeaseKeeper, type LeaseLossReason } from '../src/supervisor.ts';
import { jobInput, later, T0, tempStoreDir, type TempStoreDir } from './harness.ts';

const TTL = 30_000;
const RENEW = 5_000;
const MARGIN = 10_000;

let dir: TempStoreDir;
let store: SqliteJobStore;
let now: string;

const clock = (): string => now;

const claim = async (instanceId: string, at: string): Promise<JobLease> => {
  await store.registerInstance({ instanceId, pid: 4242, host: 'laptop', at });
  const lease = await store.claimJob({ jobId: 'job_1', instanceId, at, leaseTtlMs: TTL });
  if (lease === undefined) throw new Error(`${instanceId} could not claim job_1`);
  return lease;
};

/**
 * A store that only implements what the keeper calls. Used for the failure paths
 * that a working SQLite store cannot be made to produce on demand.
 */
const stubStore = (overrides: Readonly<Record<string, unknown>>): JobStore =>
  ({ kind: 'stub', ...overrides }) as unknown as JobStore;

const keeperFor = (
  target: JobStore,
  lost: [string, LeaseLossReason][],
  errors: string[] = [],
): LeaseKeeper =>
  new LeaseKeeper({
    store: target,
    instanceId: 'run_a',
    now: clock,
    leaseTtlMs: TTL,
    renewIntervalMs: RENEW,
    safetyMarginMs: MARGIN,
    onLeaseLost: (jobId, reason) => lost.push([jobId, reason]),
    onError: (_error, context) => errors.push(context),
  });

beforeEach(() => {
  dir = tempStoreDir();
  store = new SqliteJobStore({ path: dir.path });
  now = T0;
});

afterEach(async () => {
  await store.close();
  dir.cleanup();
});

describe('renewal against a real store', () => {
  it('extends the lease without bumping the fence', async () => {
    await store.createJob(jobInput());
    const lease = await claim('run_a', T0);
    const keeper = keeperFor(store, []);
    const held = keeper.hold(lease);

    now = later(T0, RENEW);
    await keeper.tick();

    // Bumping on renewal would invalidate the lease the executor is holding in a
    // local variable, and its next write would fail against its own claim.
    expect(keeper.lease('job_1')?.fence).toBe(lease.fence);
    expect(keeper.lease('job_1')?.expiresAt).toBe(later(now, TTL));
    expect(held.current().expiresAt).toBe(later(now, TTL));
    expect(held.signal.aborted).toBe(false);

    const record = await store.getJob('job_1');
    expect(record?.leaseFence).toBe(lease.fence);
    expect(record?.leaseExpiresAt).toBe(later(now, TTL));
  });

  it('renews the instance heartbeat on the same pass', async () => {
    await store.createJob(jobInput());
    const keeper = keeperFor(store, []);
    keeper.hold(await claim('run_a', T0));

    now = later(T0, RENEW);
    await keeper.tick();

    const instance = (await store.listInstances()).find((i) => i.instanceId === 'run_a');
    expect(instance?.heartbeatAt).toBe(now);
  });

  it('aborts the job the moment another instance has fenced it out', async () => {
    await store.createJob(jobInput());
    const lease = await claim('run_a', T0);
    const lost: [string, LeaseLossReason][] = [];
    const keeper = keeperFor(store, lost);
    const held = keeper.hold(lease);

    // The TTL ran out — this Runner was stalled — and another one legitimately
    // claimed the job.
    now = later(T0, TTL + 1_000);
    await claim('run_b', now);

    await keeper.tick();

    expect(held.signal.aborted).toBe(true);
    expect((held.signal.reason as JobStoreError).code).toBe('LEASE_LOST');
    expect(keeper.held()).toEqual([]);
    expect(lost).toEqual([['job_1', 'LEASE_LOST']]);
  });

  it('hands a released lease back so the next Runner need not wait out the TTL', async () => {
    await store.createJob(jobInput());
    const lease = await claim('run_a', T0);
    const lost: [string, LeaseLossReason][] = [];
    const keeper = keeperFor(store, lost);
    const held = keeper.hold(lease);

    await keeper.release('job_1');

    expect(held.signal.aborted).toBe(true);
    expect(keeper.isHeld('job_1')).toBe(false);
    expect(lost).toEqual([['job_1', 'RELEASED']]);
    const record = await store.getJob('job_1');
    expect(record?.leaseInstanceId).toBeNull();
    expect(record?.leaseExpiresAt).toBeNull();
  });

  it('gives every held lease back on stop', async () => {
    await store.createJob(jobInput());
    await store.createJob(jobInput({ jobId: 'job_2' }));
    await store.registerInstance({ instanceId: 'run_a', pid: 1, host: 'laptop', at: T0 });
    const keeper = keeperFor(store, []);
    for (const jobId of ['job_1', 'job_2']) {
      const lease = await store.claimJob({
        jobId,
        instanceId: 'run_a',
        at: T0,
        leaseTtlMs: TTL,
      });
      keeper.hold(lease as JobLease);
    }
    keeper.start();

    expect(keeper.held()).toEqual(['job_1', 'job_2']);
    await keeper.stop();

    expect(keeper.held()).toEqual([]);
    expect((await store.getJob('job_2'))?.leaseInstanceId).toBeNull();
  });
});

describe('renewal that fails for a reason other than being fenced out', () => {
  const unreachable = (): JobStore =>
    stubStore({
      heartbeat: async () => ({}),
      renewLease: async () => {
        throw new Error('database is locked');
      },
    });

  it('keeps the job while there is still margin before expiry', async () => {
    const lost: [string, LeaseLossReason][] = [];
    const errors: string[] = [];
    const keeper = keeperFor(unreachable(), lost, errors);
    const held = keeper.hold({
      jobId: 'job_1',
      instanceId: 'run_a',
      fence: 1,
      expiresAt: later(T0, TTL),
    });

    await keeper.tick();

    // 30s of lease left against a 10s margin: nobody else can have this job yet,
    // and dropping it over one unreachable store would be a false positive.
    expect(held.signal.aborted).toBe(false);
    expect(keeper.held()).toEqual(['job_1']);
    expect(errors).toContain('renew job_1');
    expect(lost).toEqual([]);
  });

  it('aborts once the unrenewed lease is inside the safety margin', async () => {
    const lost: [string, LeaseLossReason][] = [];
    const keeper = keeperFor(unreachable(), lost);
    const held = keeper.hold({
      jobId: 'job_1',
      instanceId: 'run_a',
      fence: 1,
      expiresAt: later(T0, TTL),
    });

    // 5s of lease left against a 10s margin. Nobody has taken the job — and it
    // does not matter, because this instance can no longer prove it owns it for
    // longer than a request takes.
    now = later(T0, TTL - 5_000);
    await keeper.tick();

    expect(held.signal.aborted).toBe(true);
    expect(keeper.held()).toEqual([]);
    expect(lost).toEqual([['job_1', 'UNRENEWABLE']]);
  });

  it('does not drop a lease because the instance heartbeat failed', async () => {
    const lost: [string, LeaseLossReason][] = [];
    const errors: string[] = [];
    const keeper = keeperFor(
      stubStore({
        heartbeat: async () => {
          throw new Error('database is locked');
        },
        renewLease: async (lease: JobLease, at: string, ttl: number) => ({
          ...lease,
          expiresAt: later(at, ttl),
        }),
      }),
      lost,
      errors,
    );
    const held = keeper.hold({
      jobId: 'job_1',
      instanceId: 'run_a',
      fence: 1,
      expiresAt: later(T0, TTL),
    });

    await keeper.tick();

    // A missed heartbeat makes this instance look stale to another Runner. It
    // does not invalidate a lease that renewed.
    expect(errors).toContain('heartbeat');
    expect(held.signal.aborted).toBe(false);
    expect(lost).toEqual([]);
  });
});

describe('the bookkeeping around a held lease', () => {
  it('forgets a job without asking the store to release it', async () => {
    let releases = 0;
    const lost: [string, LeaseLossReason][] = [];
    const keeper = keeperFor(
      stubStore({
        releaseJob: async () => {
          releases += 1;
        },
      }),
      lost,
    );
    const held = keeper.hold({
      jobId: 'job_1',
      instanceId: 'run_a',
      fence: 1,
      expiresAt: later(T0, TTL),
    });

    // A terminal transition already cleared the lease inside its own
    // transaction; releasing again would fail against a lease correctly given up.
    keeper.forget('job_1');

    expect(releases).toBe(0);
    expect(held.signal.aborted).toBe(true);
    expect(keeper.held()).toEqual([]);
    expect(lost).toEqual([['job_1', 'RELEASED']]);
  });

  it('ignores forget and release for a job it never held', async () => {
    const lost: [string, LeaseLossReason][] = [];
    const keeper = keeperFor(stubStore({}), lost);
    keeper.forget('job_absent');
    await keeper.release('job_absent');
    expect(lost).toEqual([]);
  });

  it('keeps one signal per job when the same job is held again', () => {
    const keeper = keeperFor(stubStore({}), []);
    const first = keeper.hold({
      jobId: 'job_1',
      instanceId: 'run_a',
      fence: 1,
      expiresAt: later(T0, TTL),
    });
    const second = keeper.hold({
      jobId: 'job_1',
      instanceId: 'run_a',
      fence: 1,
      expiresAt: later(T0, TTL * 2),
    });

    expect(second.signal).toBe(first.signal);
    expect(first.current().expiresAt).toBe(later(T0, TTL * 2));
    expect(keeper.held()).toEqual(['job_1']);
  });

  it('reports a store error from release without leaving the job held', async () => {
    const errors: string[] = [];
    const lost: [string, LeaseLossReason][] = [];
    const keeper = keeperFor(
      stubStore({
        releaseJob: async () => {
          throw new JobStoreError('LEASE_LOST', 'fenced out');
        },
      }),
      lost,
      errors,
    );
    keeper.hold({ jobId: 'job_1', instanceId: 'run_a', fence: 1, expiresAt: later(T0, TTL) });

    await keeper.release('job_1');

    // The local half is what mattered and it is done: this instance has stopped.
    expect(errors).toContain('release job_1');
    expect(keeper.held()).toEqual([]);
    expect(lost).toEqual([['job_1', 'RELEASED']]);
  });
});

describe('the intervals the keeper refuses to run with', () => {
  const options = {
    store: stubStore({}),
    instanceId: 'run_a',
    now: clock,
    leaseTtlMs: TTL,
    renewIntervalMs: RENEW,
    safetyMarginMs: MARGIN,
  };

  it('refuses a renewal interval that cannot fit inside one TTL', () => {
    expect(() => new LeaseKeeper({ ...options, renewIntervalMs: TTL })).toThrow(
      /renewIntervalMs/,
    );
  });

  it('refuses a safety margin as wide as the TTL, which would abort immediately', () => {
    expect(() => new LeaseKeeper({ ...options, safetyMarginMs: TTL })).toThrow(/safetyMarginMs/);
  });
});
