/**
 * Draining: the step `runner.shutdown` was always missing.
 *
 * The assertions worth reading here are the two that decide whether the feature
 * is usable at all.
 *
 * The first is that a **watching** strategy does not hold a drain open. The
 * obvious definition — wait until nothing is non-terminal — makes every drain end
 * by crossing its deadline, because a seven-day watcher is non-terminal for seven
 * days, and an operator who sees `deadlineExceeded` on every upgrade stops reading
 * it. ADR-0009 says "terminal *or safely resumable*", and a job in `WATCHING` is
 * already safely resumable: the store has everything, and the next Runner adopts
 * it. So the drain settles, and reports the non-terminal count as context rather
 * than as a reason to wait.
 *
 * The second is that an **open side-effect attempt** does hold it open, and that
 * running out of time is reported rather than crossed. That row is a request that
 * may have reached the server and whose answer nobody saw; stopping there is how a
 * job becomes `UNKNOWN_PENDING`. An operator who shuts down anyway is choosing to
 * create that ambiguity, and the reply has to let them see it.
 *
 * Everything else follows from those: admission closes at both doors — the socket
 * and the store — while held jobs keep getting passes, which is the whole
 * difference between draining and stopping.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';

import { RunnerDaemon, type RunnerDaemonEvent, type RunnerDaemonHandle } from '../src/daemon.ts';
import { RunnerIpcClient } from '../src/ipc/client.ts';
import type { SchedulerDriver } from '../src/scheduler.ts';
import { SqliteJobStore } from '../src/sqlite/store.ts';
import { jobInput, later, LEG, T0, tempRuntimeDir, type TempRuntimeDir } from './harness.ts';
import { gatewayOf, pricesAt, signer } from './strategy-fakes.ts';

const NOW = later(T0, 600_000);
const KEY = '4c1c9d2e-0000-4000-8000-0000000000aa';

let dir: TempRuntimeDir;
let store: SqliteJobStore;
let daemons: RunnerDaemon[] = [];
let clients: RunnerIpcClient[] = [];
let events: RunnerDaemonEvent[] = [];

/** No real time passes in these tests; a drain polls as fast as the loop allows. */
const noSleep = async (): Promise<void> => undefined;

const startDaemon = async (
  overrides: Partial<ConstructorParameters<typeof RunnerDaemon>[0]> = {},
): Promise<{ daemon: RunnerDaemon; handle: RunnerDaemonHandle }> => {
  const daemon = new RunnerDaemon({
    store,
    runtimeDir: dir.dir,
    instanceId: 'run_live',
    now: () => NOW,
    drainSleep: noSleep,
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  daemons.push(daemon);
  return { daemon, handle: await daemon.start() };
};

const connect = async (handle: RunnerDaemonHandle): Promise<RunnerIpcClient> => {
  const client = await RunnerIpcClient.connect({
    socketPath: handle.socketPath,
    token: handle.token,
    client: 'vitest',
  });
  clients.push(client);
  return client;
};

const driverOf = (): SchedulerDriver => ({
  gateway: gatewayOf({}),
  signer,
  prices: pricesAt(null),
});

/** A job somebody is watching: non-terminal, and nothing in flight. */
const seedWatching = async (jobId: string, instanceId = 'run_live'): Promise<void> => {
  await store.createJob(jobInput({ jobId, at: T0 }));
  await store.registerInstance({ instanceId, pid: 7, host: 'laptop', at: T0 });
  const lease = await store.claimJob({ jobId, instanceId, at: T0, leaseTtlMs: 1_000 });
  if (lease === undefined) throw new Error('seed claim failed');
  await store.transition({ lease, to: 'WATCHING', reason: 'SEED', at: T0 });
};

/** A request that may have left the process, with nobody having seen the answer. */
const seedOpenAttempt = async (jobId: string, instanceId: string): Promise<void> => {
  await store.createJob(jobInput({ jobId, at: T0 }));
  await store.registerInstance({ instanceId, pid: 8, host: 'laptop', at: T0 });
  const lease = await store.claimJob({ jobId, instanceId, at: T0, leaseTtlMs: 600_000 });
  if (lease === undefined) throw new Error('seed claim failed');
  for (const to of ['WATCHING', 'TRIGGERED', 'QUOTING'] as const) {
    await store.transition({ lease, to, reason: 'SEED', at: T0 });
  }
  await store.reserveLeg({ lease, legIndex: 0, idempotencyKey: KEY, intent: LEG, at: T0 });
  await store.transition({ lease, to: 'CREATING', reason: 'SEED', at: T0 });
  await store.beginSideEffect({
    lease,
    attemptId: `att_${jobId}`,
    legIndex: 0,
    kind: 'CREATE_EXECUTION',
    requestFingerprint: 'sha256:seed',
    at: T0,
  });
};

const createRequest = {
  ownerAddress: '0xowner',
  accountId: 'acc_1',
  agentWallet: '0xagent',
  legs: [{ ...LEG }],
  trigger: { kind: 'IMMEDIATE' },
  expiresAt: later(NOW, 3_600_000),
};

const codeOf = async (body: Promise<unknown>): Promise<string> => {
  try {
    await body;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === 'string') return code;
    throw error;
  }
  throw new Error('expected a rejection');
};

beforeEach(() => {
  dir = tempRuntimeDir();
  store = new SqliteJobStore({ path: dir.storePath });
  daemons = [];
  clients = [];
  events = [];
});

afterEach(async () => {
  for (const client of clients) client.close();
  for (const daemon of daemons) await daemon.stop();
  await store.close();
  dir.cleanup();
});

describe('what a drain waits for', () => {
  it('settles with a watching job still non-terminal, because it is safely resumable', async () => {
    await seedWatching('job_watch');
    const { daemon } = await startDaemon();

    const report = await daemon.drain({ deadlineMs: 10_000 });

    // The assertion this whole design turns on: something IS non-terminal, and
    // the drain finished anyway. Waiting for it would mean waiting out its expiry.
    expect(report.nonTerminal).toBeGreaterThan(0);
    expect(report.settled).toBe(true);
    expect(report.deadlineExceeded).toBe(false);
    expect(report.settling).toEqual([]);
  });

  it('waits on this instance’s own open attempt, and reports the deadline rather than crossing it', async () => {
    await seedOpenAttempt('job_inflight', 'run_live');
    const { daemon } = await startDaemon();

    const report = await daemon.drain({ deadlineMs: 0 });

    expect(report.settled).toBe(false);
    expect(report.deadlineExceeded).toBe(true);
    // Named, not counted: an operator deciding whether to stop needs to know
    // which request is outstanding and on which leg.
    expect(report.settling).toEqual([
      {
        attemptId: 'att_job_inflight',
        jobId: 'job_inflight',
        legIndex: 0,
        kind: 'CREATE_EXECUTION',
        startedAt: T0,
      },
    ]);
  });

  it('never waits on an attempt inherited from a dead predecessor, but does report it', async () => {
    await seedOpenAttempt('job_orphan', 'run_crashed');
    const { daemon } = await startDaemon();

    const report = await daemon.drain({ deadlineMs: 10_000 });

    // Unresolvable by staying alive — the create-phase case cannot be settled
    // against this API at all (backlog B9) — so blocking on it would make every
    // drain end on its deadline.
    expect(report.settled).toBe(true);
    expect(report.inherited.map((attempt) => attempt.jobId)).toEqual(['job_orphan']);
    expect(report.settling).toEqual([]);
  });

  it('settles at once on a Runner that never drove anything', async () => {
    const { daemon } = await startDaemon();
    const report = await daemon.drain();
    expect(report.driving).toBe(false);
    expect(report.settled).toBe(true);
  });
});

describe('closing admission', () => {
  it('refuses a strategy over the socket, and writes no job', async () => {
    const { daemon, handle } = await startDaemon();
    const client = await connect(handle);
    await daemon.drain();

    expect(await codeOf(client.request('strategy.create', createRequest))).toBe('RUNNER_DRAINING');
    // The refusal has to be true as well as named: a caller told its strategy
    // was not armed must not find one armed later.
    expect(await store.listJobs()).toHaveLength(0);
  });

  it('stops claiming from the store while still driving what it holds', async () => {
    const { daemon } = await startDaemon({ driver: driverOf(), tickIntervalMs: 60_000 });
    // Created after start-up, so recovery has not already adopted it: this is
    // the claim path a tick uses for a job that appears while the Runner is up.
    await store.createJob(jobInput({ jobId: 'job_new', at: T0 }));

    const before = await daemon.tick();
    expect(before.admitting).toBe(true);
    expect(before.claimed).toEqual(['job_new']);

    await daemon.drain({ deadlineMs: 1_000 });
    await store.createJob(jobInput({ jobId: 'job_later', at: T0 }));
    const after = await daemon.tick();

    expect(after.admitting).toBe(false);
    expect(after.claimed).toEqual([]);
    // Still held, still being passed over: draining is not stopping.
    expect(daemon.strategies).toBeDefined();
    const later = await store.getJob('job_later');
    expect(later?.leaseInstanceId).toBeNull();
    expect(events.some((event) => event.kind === 'scheduler' && event.event.kind === 'admission-closed')).toBe(true);
  });

  it('keeps answering reads and cancellations, which is how an operator helps it finish', async () => {
    await seedWatching('job_watch');
    const { daemon, handle } = await startDaemon();
    const client = await connect(handle);
    await daemon.drain();

    const jobs = (await client.request('runner.jobs')) as { jobs: readonly unknown[] };
    expect(jobs.jobs).toHaveLength(1);
    // Cancelling during a drain is legitimate: it is the operator removing the
    // reason the Runner would otherwise have to stay up.
    const cancelled = (await client.request('runner.cancel-job', {
      jobId: 'job_watch',
      reason: 'DRAINING',
    })) as Record<string, unknown>;
    expect(cancelled['recorded']).toBe(true);
  });

  it('does not stop the process, and does not reopen', async () => {
    const { daemon, handle } = await startDaemon();
    const client = await connect(handle);

    await daemon.drain();
    // Still listening. The exit is a separate command on purpose: a drain that
    // shut down on its own would do it mid-write on exactly the runs where the
    // deadline was exceeded.
    await expect(client.request('runner.status')).resolves.toBeDefined();
    expect(daemon.admitting).toBe(false);

    await daemon.drain();
    expect(daemon.admitting).toBe(false);
  });
});

describe('reporting it', () => {
  it('shows up in runner.status the moment admission closes', async () => {
    const { daemon, handle } = await startDaemon();
    const client = await connect(handle);

    const before = (await client.request('runner.status')) as Record<string, unknown>;
    expect(before['draining']).toBeNull();

    await daemon.drain();
    const after = (await client.request('runner.status')) as Record<string, unknown>;

    // A client polling status must learn this without having to call `drain`
    // itself, which would close admission as a side effect of asking.
    expect(after['draining']).toEqual({
      beganAt: NOW,
      settled: true,
      settling: 0,
      inherited: 0,
    });
  });

  it('joins a drain already in progress rather than starting a second deadline', async () => {
    await seedOpenAttempt('job_inflight', 'run_live');
    const { daemon } = await startDaemon();

    const [first, second] = await Promise.all([
      daemon.drain({ deadlineMs: 0 }),
      daemon.drain({ deadlineMs: 0 }),
    ]);

    expect(first.beganAt).toBe(second.beganAt);
    expect([first.joined, second.joined]).toContain(true);
  });

  it('is reachable over the socket with the deadline the caller chose', async () => {
    await seedOpenAttempt('job_inflight', 'run_live');
    const { handle } = await startDaemon();
    const client = await connect(handle);

    const report = (await client.request('runner.drain', {
      deadlineMs: 0,
    })) as Record<string, unknown>;

    expect(report['admitting']).toBe(false);
    expect(report['settled']).toBe(false);
    expect(report['deadlineExceeded']).toBe(true);
    expect(report['deadlineMs']).toBe(0);
  });
});
