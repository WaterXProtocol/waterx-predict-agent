/**
 * What a job that stopped being sure is allowed to conclude.
 *
 * The tests are grouped by the thing that must not happen: a terminal state
 * invented without a server saying so, an attempt closed as "sent" when it was
 * not, and an ambiguity quietly resolved as "nothing happened". Every case runs
 * against a real database, because the read-then-write pair is a transaction
 * claim and an in-memory fake would not test it.
 */
import type { PredictExecutionStatus, SubmitExecutionResponseBody } from '@waterx/predict-agent-sdk';

import { isJobStoreError } from '../src/errors.ts';
import type { JobLease } from '../src/job.ts';
import { reconcileJob, type ReconcileGateway, type ReconcileResult } from '../src/reconciler.ts';
import { SqliteJobStore } from '../src/sqlite/store.ts';
import { jobInput, later, LEG, T0, tempStoreDir, type TempStoreDir } from './harness.ts';

const INSTANCE = 'run_1';
const KEY = '4c1c9d2e-0000-4000-8000-00000000000';
const FINGERPRINT = 'b'.repeat(64);
const NOW = later(T0, 300_000);
const DIGEST = '0xsubmit';
const KEEPER = '0xkeeper';

let dir: TempStoreDir;
let store: SqliteJobStore;
let lease: JobLease;

/** Records what it was asked, so "never called" is assertable. */
interface FakeGateway extends ReconcileGateway {
  readonly calls: string[];
  readonly signals: (AbortSignal | undefined)[];
}

const execution = (
  status: PredictExecutionStatus,
  extra: Partial<SubmitExecutionResponseBody> = {},
): SubmitExecutionResponseBody => ({ executionId: 'exe_1', status, ...extra });

const gatewayOf = (...answers: (SubmitExecutionResponseBody | Error)[]): FakeGateway => {
  const calls: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  return {
    calls,
    signals,
    getExecution: async (executionId, signal) => {
      calls.push(executionId);
      signals.push(signal);
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (answer === undefined) throw new Error(`no scripted answer for ${executionId}`);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
};

interface LegSetup {
  readonly executionId?: string;
  readonly openAttempt?: 'CREATE_EXECUTION' | 'SUBMIT_EXECUTION';
  readonly status?: 'SUCCEEDED' | 'FAILED' | 'SKIPPED';
}

/**
 * Drives a job to `UNKNOWN_PENDING` the way a crash and a recovery pass would
 * have left it, with whatever evidence each leg carries.
 */
const stage = async (legs: readonly LegSetup[]): Promise<void> => {
  await store.registerInstance({ instanceId: INSTANCE, pid: 42, host: 'laptop', at: T0 });
  await store.createJob(jobInput({ intent: legs.map(() => LEG) }));
  lease = (await store.claimJob({
    jobId: 'job_1',
    instanceId: INSTANCE,
    at: T0,
    leaseTtlMs: 600_000,
  })) as JobLease;

  for (const [index, setup] of legs.entries()) {
    await store.reserveLeg({
      lease,
      legIndex: index,
      idempotencyKey: `${KEY}${String(index)}`,
      intent: LEG,
      at: later(T0, 10),
    });
    if (setup.executionId !== undefined || setup.status !== undefined) {
      await store.updateLeg({
        lease,
        legIndex: index,
        at: later(T0, 20),
        ...(setup.executionId === undefined ? {} : { executionId: setup.executionId }),
        ...(setup.status === undefined ? {} : { status: setup.status }),
      });
    }
  }

  let step = 30;
  const path = [
    'WATCHING',
    'TRIGGERED',
    'QUOTING',
    'CREATING',
    'AWAITING_SIGNATURE',
    'SUBMITTING',
  ] as const;
  for (const next of path) {
    await store.transition({ lease, to: next, reason: 'DRIVEN_BY_TEST', at: later(T0, step) });
    step += 10;
  }

  for (const [index, setup] of legs.entries()) {
    if (setup.openAttempt === undefined) continue;
    await store.beginSideEffect({
      lease,
      attemptId: `att_${String(index)}`,
      legIndex: index,
      kind: setup.openAttempt,
      requestFingerprint: FINGERPRINT,
      at: later(T0, step),
    });
  }

  await store.transition({
    lease,
    to: 'UNKNOWN_PENDING',
    reason: 'CRASH_DURING_SIDE_EFFECT',
    at: later(T0, 200),
  });
};

const run = async (gateway: ReconcileGateway, signal?: AbortSignal): Promise<ReconcileResult> =>
  await reconcileJob({
    store,
    gateway,
    lease,
    at: NOW,
    ...(signal === undefined ? {} : { signal }),
  });

const stateOf = async (): Promise<string> => (await store.getJob('job_1'))?.state ?? 'GONE';

beforeEach(() => {
  dir = tempStoreDir();
  store = new SqliteJobStore({ path: dir.path });
});

afterEach(async () => {
  await store.close();
  dir.cleanup();
});

describe('admitting a terminal fact', () => {
  it('ends the job in the state the server reported, and only in that one', async () => {
    const expected = {
      FILLED: 'FILLED',
      REJECTED: 'FAILED',
      CANCELLED: 'CANCELLED',
      EXPIRED: 'EXPIRED',
    } as const;

    for (const [status, jobState] of Object.entries(expected)) {
      dir.cleanup();
      await store.close();
      dir = tempStoreDir();
      store = new SqliteJobStore({ path: dir.path });
      await stage([{ executionId: 'exe_1', openAttempt: 'CREATE_EXECUTION' }]);

      const result = await run(
        gatewayOf(execution(status as PredictExecutionStatus, { transactionDigest: DIGEST })),
      );
      expect(result.disposition, status).toBe('TERMINAL');
      expect(result.to, status).toBe(jobState);
      expect(await stateOf(), status).toBe(jobState);
    }
  });

  it('records the two digests separately, because they are two transactions', async () => {
    // The agent's submit and the keeper's fill are different chain events, and a
    // leg that stored one in the other's field would misattribute the trade.
    await stage([{ executionId: 'exe_1', openAttempt: 'CREATE_EXECUTION' }]);
    await run(
      gatewayOf(
        execution('FILLED', {
          transactionDigest: DIGEST,
          fill: {
            filledAmount: '20.500000',
            filledShares: '25.000000',
            avgFillPrice: '0.8200',
            actualFee: null,
            txDigest: KEEPER,
            filledAt: NOW,
          },
        }),
      ),
    );

    const [leg] = await store.listLegs('job_1');
    expect(leg?.submissionDigest).toBe(DIGEST);
    expect(leg?.keeperDigest).toBe(KEEPER);
    expect(leg?.status).toBe('SUCCEEDED');
  });

  it('resolves the open attempt in the same transaction as the leg', async () => {
    // Separately, a crash between them would leave "no open attempt and no
    // execution id", which recovery reads as "nothing was ever sent".
    await stage([{ executionId: 'exe_1', openAttempt: 'CREATE_EXECUTION' }]);
    await run(gatewayOf(execution('FILLED')));

    expect(await store.listOpenSideEffects('job_1')).toEqual([]);
    const [attempt] = await store.listSideEffects('job_1');
    expect(attempt?.outcome).toBe('SUCCEEDED');
    expect(attempt?.detail?.['resolvedBy']).toBe('RECONCILE');
    expect(attempt?.detail?.['observedStatus']).toBe('FILLED');
  });

  it('goes through RECONCILING, and gets there before it reads', async () => {
    // The order matters after a second crash: a job that had already learned the
    // answer must not still be claiming it does not know.
    await stage([{ executionId: 'exe_1' }]);
    await expect(run(gatewayOf(new Error('socket hang up')))).rejects.toThrow('socket hang up');

    expect(await stateOf()).toBe('RECONCILING');
    const reasons = (await store.listTransitions('job_1')).map((row) => row.reason);
    expect(reasons).toContain('RECONCILE_STARTED');
  });
});

describe('refusing to conclude', () => {
  it('leaves a live execution alone rather than finalizing it on a clock', async () => {
    for (const status of ['SUBMITTED', 'PENDING_FILL'] as const) {
      dir.cleanup();
      await store.close();
      dir = tempStoreDir();
      store = new SqliteJobStore({ path: dir.path });
      await stage([{ executionId: 'exe_1', openAttempt: 'CREATE_EXECUTION' }]);

      const result = await run(gatewayOf(execution(status, { transactionDigest: DIGEST })));
      expect(result.disposition, status).toBe('STILL_PENDING');
      expect(await stateOf(), status).toBe('RECONCILING');
      const [leg] = await store.listLegs('job_1');
      expect(leg?.status, status).toBe('PENDING');
    }
  });

  it('will not decide a create it cannot look up, and says what is missing', async () => {
    // No endpoint maps an idempotency key to an execution, so this is genuinely
    // unknowable rather than unimplemented. Calling it "nothing happened" would
    // re-arm a job whose order may exist.
    await stage([{ openAttempt: 'CREATE_EXECUTION' }]);
    const gateway = gatewayOf(execution('FILLED'));

    const result = await run(gateway);
    expect(result.disposition).toBe('INCONCLUSIVE');
    expect(result.reason).toBe('NO_EXECUTION_ID');
    expect(gateway.calls).toEqual([]);
    expect(await stateOf()).toBe('UNKNOWN_PENDING');
    // The attempt stays open on purpose: it is the only record that a request
    // may be at the server.
    expect((await store.listOpenSideEffects('job_1')).length).toBe(1);
  });

  it('touches nothing when the job was never unresolved', async () => {
    await stage([{ executionId: 'exe_1' }]);
    await store.transition({ lease, to: 'RECONCILING', reason: 'SETUP', at: later(T0, 250) });
    await store.transition({ lease, to: 'WATCHING', reason: 'NOTHING_WAS_SENT', at: later(T0, 260) });
    const before = (await store.listTransitions('job_1')).length;

    const gateway = gatewayOf(execution('FILLED'));
    const result = await run(gateway);

    expect(result.disposition).toBe('NOT_APPLICABLE');
    expect(gateway.calls).toEqual([]);
    expect((await store.listTransitions('job_1')).length).toBe(before);
  });

  it('still answers to the fence', async () => {
    // A reconcile is a write path like any other: an instance that lost the job
    // must not be the one that ends it.
    await stage([{ executionId: 'exe_1' }]);
    const stale = lease;
    await store.registerInstance({
      instanceId: 'run_2',
      pid: 43,
      host: 'laptop',
      at: later(T0, 700_000),
    });
    await store.claimJob({
      jobId: 'job_1',
      instanceId: 'run_2',
      at: later(T0, 700_000),
      leaseTtlMs: 30_000,
    });
    lease = stale;

    await expect(run(gatewayOf(execution('FILLED')))).rejects.toSatisfy(
      (error: unknown) => isJobStoreError(error) && error.code === 'LEASE_LOST',
    );
  });
});

describe('what an open submit attempt is allowed to claim', () => {
  it('does not call a submit successful when the order never left the broker', async () => {
    // `AWAITING_SIGNATURE` with no digest is proof the submit did NOT take
    // effect. Recording SUCCEEDED here would strand a leg the executor believes
    // was sent.
    await stage([{ executionId: 'exe_1', openAttempt: 'SUBMIT_EXECUTION' }]);

    const result = await run(gatewayOf(execution('AWAITING_SIGNATURE')));

    expect(result.disposition).toBe('STILL_PENDING');
    const [attempt] = await store.listSideEffects('job_1');
    expect(attempt?.outcome).toBe('FAILED');
    expect(attempt?.detail?.['submissionObserved']).toBe(false);
  });

  it('accepts a digest as proof that it did', async () => {
    await stage([{ executionId: 'exe_1', openAttempt: 'SUBMIT_EXECUTION' }]);

    await run(gatewayOf(execution('PENDING_FILL', { transactionDigest: DIGEST })));

    const [attempt] = await store.listSideEffects('job_1');
    expect(attempt?.outcome).toBe('SUCCEEDED');
    expect(attempt?.detail?.['submissionObserved']).toBe(true);
  });

  it('settles a create the moment the execution answers at all', async () => {
    // Different question: the create landed, whatever the order goes on to do.
    await stage([{ executionId: 'exe_1', openAttempt: 'CREATE_EXECUTION' }]);

    await run(gatewayOf(execution('RISK_RESERVED')));

    const [attempt] = await store.listSideEffects('job_1');
    expect(attempt?.outcome).toBe('SUCCEEDED');
  });
});

describe('a chain of independent legs', () => {
  it('resolves one leg per pass and holds the job open until none are left', async () => {
    await stage([{ executionId: 'exe_1' }, { executionId: 'exe_2' }]);
    const gateway = gatewayOf(
      execution('FILLED', { executionId: 'exe_1' }),
      { ...execution('REJECTED'), executionId: 'exe_2' },
    );

    const first = await run(gateway);
    expect(first.disposition).toBe('LEG_RESOLVED');
    expect(first.legIndex).toBe(0);
    expect(await stateOf()).toBe('RECONCILING');

    const second = await run(gateway);
    expect(second.legIndex).toBe(1);
    expect(second.disposition).toBe('TERMINAL');
    expect(gateway.calls).toEqual(['exe_1', 'exe_2']);

    // One leg traded, so the job is not a no-op — even though the other was
    // rejected. Legs stay authoritative for the detail (ADR-0001 §15).
    expect(await stateOf()).toBe('FILLED');
    expect((await store.listLegs('job_1')).map((leg) => leg.status)).toEqual([
      'SUCCEEDED',
      'FAILED',
    ]);
  });

  it('reads a resolvable leg before one whose create it can never look up', async () => {
    // Leg 0's create was ambiguous, so it has no execution id and every pass
    // will return INCONCLUSIVE for it. Taken in index order it would hide leg 1
    // forever, and a chain of orders would never conclude because of its first.
    await stage([{ openAttempt: 'CREATE_EXECUTION' }, { executionId: 'exe_2' }]);

    const result = await run(gatewayOf({ ...execution('FILLED'), executionId: 'exe_2' }));

    expect(result.legIndex).toBe(1);
    expect(result.disposition).toBe('LEG_RESOLVED');
    expect((await store.listLegs('job_1'))[1]?.status).toBe('SUCCEEDED');
    // Leg 0 is still open, and the job is still not concluded because of it.
    expect(await stateOf()).toBe('RECONCILING');
  });

  it('keeps a stop that was asked for distinguishable from a failure', async () => {
    await stage([{ executionId: 'exe_1', status: 'SKIPPED' }, { executionId: 'exe_2' }]);

    const result = await run(gatewayOf({ ...execution('CANCELLED'), executionId: 'exe_2' }));

    expect(result.to).toBe('CANCELLED');
    expect(await stateOf()).toBe('CANCELLED');
  });

  it('summarizes a job whose legs were all resolved before the reconcile ran', async () => {
    await stage([{ executionId: 'exe_1', status: 'FAILED' }]);
    const gateway = gatewayOf(execution('FILLED'));

    const result = await run(gateway);

    expect(gateway.calls).toEqual([]);
    expect(result.reason).toBe('ALL_LEGS_RESOLVED');
    expect(await stateOf()).toBe('FAILED');
  });
});

describe('the lease signal', () => {
  it('hands the job’s abort signal to the read', async () => {
    // A Runner that has been fenced out must stop reading on behalf of a job
    // another instance now owns.
    await stage([{ executionId: 'exe_1' }]);
    const controller = new AbortController();
    const gateway = gatewayOf(execution('FILLED'));

    await run(gateway, controller.signal);

    expect(gateway.signals[0]).toBe(controller.signal);
  });
});
