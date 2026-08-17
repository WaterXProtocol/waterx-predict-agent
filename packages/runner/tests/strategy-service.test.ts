/**
 * The strategy commands, against a real database that is closed and reopened.
 *
 * Two things are being checked here, and only one of them is the API surface.
 * The other is what the surface is allowed to *claim*: a created strategy is a
 * durable record and nothing more until an executor exists, a job past its
 * expiry is not an expired job until a Runner ends it, and a cancellation is
 * recorded by anyone but applied only by the lease holder.
 */
import type { JobLease, JobPolicySnapshot } from '../src/job.ts';
import { SqliteJobStore } from '../src/sqlite/store.ts';
import { StrategyError } from '../src/strategy/errors.ts';
import type { StrategyLegRequest, StrategyRequest } from '../src/strategy/intent.ts';
import {
  StrategyService,
  type StrategyLeaseHolder,
} from '../src/strategy/service.ts';
import { later, T0, tempStoreDir, type TempStoreDir } from './harness.ts';

/**
 * `delegated-auto`, because that is the only authority under which a durable
 * strategy can be created at all: `interactive` and `read-only` are refused by
 * `requirePolicyThatCanSignUnattended`, and the tests below are about what a
 * *created* strategy does. The refusals have their own cases at the bottom.
 */
const POLICY: JobPolicySnapshot = { mode: 'delegated-auto', source: 'file:policy.json' };
const DAY = 86_400_000;
const KEY = '4c1c9d2e-0000-4000-8000-000000000001';
const FINGERPRINT = 'a'.repeat(64);

const LEG: StrategyLegRequest = {
  marketId: 'mkt_1',
  outcomeId: 'YES',
  side: 'BUY',
  buyAmount: '25.000000',
  maxSlippageBps: 50,
};

const request = (overrides: Partial<StrategyRequest> = {}): StrategyRequest => ({
  ownerAddress: '0xowner',
  accountId: 'acct_1',
  agentWallet: '0xagent',
  legs: [LEG],
  trigger: { kind: 'PRICE', targetPrice: '0.400000' },
  policy: POLICY,
  expiresAt: later(T0, DAY),
  ...overrides,
});

/** A clock the test moves by hand: expiry is wall-clock, not elapsed process time. */
const clockAt = (start: string) => {
  const state = { at: start };
  return Object.assign(() => state.at, {
    set: (at: string) => {
      state.at = at;
    },
  });
};

/** The lease keeper's two methods, without a daemon. */
const holder = (lease?: JobLease): StrategyLeaseHolder & { forgotten: string[] } => ({
  forgotten: [],
  lease: (jobId: string) => (lease?.jobId === jobId ? lease : undefined),
  forget(jobId: string) {
    this.forgotten.push(jobId);
  },
});

let dir: TempStoreDir;
let store: SqliteJobStore;
let now: ReturnType<typeof clockAt>;
let service: StrategyService;

beforeEach(() => {
  dir = tempStoreDir();
  store = new SqliteJobStore({ path: dir.path });
  now = clockAt(T0);
  service = new StrategyService({ store, now });
});

afterEach(async () => {
  await store.close();
  dir.cleanup();
});

describe('create', () => {
  it('writes a durable job and reports the state it is actually in', async () => {
    const created = await service.create(request());

    // DRAFT, not "armed". Nothing advances a job yet (backlog 2.6), and naming
    // the state is the difference between a record and a promise.
    expect(created.state).toBe('DRAFT');
    expect(created.terminal).toBe(false);
    expect(created.jobId).toMatch(/^job_/);
    expect(created.strategyId).toMatch(/^strat_/);
    expect(created.legs).toEqual([]);
    expect(created.openSideEffects).toEqual([]);
    expect(created.job.intent[0]).toMatchObject({
      marketId: 'mkt_1',
      buyAmount: '25.000000',
      sizing: { kind: 'ABSOLUTE' },
    });
    expect(created.job.trigger).toMatchObject({ marketId: 'mkt_1', side: 'BUY', observe: 'ASK' });
  });

  it('keeps a caller-supplied strategy id, and survives a close and reopen', async () => {
    const created = await service.create(request({ strategyId: 'strat_mine' }));
    await store.close();

    const reopened = new SqliteJobStore({ path: dir.path });
    store = reopened;
    const found = await new StrategyService({ store: reopened, now }).get(created.jobId);
    expect(found?.strategyId).toBe('strat_mine');
    expect(found?.job.expiresAt).toBe(later(T0, DAY));
  });

  it('refuses before it writes: a rejected request leaves no job behind', async () => {
    // No expiry at all — the shape a JSON caller who forgot the field sends.
    const { expiresAt: _omitted, ...noExpiry } = request();
    await expect(service.create(noExpiry)).rejects.toBeInstanceOf(StrategyError);
    expect(await store.listJobs()).toEqual([]);
  });

  it('takes one clock reading, so the frozen instant and the expiry base agree', async () => {
    const created = await service.create(
      request({ trigger: { kind: 'IMMEDIATE' }, expiresAt: later(T0, DAY) }),
    );
    expect(created.createdAt).toBe(T0);
    expect(created.expiry.remainingMs).toBe(DAY);
  });
});

describe('get and list', () => {
  it('reports the clock against the expiry without claiming a state change', async () => {
    const created = await service.create(request());

    now.set(later(T0, DAY + 1000));
    const stale = await service.get(created.jobId);

    // Past its expiry, and still in the state it was left in. Only a Runner
    // holding the lease may end a job; saying EXPIRED here would report a stop
    // nothing performed.
    expect(stale?.expiry).toEqual({
      expiresAt: later(T0, DAY),
      remainingMs: 0,
      pastExpiry: true,
    });
    expect(stale?.state).toBe('DRAFT');
    expect(stale?.terminal).toBe(false);
  });

  it('returns undefined for a job this store has never seen', async () => {
    expect(await service.get('job_nope')).toBeUndefined();
  });

  it('filters by account, strategy and state', async () => {
    const a = await service.create(request({ strategyId: 'strat_a' }));
    await service.create(request({ strategyId: 'strat_b', accountId: 'acct_2' }));

    expect((await service.list()).length).toBe(2);
    expect((await service.list({ accountId: 'acct_2' })).map((s) => s.strategyId)).toEqual([
      'strat_b',
    ]);
    expect((await service.list({ strategyId: 'strat_a' })).map((s) => s.jobId)).toEqual([a.jobId]);
    expect(await service.list({ states: ['FILLED'] })).toEqual([]);
    expect((await service.list({ states: ['DRAFT'] })).length).toBe(2);
  });
});

describe('cancel', () => {
  it('records the request but does not claim to have applied it when nothing holds the lease', async () => {
    const created = await service.create(request());
    now.set(later(T0, 1000));

    const result = await service.cancel(created.jobId, 'user asked');

    expect(result).toMatchObject({
      recorded: true,
      applied: false,
      pending: 'NOT_LEASED_BY_THIS_RUNNER',
      state: 'DRAFT',
      cancelRequestedAt: later(T0, 1000),
    });
    // Durable: the next Runner to claim the job finds the request waiting.
    expect((await store.getJob(created.jobId))?.cancelRequestedAt).toBe(later(T0, 1000));
  });

  it('applies it when this process holds the lease and no write has begun', async () => {
    const created = await service.create(request());
    await store.registerInstance({ instanceId: 'run_1', pid: 1, host: 'h', at: T0 });
    const lease = await store.claimJob({
      jobId: created.jobId,
      instanceId: 'run_1',
      at: T0,
      leaseTtlMs: 60_000,
    });
    const keeper = holder(lease);
    const leased = new StrategyService({ store, now, leases: keeper });

    const result = await leased.cancel(created.jobId, 'user asked');

    expect(result).toMatchObject({ recorded: true, applied: true, state: 'CANCELLED' });
    expect(result.terminalAt).toBe(T0);
    // The terminal transition cleared the lease in its own transaction.
    expect(keeper.forgotten).toEqual([created.jobId]);
  });

  it('refuses to call a job stopped once a write may be in flight', async () => {
    const created = await service.create(request());
    await store.registerInstance({ instanceId: 'run_1', pid: 1, host: 'h', at: T0 });
    const lease = (await store.claimJob({
      jobId: created.jobId,
      instanceId: 'run_1',
      at: T0,
      leaseTtlMs: 60_000,
    })) as JobLease;

    for (const [to, reason] of [
      ['WATCHING', 'ADMITTED'],
      ['TRIGGERED', 'TARGET_SEEN'],
      ['QUOTING', 'QUOTING'],
    ] as const) {
      await store.transition({ lease, to, reason, at: T0 });
    }
    await store.reserveLeg({ lease, legIndex: 0, idempotencyKey: KEY, intent: LEG, at: T0 });
    await store.transition({ lease, to: 'CREATING', reason: 'CREATE', at: T0 });

    const result = await new StrategyService({ store, now, leases: holder(lease) }).cancel(
      created.jobId,
      'user asked',
    );

    expect(result).toMatchObject({ recorded: true, applied: false, pending: 'IN_FLIGHT' });
    expect((await store.getJob(created.jobId))?.state).toBe('CREATING');
  });
});

describe('events', () => {
  it('merges what the Runner decided with what left the process, in one order', async () => {
    const created = await service.create(request());
    await store.registerInstance({ instanceId: 'run_1', pid: 1, host: 'h', at: T0 });
    const lease = (await store.claimJob({
      jobId: created.jobId,
      instanceId: 'run_1',
      at: T0,
      leaseTtlMs: 60_000,
    })) as JobLease;

    await store.transition({ lease, to: 'WATCHING', reason: 'ADMITTED', at: later(T0, 1000) });
    await store.transition({ lease, to: 'TRIGGERED', reason: 'TARGET_SEEN', at: later(T0, 2000) });
    await store.transition({ lease, to: 'QUOTING', reason: 'QUOTING', at: later(T0, 3000) });
    await store.reserveLeg({
      lease,
      legIndex: 0,
      idempotencyKey: KEY,
      intent: LEG,
      at: later(T0, 4000),
    });
    await store.transition({ lease, to: 'CREATING', reason: 'CREATE', at: later(T0, 5000) });
    await store.beginSideEffect({
      lease,
      attemptId: 'att_1',
      legIndex: 0,
      kind: 'CREATE_EXECUTION',
      requestFingerprint: FINGERPRINT,
      at: later(T0, 6000),
    });
    await store.completeSideEffect({
      lease,
      attemptId: 'att_1',
      outcome: 'SUCCEEDED',
      at: later(T0, 7000),
      leg: { executionId: 'exec_1' },
    });

    const events = await service.events(created.jobId);

    expect(events.map((event) => [event.kind, event.at])).toEqual([
      ['TRANSITION', T0],
      ['TRANSITION', later(T0, 1000)],
      ['TRANSITION', later(T0, 2000)],
      ['TRANSITION', later(T0, 3000)],
      ['TRANSITION', later(T0, 5000)],
      ['SIDE_EFFECT_BEGAN', later(T0, 6000)],
      ['SIDE_EFFECT_RESOLVED', later(T0, 7000)],
    ]);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // Stable identity, so a caller diffing two reads recognizes what it has seen.
    expect(events[5]?.eventId).toBe(`${created.jobId}:s:att_1:began`);
    expect(events[0]?.eventId).toBe(`${created.jobId}:t:1`);
  });

  it('shows an unanswered attempt as unresolved rather than as nothing', async () => {
    const created = await service.create(request());
    await store.registerInstance({ instanceId: 'run_1', pid: 1, host: 'h', at: T0 });
    const lease = (await store.claimJob({
      jobId: created.jobId,
      instanceId: 'run_1',
      at: T0,
      leaseTtlMs: 60_000,
    })) as JobLease;
    for (const [to, reason] of [
      ['WATCHING', 'ADMITTED'],
      ['TRIGGERED', 'TARGET_SEEN'],
      ['QUOTING', 'QUOTING'],
    ] as const) {
      await store.transition({ lease, to, reason, at: T0 });
    }
    await store.reserveLeg({ lease, legIndex: 0, idempotencyKey: KEY, intent: LEG, at: T0 });
    await store.transition({ lease, to: 'CREATING', reason: 'CREATE', at: T0 });
    await store.beginSideEffect({
      lease,
      attemptId: 'att_1',
      legIndex: 0,
      kind: 'CREATE_EXECUTION',
      requestFingerprint: FINGERPRINT,
      at: later(T0, 1000),
    });

    const events = await service.events(created.jobId);
    const began = events.filter((event) => event.kind === 'SIDE_EFFECT_BEGAN');

    expect(began).toHaveLength(1);
    expect(began[0]).toMatchObject({ unresolved: true, outcome: null, effect: 'CREATE_EXECUTION' });
    expect(events.some((event) => event.kind === 'SIDE_EFFECT_RESOLVED')).toBe(false);
    // And the same fact reaches `get`, where a caller decides whether to reconcile.
    expect((await service.get(created.jobId))?.openSideEffects).toHaveLength(1);
  });

  it('marks the transition that ended the job, and only that one', async () => {
    const created = await service.create(request());
    await service.cancel(created.jobId, 'user asked');
    await store.registerInstance({ instanceId: 'run_1', pid: 1, host: 'h', at: T0 });
    const lease = (await store.claimJob({
      jobId: created.jobId,
      instanceId: 'run_1',
      at: T0,
      leaseTtlMs: 60_000,
    })) as JobLease;
    await new StrategyService({ store, now, leases: holder(lease) }).cancel(
      created.jobId,
      'user asked',
    );

    const events = await service.events(created.jobId);
    expect(events.filter((event) => event.kind === 'TRANSITION' && event.terminal)).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ kind: 'TRANSITION', state: 'CANCELLED', terminal: true });
  });

  it('is empty for a job that does not exist, rather than an error', async () => {
    expect(await service.events('job_nope')).toEqual([]);
  });
});
