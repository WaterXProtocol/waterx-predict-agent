/**
 * What a Runner does with the jobs it finds after it stopped without warning.
 *
 * The table in `classify` is asserted as a table, and then the same five crash
 * points are staged against a real database that is closed and reopened, because
 * the property under test is what survives the close.
 */
import type { JobLease } from '../src/job.ts';
import { classify, recoverJobs, type RecoveryReport } from '../src/recovery.ts';
import { SqliteJobStore } from '../src/sqlite/store.ts';
import type { JobState } from '../src/state-machine.ts';
import { jobInput, later, LEG, T0, tempStoreDir, type TempStoreDir } from './harness.ts';

const KEY = '4c1c9d2e-0000-4000-8000-000000000001';
const FINGERPRINT = 'a'.repeat(64);
const CRASHED = 'run_crashed';
const RESTARTED = 'run_restarted';
/** The lease the crashed instance held is long expired by the time we recover. */
const RECOVER_AT = later(T0, 600_000);

const NO_EVIDENCE = {
  hasOpenAttempt: false,
  hasAbandonedAttempt: false,
  hasExecution: false,
  cancelRequested: false,
  expired: false,
} as const;

let dir: TempStoreDir;
let store: SqliteJobStore;

const open = (): SqliteJobStore => new SqliteJobStore({ path: dir.path });

beforeEach(() => {
  dir = tempStoreDir();
  store = open();
});

afterEach(async () => {
  await store.close();
  dir.cleanup();
});

describe('the recovery decision, as a table', () => {
  it('treats an unresolved attempt as the strongest evidence there is', () => {
    // Outranks a pending cancellation and a passed expiry: a request may already
    // be at the server, and ending the job locally would report a stop that did
    // not happen.
    const plan = classify({
      ...NO_EVIDENCE,
      state: 'SUBMITTING',
      hasOpenAttempt: true,
      cancelRequested: true,
      expired: true,
    });
    expect(plan).toEqual({
      to: 'UNKNOWN_PENDING',
      disposition: 'UNKNOWN_PENDING',
      reason: 'CRASH_DURING_SIDE_EFFECT',
    });
  });

  it('sends a recorded execution to be read back rather than re-sent', () => {
    expect(classify({ ...NO_EVIDENCE, state: 'CREATING', hasExecution: true }).to).toBe(
      'RECONCILING',
    );
  });

  it('resolves a job that was already UNKNOWN_PENDING through a reconcile', () => {
    expect(classify({ ...NO_EVIDENCE, state: 'UNKNOWN_PENDING' })).toEqual({
      to: 'RECONCILING',
      disposition: 'RECONCILE',
      reason: 'RESOLVE_UNKNOWN_PENDING',
    });
  });

  it('will not re-arm an in-flight state that has no execution id', () => {
    // The genuinely ambiguous case: the state says an order may exist, nothing
    // on disk says whether it does. Re-arming here is exactly how a duplicate is
    // placed, so the job stops and waits for a reconcile.
    for (const state of ['CREATING', 'AWAITING_SIGNATURE', 'SUBMITTING', 'SUBMITTED'] as const) {
      expect(classify({ ...NO_EVIDENCE, state }), state).toEqual({
        to: 'UNKNOWN_PENDING',
        disposition: 'UNKNOWN_PENDING',
        reason: 'IN_FLIGHT_WITHOUT_EXECUTION',
      });
    }
  });

  it('treats an abandoned attempt as in-flight, not as a failure', () => {
    expect(classify({ ...NO_EVIDENCE, state: 'WATCHING', hasAbandonedAttempt: true }).to).toBe(
      'UNKNOWN_PENDING',
    );
  });

  it('applies a cancellation and an expiry only before anything was sent', () => {
    expect(classify({ ...NO_EVIDENCE, state: 'WATCHING', cancelRequested: true }).to).toBe(
      'CANCELLED',
    );
    expect(classify({ ...NO_EVIDENCE, state: 'WATCHING', expired: true }).to).toBe('EXPIRED');
    // A cancellation outranks an expiry only in the reason recorded; both end the
    // job, and the request is the more specific fact.
    expect(
      classify({ ...NO_EVIDENCE, state: 'PAUSED', cancelRequested: true, expired: true }).reason,
    ).toBe('CANCEL_REQUESTED');
  });

  it('re-arms a trigger that fired but sent nothing', () => {
    // A quote taken before the crash is stale and a target seen before it is not
    // evidence about now, so the trigger is observed again from WATCHING.
    for (const state of ['TRIGGERED', 'QUOTING'] as const) {
      expect(classify({ ...NO_EVIDENCE, state }), state).toEqual({
        to: 'WATCHING',
        disposition: 'REARMED',
        reason: 'NOTHING_WAS_SENT',
      });
    }
  });

  it('leaves a quiet job where it was', () => {
    for (const state of ['DRAFT', 'WATCHING', 'PAUSED'] as const) {
      expect(classify({ ...NO_EVIDENCE, state }), state).toEqual({
        to: state,
        disposition: 'RESUMED',
        reason: 'RESUMED',
      });
    }
  });
});

describe('recovery against a database that was reopened', () => {
  /** Puts a job on disk in `state`, with whatever evidence the crash left. */
  const crash = async (options: {
    readonly state: JobState;
    readonly jobId?: string;
    readonly reserveLeg?: boolean;
    readonly openAttempt?: boolean;
    readonly executionId?: string;
    readonly expiresAt?: string;
    readonly cancel?: boolean;
  }): Promise<void> => {
    const jobId = options.jobId ?? 'job_1';
    await store.registerInstance({ instanceId: CRASHED, pid: 111, host: 'laptop', at: T0 });
    await store.createJob(
      jobInput({
        jobId,
        at: T0,
        ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
      }),
    );
    const lease = (await store.claimJob({
      jobId,
      instanceId: CRASHED,
      at: T0,
      leaseTtlMs: 30_000,
    })) as JobLease;

    if (options.reserveLeg === true || options.openAttempt === true) {
      await store.reserveLeg({
        lease,
        legIndex: 0,
        idempotencyKey: `${KEY}-${jobId}`,
        intent: LEG,
        at: later(T0, 10),
      });
    }

    const path: readonly JobState[] = [
      'WATCHING',
      'TRIGGERED',
      'QUOTING',
      'CREATING',
      'AWAITING_SIGNATURE',
      'SUBMITTING',
      'SUBMITTED',
    ];
    let step = 20;
    for (const next of path) {
      await store.transition({ lease, to: next, reason: 'DRIVEN_BY_TEST', at: later(T0, step) });
      step += 10;
      if (next === options.state) break;
    }

    if (options.openAttempt === true) {
      await store.beginSideEffect({
        lease,
        attemptId: `att_${jobId}`,
        legIndex: 0,
        kind: 'CREATE_EXECUTION',
        requestFingerprint: FINGERPRINT,
        at: later(T0, step),
      });
    }
    if (options.executionId !== undefined) {
      await store.updateLeg({
        lease,
        legIndex: 0,
        at: later(T0, step),
        executionId: options.executionId,
      });
    }
    if (options.cancel === true) {
      await store.requestCancel(jobId, 'user asked', later(T0, step));
    }

    // The crash: no `stopInstance`, no `releaseJob`, no clean close of anything
    // but the file handle.
    await store.close();
    store = open();
  };

  const recover = async (at = RECOVER_AT): Promise<RecoveryReport> => {
    await store.registerInstance({ instanceId: RESTARTED, pid: 333, host: 'laptop', at });
    return recoverJobs({ store, instanceId: RESTARTED, at, leaseTtlMs: 30_000, staleAfterMs: 60_000 });
  };

  it('re-arms a job whose key was minted but never used', async () => {
    await crash({ state: 'QUOTING', reserveLeg: true });
    const report = await recover();
    expect(report.jobs).toHaveLength(1);
    expect(report.jobs[0]?.disposition).toBe('REARMED');
    expect(report.jobs[0]?.to).toBe('WATCHING');

    // The key is kept, not reissued: when the order is finally sent it carries the
    // same key, so a request that did leave earlier could only ever dedupe.
    expect((await store.listLegs('job_1'))[0]?.idempotencyKey).toBe(`${KEY}-job_1`);
    expect((await store.getJob('job_1'))?.state).toBe('WATCHING');
  });

  it('stops a job whose request may have been sent', async () => {
    await crash({ state: 'CREATING', openAttempt: true });
    const report = await recover();
    expect(report.jobs[0]?.disposition).toBe('UNKNOWN_PENDING');
    expect(report.jobs[0]?.openAttemptId).toBe('att_job_1');
    expect((await store.getJob('job_1'))?.state).toBe('UNKNOWN_PENDING');
    // Still unresolved: recovery records what it found, it does not decide the
    // request's fate. Only the server can.
    expect(await store.listOpenSideEffects('job_1')).toHaveLength(1);
  });

  it('reconciles a job whose execution id reached the disk', async () => {
    await crash({ state: 'CREATING', reserveLeg: true, executionId: 'exec_1' });
    const report = await recover();
    expect(report.jobs[0]?.disposition).toBe('RECONCILE');
    expect(report.jobs[0]?.executionId).toBe('exec_1');
    expect((await store.getJob('job_1'))?.state).toBe('RECONCILING');
  });

  it('stops a submit that was in flight', async () => {
    await crash({ state: 'SUBMITTING', openAttempt: true });
    const report = await recover();
    expect(report.jobs[0]?.disposition).toBe('UNKNOWN_PENDING');
    expect((await store.getJob('job_1'))?.state).toBe('UNKNOWN_PENDING');
  });

  it('leaves alone a job another live Runner is holding', async () => {
    await crash({ state: 'WATCHING' });
    await store.registerInstance({ instanceId: 'run_other', pid: 222, host: 'laptop', at: T0 });
    await store.claimJob({
      jobId: 'job_1',
      instanceId: 'run_other',
      at: RECOVER_AT,
      leaseTtlMs: 30_000,
    });

    const report = await recover();
    expect(report.jobs[0]?.disposition).toBe('HELD_ELSEWHERE');
    expect(report.jobs[0]?.lease).toBeUndefined();
    const job = await store.getJob('job_1');
    expect(job?.state).toBe('WATCHING');
    expect(job?.leaseInstanceId).toBe('run_other');
  });

  it('expires a watcher whose deadline passed while nothing was running', async () => {
    await crash({ state: 'WATCHING', expiresAt: later(T0, 60_000) });
    const report = await recover();
    expect(report.jobs[0]?.disposition).toBe('EXPIRED');
    const job = await store.getJob('job_1');
    expect(job?.state).toBe('EXPIRED');
    expect(job?.terminalAt).toBe(RECOVER_AT);
    // Terminal jobs hand no lease back — `transition` cleared it, and reporting
    // one would be a claim a caller could act on.
    expect(report.jobs[0]?.lease).toBeUndefined();
    expect(job?.leaseInstanceId).toBeNull();
  });

  it('applies a cancellation that arrived while no Runner was up', async () => {
    await crash({ state: 'WATCHING', cancel: true });
    const report = await recover();
    expect(report.jobs[0]?.disposition).toBe('CANCELLED');
    expect((await store.getJob('job_1'))?.state).toBe('CANCELLED');
  });

  it('refuses to expire or cancel a job that may already have an order', async () => {
    await crash({
      state: 'SUBMITTED',
      openAttempt: true,
      expiresAt: later(T0, 60_000),
      cancel: true,
    });
    const report = await recover();
    expect(report.jobs[0]?.disposition).toBe('UNKNOWN_PENDING');
    const job = await store.getJob('job_1');
    expect(job?.state).toBe('UNKNOWN_PENDING');
    // The request is still recorded and will be honoured once the order's fate is
    // known — it is not lost, it is just not applied yet.
    expect(job?.cancelRequestedAt).not.toBeNull();
  });

  it('keeps a job UNKNOWN_PENDING for as long as the attempt is unresolved', async () => {
    await crash({ state: 'CREATING', openAttempt: true });
    await recover();
    // A second restart before anything resolved the attempt learns nothing new,
    // so it must not soften its answer.
    const second = await recover(later(RECOVER_AT, 120_000));
    expect(second.jobs[0]?.disposition).toBe('UNKNOWN_PENDING');
    expect((await store.getJob('job_1'))?.state).toBe('UNKNOWN_PENDING');
  });

  it('moves an UNKNOWN_PENDING job to a reconcile once the attempt is closed out', async () => {
    await crash({ state: 'CREATING', openAttempt: true });
    const first = await recover();
    const lease = first.jobs[0]?.lease;
    if (lease === undefined) throw new Error('expected a lease');

    // ABANDONED, not FAILED: the Runner never saw a reply, so "it did not happen"
    // is not a fact it holds. Closing the attempt only stops it blocking; the
    // reconcile under the original key is what decides.
    await store.completeSideEffect({
      lease,
      attemptId: 'att_job_1',
      outcome: 'ABANDONED',
      at: later(RECOVER_AT, 1_000),
    });

    const second = await recover(later(RECOVER_AT, 120_000));
    expect(second.jobs[0]?.disposition).toBe('RECONCILE');
    expect(second.jobs[0]?.to).toBe('RECONCILING');
    expect((await store.getJob('job_1'))?.state).toBe('RECONCILING');
  });

  it('ignores jobs that already ended', async () => {
    await crash({ state: 'WATCHING', cancel: true });
    await recover();
    const again = await recover(later(RECOVER_AT, 60_000));
    expect(again.jobs).toEqual([]);
  });

  it('names the instances that stopped reporting', async () => {
    await crash({ state: 'WATCHING' });
    const report = await recover();
    // With a self-hosted Runner these are strategies nobody was watching, which
    // is a fact the operator has to be told rather than one to smooth over.
    expect(report.staleInstances.map((instance) => instance.instanceId)).toEqual([CRASHED]);
    expect(report.instanceId).toBe(RESTARTED);
  });

  it('does not call a cleanly stopped instance stale', async () => {
    await crash({ state: 'WATCHING' });
    await store.stopInstance(CRASHED, later(T0, 100));
    expect((await recover()).staleInstances).toEqual([]);
  });

  it('recovers every job it finds, one crash point each', async () => {
    await crash({ state: 'QUOTING', jobId: 'job_1', reserveLeg: true });
    await crash({ state: 'CREATING', jobId: 'job_2', openAttempt: true });
    await crash({ state: 'CREATING', jobId: 'job_3', reserveLeg: true, executionId: 'exec_3' });

    const report = await recover();
    expect(
      Object.fromEntries(report.jobs.map((job) => [job.jobId, job.disposition])),
    ).toEqual({
      job_1: 'REARMED',
      job_2: 'UNKNOWN_PENDING',
      job_3: 'RECONCILE',
    });
    // Each runnable job comes back leased by this instance, so nothing else can
    // pick it up behind the executor that is about to drive it.
    for (const job of report.jobs) {
      expect(job.lease?.instanceId, job.jobId).toBe(RESTARTED);
    }
  });

  it('records a refused transition rather than forcing one', async () => {
    await crash({ state: 'WATCHING' });
    await store.registerInstance({
      instanceId: RESTARTED,
      pid: 333,
      host: 'laptop',
      at: RECOVER_AT,
    });
    // A job in a state whose recovery target the machine does not admit must be
    // reported, not driven: an inconsistency here is a bug worth seeing, and
    // pushing through it is how one bug becomes a duplicate order.
    const broken = {
      ...store,
      kind: 'sqlite',
      listJobs: store.listJobs.bind(store),
      listInstances: store.listInstances.bind(store),
      claimJob: store.claimJob.bind(store),
      listLegs: store.listLegs.bind(store),
      listOpenSideEffects: store.listOpenSideEffects.bind(store),
      listSideEffects: store.listSideEffects.bind(store),
      transition: async () => {
        throw new Error('disk went away');
      },
    } as unknown as SqliteJobStore;

    const report = await recoverJobs({
      store: broken,
      instanceId: RESTARTED,
      at: RECOVER_AT,
      leaseTtlMs: 30_000,
      staleAfterMs: 60_000,
    });
    expect(report.jobs[0]?.disposition).toBe('RESUMED');

    const expiring = await recoverJobs({
      store: broken,
      instanceId: RESTARTED,
      at: later(T0, 86_400_000 * 2),
      leaseTtlMs: 30_000,
      staleAfterMs: 60_000,
    });
    expect(expiring.jobs[0]?.disposition).toBe('UNRESOLVED');
    expect(expiring.jobs[0]?.error).toContain('disk went away');
    expect((await store.getJob('job_1'))?.state).toBe('WATCHING');
  });
});
