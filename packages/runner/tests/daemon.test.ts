/**
 * The daemon as a whole: what it proves before it opens anything, what it does
 * with the jobs the last process left behind, and what it tells a client about
 * how much of a Runner it actually is.
 *
 * The load-bearing assertion in this file is the boring one — `driving: false`.
 * A reachable Runner looks exactly like a working one until you ask, and this
 * daemon runs no scheduler, holds no signer and watches no prices, so a recovered
 * job sits where recovery put it — `driveJob` existing elsewhere in the package
 * changes nothing a client of *this* process can observe. Everything else here is the trust boundary: a runtime
 * directory that must be private, a token minted per start, and a cancellation
 * that reports what was applied rather than what was asked for.
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  installShutdownHandlers,
  RUNNER_DRIVER_GAPS,
  RunnerDaemon,
  type RunnerDaemonEvent,
  type RunnerDaemonHandle,
  type RunnerDaemonOptions,
} from '../src/daemon.ts';
import { RunnerIpcClient } from '../src/ipc/client.ts';
import { readIpcToken } from '../src/ipc/runtime-dir.ts';
import { SqliteJobStore } from '../src/sqlite/store.ts';
import { jobInput, later, LEG, T0, tempRuntimeDir, type TempRuntimeDir } from './harness.ts';

const KEY = '4c1c9d2e-0000-4000-8000-000000000001';
/** Late enough that the crashed instance's lease has long since expired. */
const NOW = later(T0, 600_000);

let dir: TempRuntimeDir;
let store: SqliteJobStore;
let daemons: RunnerDaemon[] = [];
let clients: RunnerIpcClient[] = [];
let events: RunnerDaemonEvent[] = [];

const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') throw error;
  return code;
};

const rejectsCode = async (body: Promise<unknown>): Promise<string> => {
  try {
    await body;
  } catch (error) {
    return codeOf(error);
  }
  throw new Error('expected a rejection');
};

const startDaemon = async (
  overrides: Partial<RunnerDaemonOptions> = {},
): Promise<RunnerDaemonHandle> => {
  const daemon = new RunnerDaemon({
    store,
    runtimeDir: dir.dir,
    instanceId: 'run_live',
    now: () => NOW,
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  daemons.push(daemon);
  return daemon.start();
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

/** A job that crashed with an order possibly already created. */
const seedInFlight = async (jobId: string): Promise<void> => {
  await store.createJob(jobInput({ jobId, at: T0 }));
  await store.registerInstance({ instanceId: 'run_crashed', pid: 9, host: 'laptop', at: T0 });
  const lease = await store.claimJob({
    jobId,
    instanceId: 'run_crashed',
    at: T0,
    leaseTtlMs: 1_000,
  });
  if (lease === undefined) throw new Error('seed claim failed');
  for (const to of ['WATCHING', 'TRIGGERED', 'QUOTING'] as const) {
    await store.transition({ lease, to, reason: 'SEED', at: T0 });
  }
  await store.reserveLeg({ lease, legIndex: 0, idempotencyKey: KEY, intent: LEG, at: T0 });
  await store.transition({ lease, to: 'CREATING', reason: 'SEED', at: T0 });
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

describe('starting', () => {
  it('mints a token, binds a private socket, and says it is not driving anything', async () => {
    const handle = await startDaemon();

    expect(statSync(handle.tokenPath).mode & 0o777).toBe(0o600);
    expect(readIpcToken(handle.tokenPath)).toBe(handle.token);
    expect(statSync(handle.socketPath).mode & 0o777).toBe(0o600);

    const client = await connect(handle);
    expect(client.driving).toBe(false);

    const status = (await client.request('runner.status')) as Record<string, unknown>;
    expect(status['instanceId']).toBe('run_live');
    expect(status['driving']).toBe(false);
    expect(status['driverGaps']).toEqual([...RUNNER_DRIVER_GAPS]);
    expect(status['store']).toEqual({ kind: 'sqlite' });
  });

  it('never puts the token in an event or a reply', async () => {
    await store.createJob(jobInput());
    const handle = await startDaemon();
    const client = await connect(handle);
    const status = await client.request('runner.status');
    const jobs = await client.request('runner.jobs');

    for (const serialized of [
      JSON.stringify(events),
      JSON.stringify(status),
      JSON.stringify(jobs),
    ]) {
      expect(serialized).not.toContain(handle.token);
    }
  });

  it('refuses to start when the runtime directory is not private to this uid', async () => {
    chmodSync(dir.dir, 0o755);
    const daemon = new RunnerDaemon({ store, runtimeDir: dir.dir, now: () => NOW });
    // The directory mode is what keeps another local account off the socket, so
    // it is a refusal rather than a warning.
    expect(await rejectsCode(daemon.start())).toBe('INSECURE_RUNTIME_DIR');
    chmodSync(dir.dir, 0o700);
    // Nothing was opened: no instance was ever registered.
    expect(await store.listInstances()).toEqual([]);
  });

  it('unwinds rather than leaving a registered instance nobody can reach', async () => {
    const deep = mkdtempSync(join(tmpdir(), 'wx-run-'));
    const doomed = new RunnerDaemon({
      store,
      runtimeDir: join(deep, 'x'.repeat(120)),
      instanceId: 'run_doomed',
      now: () => NOW,
    });
    try {
      expect(await rejectsCode(doomed.start())).toBe('SOCKET_PATH_TOO_LONG');
      const instance = (await store.listInstances()).find((i) => i.instanceId === 'run_doomed');
      // Registered, then stopped. A half-started Runner would look alive to the
      // next one and keep it from recovering the jobs.
      expect(instance?.stoppedAt).toBe(NOW);
    } finally {
      rmSync(deep, { recursive: true, force: true });
    }
  });

  it('refuses to start a second Runner on a socket the first one is using', async () => {
    await startDaemon();
    const second = new RunnerDaemon({
      store,
      runtimeDir: dir.dir,
      instanceId: 'run_second',
      now: () => NOW,
    });
    daemons.push(second);

    expect(await rejectsCode(second.start())).toBe('ADDRESS_IN_USE');
    expect(
      (await store.listInstances()).find((i) => i.instanceId === 'run_second')?.stoppedAt,
    ).toBe(NOW);
  });

  it('mints a fresh token on every start, so a stale one stops working', async () => {
    const first = await startDaemon();
    await daemons[0]?.stop();

    const second = await startDaemon({ instanceId: 'run_live_2' });
    expect(second.token).not.toBe(first.token);
    // A token a crashed Runner left behind must not authenticate against the one
    // that took over.
    expect(
      await rejectsCode(
        RunnerIpcClient.connect({ socketPath: second.socketPath, token: first.token }),
      ),
    ).toBe('UNAUTHENTICATED');
  });
});

describe('recovering before it listens', () => {
  it('holds the lease on every job it recovered', async () => {
    await store.createJob(jobInput({ at: T0 }));
    const handle = await startDaemon();

    expect(handle.recovery.jobs).toEqual([
      { jobId: 'job_1', from: 'DRAFT', to: 'DRAFT', disposition: 'RESUMED', lease: expect.anything() },
    ]);

    const client = await connect(handle);
    const status = (await client.request('runner.status')) as Record<string, unknown>;
    expect(status['leasedHere']).toEqual(['job_1']);
    expect(status['jobs']).toEqual({ total: 1, byState: { DRAFT: 1 } });
  });

  it('reports a crash mid-write as UNKNOWN_PENDING and leaves it there', async () => {
    await seedInFlight('job_1');
    const handle = await startDaemon();

    expect(handle.recovery.jobs[0]).toMatchObject({
      jobId: 'job_1',
      from: 'CREATING',
      to: 'UNKNOWN_PENDING',
      disposition: 'UNKNOWN_PENDING',
    });

    const client = await connect(handle);
    const detail = (await client.request('runner.job', { jobId: 'job_1' })) as {
      job: { state: string };
    };
    // Nothing moves it from here: there is no reconciler, and inventing an
    // outcome is exactly what UNKNOWN_PENDING exists to prevent.
    expect(detail.job.state).toBe('UNKNOWN_PENDING');
  });

  it('reports a job another live Runner holds instead of omitting it', async () => {
    await store.createJob(jobInput({ at: T0 }));
    await store.registerInstance({ instanceId: 'run_other', pid: 7, host: 'laptop', at: NOW });
    await store.claimJob({
      jobId: 'job_1',
      instanceId: 'run_other',
      at: NOW,
      leaseTtlMs: 300_000,
    });

    const handle = await startDaemon();
    expect(handle.recovery.jobs).toEqual([
      { jobId: 'job_1', from: 'DRAFT', to: 'DRAFT', disposition: 'HELD_ELSEWHERE' },
    ]);

    const client = await connect(handle);
    const status = (await client.request('runner.status')) as Record<string, unknown>;
    expect(status['leasedHere']).toEqual([]);
  });
});

describe('the commands a client may actually run', () => {
  let handle: RunnerDaemonHandle;
  let client: RunnerIpcClient;

  beforeEach(async () => {
    await store.createJob(jobInput({ at: T0 }));
    await seedInFlight('job_flight');
    handle = await startDaemon();
    client = await connect(handle);
  });

  it('refuses a real agent command by naming what is missing', async () => {
    // The refusal is the point. A client asking a connected Runner to place an
    // order must be told no, loudly, rather than told the command is unknown.
    expect(await rejectsCode(client.request('order.execute', {}))).toBe('NOT_IMPLEMENTED');
    expect(await rejectsCode(client.request('market.quote', {}))).toBe('NOT_IMPLEMENTED');
    expect(await rejectsCode(client.request('runner.staus', {}))).toBe('UNKNOWN_COMMAND');
  });

  it('validates command input on the socket', async () => {
    expect(await rejectsCode(client.request('runner.job', {}))).toBe('INVALID_INPUT');
    expect(await rejectsCode(client.request('runner.jobs', { state: 'NOPE' }))).toBe(
      'INVALID_INPUT',
    );
  });

  it('keeps the session after a refusal', async () => {
    await rejectsCode(client.request('runner.job', {}));
    expect(await client.request('runner.status')).toMatchObject({ instanceId: 'run_live' });
  });

  it('answers with the store error code for a job that does not exist', async () => {
    expect(await rejectsCode(client.request('runner.job', { jobId: 'job_absent' }))).toBe(
      'UNKNOWN_JOB',
    );
    expect(
      await rejectsCode(client.request('runner.cancel-job', { jobId: 'job_absent', reason: 'x' })),
    ).toBe('UNKNOWN_JOB');
  });

  it('filters the job list by state and account', async () => {
    const byState = (await client.request('runner.jobs', { state: 'DRAFT' })) as {
      jobs: { jobId: string; leasedHere: boolean }[];
    };
    expect(byState.jobs.map((job) => job.jobId)).toEqual(['job_1']);
    expect(byState.jobs[0]?.leasedHere).toBe(true);

    const byAccount = (await client.request('runner.jobs', { accountId: 'nobody' })) as {
      jobs: unknown[];
    };
    expect(byAccount.jobs).toEqual([]);
  });

  it('applies a cancellation only for a job it holds that has not started a write', async () => {
    const applied = (await client.request('runner.cancel-job', {
      jobId: 'job_1',
      reason: 'user asked',
    })) as Record<string, unknown>;

    expect(applied).toMatchObject({
      jobId: 'job_1',
      state: 'CANCELLED',
      recorded: true,
      applied: true,
      terminalAt: NOW,
    });
    expect((await store.getJob('job_1'))?.leaseInstanceId).toBeNull();

    const status = (await client.request('runner.status')) as Record<string, unknown>;
    expect(status['leasedHere']).toEqual(['job_flight']);
  });

  it('records but does not apply a cancellation for a job that may have sent something', async () => {
    const pending = (await client.request('runner.cancel-job', {
      jobId: 'job_flight',
      reason: 'user asked',
    })) as Record<string, unknown>;

    // Replying "cancelled" while a submit may be in flight would report a stop
    // that did not happen.
    expect(pending).toMatchObject({
      jobId: 'job_flight',
      state: 'UNKNOWN_PENDING',
      recorded: true,
      applied: false,
      pending: 'IN_FLIGHT',
      cancelRequestedAt: NOW,
    });
    expect((await store.getJob('job_flight'))?.state).toBe('UNKNOWN_PENDING');
  });

  it('records but does not apply a cancellation for a job no Runner is holding', async () => {
    // Created after recovery, so nothing ever claimed it.
    await store.createJob(jobInput({ jobId: 'job_new', at: NOW }));

    const pending = (await client.request('runner.cancel-job', {
      jobId: 'job_new',
      reason: 'user asked',
    })) as Record<string, unknown>;

    expect(pending).toMatchObject({
      jobId: 'job_new',
      recorded: true,
      applied: false,
      pending: 'NOT_LEASED_BY_THIS_RUNNER',
    });
    expect((await store.getJob('job_new'))?.state).toBe('DRAFT');
  });
});

describe('stopping', () => {
  it('answers the shutdown request before it closes the socket', async () => {
    await store.createJob(jobInput({ at: T0 }));
    let announceStopped = (): void => {};
    const stopped = new Promise<void>((resolve) => {
      announceStopped = resolve;
    });

    const handle = await startDaemon({
      onEvent: (event) => {
        events.push(event);
        if (event.kind === 'stopped') announceStopped();
      },
    });
    const client = await connect(handle);

    // The reply has to arrive first: a client that asked for a shutdown and got
    // a dropped connection could not tell it from a Runner that crashed.
    expect(await client.request('runner.shutdown', { reason: 'test' })).toEqual({
      stopping: true,
      instanceId: 'run_live',
      reason: 'test',
    });

    await stopped;
    expect(existsSync(handle.socketPath)).toBe(false);
    const instance = (await store.listInstances()).find((i) => i.instanceId === 'run_live');
    expect(instance?.stoppedAt).toBe(NOW);
    // Handed back, so the next Runner need not wait out the TTL.
    expect((await store.getJob('job_1'))?.leaseInstanceId).toBeNull();
  });

  it('is safe to stop twice', async () => {
    await startDaemon();
    const daemon = daemons[0];
    await Promise.all([daemon?.stop(), daemon?.stop()]);
    expect(events.filter((event) => event.kind === 'stopped')).toHaveLength(1);
  });

  it('exposes the last recovery report without an IPC round trip', async () => {
    await store.createJob(jobInput({ at: T0 }));
    const handle = await startDaemon();
    expect(daemons[0]?.lastRecovery()).toEqual(handle.recovery);
  });
});

describe('signal handling', () => {
  it('stops the daemon on SIGINT and SIGTERM without signalling a real process', async () => {
    const handlers = new Map<string, () => void>();
    const emitter = {
      once: (signal: string, handler: () => void) => {
        handlers.set(signal, handler);
        return emitter;
      },
    } as unknown as Pick<NodeJS.Process, 'once'>;

    let stops = 0;
    installShutdownHandlers(
      {
        stop: async () => {
          stops += 1;
        },
      },
      emitter,
    );

    expect([...handlers.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);
    handlers.get('SIGTERM')?.();
    // SIGKILL cannot be handled, which is exactly why the store is arranged to
    // survive it.
    expect(stops).toBe(1);
  });
});
