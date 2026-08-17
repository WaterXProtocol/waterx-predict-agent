/**
 * The loop, and the four ways a loop places an order twice.
 *
 * `driveJob` has its own suite proving what one pass may send. This one proves
 * the thing above it: that passes happen at all, that they happen once, that a
 * Runner which has been fenced out stops making them, and that one broken job
 * cannot quietly stop every other strategy from being watched.
 *
 * Same rule as the driver's tests — a real SQLite file, no sockets, no
 * processes, and (except where the timer itself is under test) no timers. A tick
 * is called by hand so every assertion is about the scheduler's decisions rather
 * than about how fast the machine ran.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { JobLease } from '../src/job.ts';
import { JobScheduler, type SchedulerDriver, type SchedulerEvent } from '../src/scheduler.ts';
import { SqliteJobStore } from '../src/sqlite/store.ts';
import type { JobState } from '../src/state-machine.ts';
import type { JobStore } from '../src/store.ts';
import { LeaseKeeper, type HeldLease } from '../src/supervisor.ts';
import { jobInput, later, T0, tempStoreDir, type TempStoreDir } from './harness.ts';
import {
  created,
  gatewayOf,
  INSTANCE,
  NOW,
  pricesAt,
  quote,
  signer,
  TRIGGER,
  type Recorder,
  type Script,
} from './strategy-fakes.ts';

const LEASE_TTL_MS = 600_000;

let dir: TempStoreDir;
let store: SqliteJobStore;
let leases: LeaseKeeper;
let events: SchedulerEvent[];
let clock: string;

/** A server that fills whatever it is asked to, in one pass. */
const healthy = (overrides: Script = {}): Recorder =>
  gatewayOf({
    quotes: [quote()],
    creates: [created('exe_1')],
    submits: [{ executionId: 'exe_1', status: 'SUBMITTED', transactionDigest: '0xsubmit' }],
    executions: { exe_1: { executionId: 'exe_1', status: 'FILLED' } },
    ...overrides,
  });

const driverOf = (gateway: Recorder, ...observed: (string | null)[]): SchedulerDriver => ({
  gateway,
  signer,
  prices: pricesAt(...(observed.length > 0 ? observed : ['0.900000'])),
});

const schedulerOf = (
  driver: SchedulerDriver,
  overrides: { readonly store?: JobStore; readonly maxJobs?: number; readonly leases?: LeaseKeeper } = {},
): JobScheduler =>
  new JobScheduler({
    store: overrides.store ?? store,
    leases: overrides.leases ?? leases,
    instanceId: INSTANCE,
    now: () => clock,
    driver,
    leaseTtlMs: LEASE_TTL_MS,
    tickIntervalMs: 5,
    ...(overrides.maxJobs === undefined ? {} : { maxJobs: overrides.maxJobs }),
    onEvent: (event) => events.push(event),
  });

const arm = async (jobId = 'job_1', overrides: Parameters<typeof jobInput>[0] = {}): Promise<void> => {
  await store.createJob(jobInput({ jobId, trigger: TRIGGER, ...overrides }));
};

const stateOf = async (jobId = 'job_1'): Promise<JobState | undefined> =>
  (await store.getJob(jobId))?.state;

/** A second live Runner against the same database, which is the fencing case. */
const otherRunnerClaims = async (jobId: string): Promise<void> => {
  await store.registerInstance({ instanceId: 'run_other', pid: 43, host: 'laptop', at: clock });
  await store.claimJob({
    jobId,
    instanceId: 'run_other',
    at: clock,
    leaseTtlMs: LEASE_TTL_MS,
  });
};

beforeEach(async () => {
  dir = tempStoreDir();
  store = new SqliteJobStore({ path: dir.path });
  events = [];
  clock = NOW;
  await store.registerInstance({ instanceId: INSTANCE, pid: 42, host: 'laptop', at: T0 });
  leases = new LeaseKeeper({
    store,
    instanceId: INSTANCE,
    now: () => clock,
    leaseTtlMs: LEASE_TTL_MS,
    renewIntervalMs: 60_000,
    safetyMarginMs: 30_000,
  });
});

afterEach(async () => {
  await store.close();
  dir.cleanup();
});

describe('the loop', () => {
  it('takes a draft to a fill with nothing but ticks', async () => {
    await arm();
    const gateway = healthy();
    // Below the target, then above it: the job has to actually wait for one tick
    // rather than trigger on whatever the first observation happened to be.
    const scheduler = schedulerOf(driverOf(gateway, '0.810000', '0.900000'));

    const first = await scheduler.tick();
    expect(first.claimed).toEqual(['job_1']);
    expect(first.passes.map((pass) => pass.action)).toEqual(['ARMED']);
    expect(await stateOf()).toBe('WATCHING');

    const second = await scheduler.tick();
    expect(second.claimed).toEqual([]);
    expect(second.passes.map((pass) => pass.action)).toEqual(['WAITING']);

    // One pass covers trigger, quote, create, sign, submit and reconcile, so the
    // action a filled job reports is the ending, not the send.
    const third = await scheduler.tick();
    expect(third.passes.map((pass) => pass.action)).toEqual(['ENDED']);
    expect(third.passes[0]?.to).toBe('FILLED');
    expect(third.released).toEqual(['job_1']);
    expect(await stateOf()).toBe('FILLED');

    // One logical submission, and the job is nobody's responsibility now.
    expect(gateway.createCalls.length).toBe(1);
    expect(gateway.submitCalls).toEqual(['exe_1']);
    expect(leases.isHeld('job_1')).toBe(false);
    expect(events.filter((event) => event.kind === 'released').length).toBe(1);
  });

  it('does not pay for a pass on a job that already ended', async () => {
    await arm();
    const gateway = healthy();
    const scheduler = schedulerOf(driverOf(gateway));

    await scheduler.tick(); // ARMED
    await scheduler.tick(); // triggered, executed, reconciled to FILLED, released
    const reads = gateway.marketCalls.length;

    const after = await scheduler.tick();
    // Terminal jobs are not claimable, so the loop never even looks at it again.
    expect(after.claimed).toEqual([]);
    expect(after.passes).toEqual([]);
    expect(gateway.marketCalls.length).toBe(reads);
  });
});

describe('a tick that overlaps itself', () => {
  it('joins the tick in flight instead of driving the job twice', async () => {
    await arm();
    // A pass held open at its first read, so a second tick is guaranteed to
    // arrive while the first one is still inside `driveJob`.
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gateway = healthy();
    const slow: Recorder = {
      ...gateway,
      getMarket: async (marketId) => {
        await held;
        return await gateway.getMarket(marketId);
      },
    };
    const scheduler = schedulerOf(driverOf(slow));

    await scheduler.tick(); // ARMED — the next tick is the one that reads a market.
    const first = scheduler.tick();
    const second = scheduler.tick();
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(b.joined).toBe(true);
    expect(a.passes.map((pass) => pass.to)).toEqual(['FILLED']);
    expect(b.passes).toEqual(a.passes);
    // The point of the guard: two ticks, one create.
    expect(gateway.createCalls.length).toBe(1);
    expect(gateway.submitCalls).toEqual(['exe_1']);
  });
});

describe('claiming', () => {
  it('picks up a job another process created after it started', async () => {
    const scheduler = schedulerOf(driverOf(healthy(), '0.100000'));
    expect((await scheduler.tick()).claimed).toEqual([]);

    await arm('job_late');

    expect((await scheduler.tick()).claimed).toEqual(['job_late']);
    expect(leases.isHeld('job_late')).toBe(true);
  });

  it('leaves a job a live Runner already holds alone, and does not call it a failure', async () => {
    await arm();
    await otherRunnerClaims('job_1');
    const gateway = healthy();

    const report = await schedulerOf(driverOf(gateway)).tick();

    expect(report.claimed).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(events.filter((event) => event.kind === 'error')).toEqual([]);
    expect(gateway.marketCalls).toEqual([]);
  });

  it('stops at maxJobs and says how many it left for somebody else', async () => {
    await arm('job_a');
    await arm('job_b');
    await arm('job_c');
    const scheduler = schedulerOf(driverOf(healthy(), '0.100000'), { maxJobs: 2 });

    const report = await scheduler.tick();

    expect(report.claimed.length).toBe(2);
    expect(report.deferred).toBe(1);
    expect(events).toContainEqual({ kind: 'at-capacity', held: 0, deferred: 1 });
  });

  it('reports a store it cannot list rather than ending the loop', async () => {
    const broken: JobStore = {
      ...store,
      listJobs: async () => {
        throw new Error('database is locked');
      },
    } as unknown as JobStore;
    const scheduler = schedulerOf(driverOf(healthy()), { store: broken });

    const report = await scheduler.tick();

    expect(report.claimed).toEqual([]);
    expect(events).toContainEqual({
      kind: 'error',
      context: 'list-claimable',
      message: 'database is locked',
    });
  });
});

describe('a job that fails', () => {
  it('cannot stop the other jobs from being driven', async () => {
    await arm('job_a');
    await arm('job_b');
    const gateway = healthy();
    // Only `job_a` is broken. `job_b` shares the same store and the same tick.
    const flaky: JobStore = new Proxy(store, {
      get(target, property, receiver): unknown {
        const value: unknown = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]): unknown => {
          if (property === 'getJob' && args[0] === 'job_a') throw new Error('job_a is cursed');
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as JobStore;
    const scheduler = schedulerOf(driverOf(gateway), { store: flaky });

    const report = await scheduler.tick();

    expect(report.failures).toEqual([{ jobId: 'job_a', message: 'job_a is cursed' }]);
    expect(report.passes.map((pass) => pass.jobId)).toEqual(['job_b']);
    expect(await stateOf('job_b')).toBe('WATCHING');
    // Still held: a pass that threw is not evidence that this Runner lost the job.
    expect(leases.isHeld('job_a')).toBe(true);
  });

  it('stops holding a job it has been fenced out of', async () => {
    await arm();
    const scheduler = schedulerOf(driverOf(healthy()));
    await scheduler.tick();
    expect(leases.isHeld('job_1')).toBe(true);

    // Another Runner takes the job after this one's lease expires.
    clock = later(NOW, LEASE_TTL_MS + 1000);
    await otherRunnerClaims('job_1');

    const report = await scheduler.tick();

    expect(report.failures[0]?.jobId).toBe('job_1');
    expect(leases.isHeld('job_1')).toBe(false);
    expect(events).toContainEqual({ kind: 'error', jobId: 'job_1', context: 'drive', message: expect.any(String) });
  });

  it('never starts a pass whose lease has already been aborted', async () => {
    /**
     * The keeper aborts a job's signal the instant this instance may no longer
     * write for it, and that can land between the tick's snapshot of held jobs
     * and the pass itself. A scheduler that read the market anyway would be
     * paying for a request whose every write is already doomed.
     */
    class Fenced extends LeaseKeeper {
      override hold(lease: JobLease): HeldLease {
        const view = super.hold(lease);
        const controller = new AbortController();
        controller.abort(new Error('fenced out between the snapshot and the pass'));
        return { ...view, signal: controller.signal };
      }
    }
    await arm();
    const gateway = healthy();
    const fenced = new Fenced({
      store,
      instanceId: INSTANCE,
      now: () => clock,
      leaseTtlMs: LEASE_TTL_MS,
      renewIntervalMs: 60_000,
      safetyMarginMs: 30_000,
    });
    const scheduler = schedulerOf(driverOf(gateway), { leases: fenced });

    const report = await scheduler.tick();

    expect(report.claimed).toEqual(['job_1']);
    expect(report.passes).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(gateway.marketCalls).toEqual([]);
    expect(await stateOf()).toBe('DRAFT');
  });
});

describe('endings the loop causes by itself', () => {
  it('expires a job because time passed, with no server involved', async () => {
    await arm('job_1', { expiresAt: later(NOW, 60_000) });
    const gateway = healthy();
    const scheduler = schedulerOf(driverOf(gateway));

    await scheduler.tick(); // ARMED, still inside its expiry.
    clock = later(NOW, 120_000);
    const report = await scheduler.tick();

    expect(report.passes[0]?.action).toBe('ENDED');
    expect(await stateOf()).toBe('EXPIRED');
    expect(report.released).toEqual(['job_1']);
    // The whole point of ADR-0004's capped expiry: it fires without a market read.
    expect(gateway.marketCalls).toEqual([]);
  });

  it('applies a cancellation another process recorded', async () => {
    await arm();
    const gateway = healthy();
    const scheduler = schedulerOf(driverOf(gateway));
    await scheduler.tick(); // ARMED

    await store.requestCancel('job_1', 'OWNER_ASKED', clock);
    const report = await scheduler.tick();

    expect(report.passes[0]?.action).toBe('ENDED');
    expect(await stateOf()).toBe('CANCELLED');
    expect(gateway.marketCalls).toEqual([]);
    expect(leases.isHeld('job_1')).toBe(false);
  });
});

describe('start and stop', () => {
  it('drives on its own once started, and reports that it is', async () => {
    await arm();
    const gateway = healthy();
    const scheduler = schedulerOf(driverOf(gateway));

    expect(scheduler.started).toBe(false);
    scheduler.start();
    expect(scheduler.started).toBe(true);
    scheduler.start(); // idempotent: no second interval

    await until(async () => (await stateOf()) === 'FILLED');
    await scheduler.stop();

    expect(scheduler.started).toBe(false);
    expect(gateway.createCalls.length).toBe(1);
  });

  it('waits for the pass in flight rather than abandoning it half-written', async () => {
    await arm();
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gateway = healthy();
    const slow: Recorder = {
      ...gateway,
      submitExecution: async (executionId, signature, options) => {
        await held;
        return await gateway.submitExecution(executionId, signature, options);
      },
    };
    const scheduler = schedulerOf(driverOf(slow));
    await scheduler.tick(); // ARMED

    const pass = scheduler.tick();
    const stopping = scheduler.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    release();
    await Promise.all([pass, stopping]);

    expect(stopped).toBe(true);
    expect(await stateOf()).toBe('FILLED');
  });

  it('will not start again after it has stopped', async () => {
    await arm();
    const scheduler = schedulerOf(driverOf(healthy()));
    await scheduler.stop();
    scheduler.start();

    expect(scheduler.started).toBe(false);
    expect(await stateOf()).toBe('DRAFT');
  });
});

/** Polls a condition instead of sleeping a fixed amount. No wall-clock guesses. */
const until = async (predicate: () => Promise<boolean>, attempts = 200): Promise<void> => {
  for (let index = 0; index < attempts; index += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition never became true');
};
