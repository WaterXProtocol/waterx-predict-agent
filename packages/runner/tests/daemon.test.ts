/**
 * The daemon as a whole: what it proves before it opens anything, what it does
 * with the jobs the last process left behind, and what it tells a client about
 * how much of a Runner it actually is.
 *
 * The load-bearing assertions in this file are the boring ones — `driving: false`
 * and `driving: true`. A reachable Runner looks exactly like a working one until
 * you ask. Started with no `driver` this daemon runs no scheduler, holds no signer
 * and watches no prices, so a recovered job sits where recovery put it, and both
 * the handshake and `runner.status` say so; started with all three, the same job
 * goes all the way to a fill. Whether it drives is a decision the caller made, and
 * these tests assert the daemon reports the one that was actually made rather than
 * the one the package is capable of. Everything else here is the trust boundary: a
 * runtime directory that must be private, a token minted per start, and a
 * cancellation that reports what was applied rather than what was asked for.
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
import type { PriceTopicStatus } from '../src/prices.ts';
import { readIpcToken } from '../src/ipc/runtime-dir.ts';
import type { SchedulerDriver } from '../src/scheduler.ts';
import { SqliteJobStore } from '../src/sqlite/store.ts';
import { jobInput, later, LEG, T0, tempRuntimeDir, type TempRuntimeDir } from './harness.ts';
import {
  created,
  gatewayOf,
  pricesAt,
  quote,
  signer,
  TRIGGER as FAKE_TRIGGER,
} from './strategy-fakes.ts';

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

describe('a daemon that was given a driver', () => {
  /**
   * The other half of `driving: false`. The flag is a decision — supply the three
   * collaborators and it flips, and so does everything a client reads off it.
   * Without them the daemon says so, and `tick` refuses rather than pretending a
   * pass happened.
   */
  const driver = (): SchedulerDriver => ({
    gateway: gatewayOf({
      // The shared fakes are minted around their own clock; this daemon's is ten
      // minutes later, and a stale quote is refused rather than executed.
      quotes: [quote({ asOf: NOW, expiresAt: later(NOW, 30_000) })],
      creates: [{ ...created('exe_1'), signatureExpiresAt: later(NOW, 120_000) }],
      submits: [{ executionId: 'exe_1', status: 'SUBMITTED' }],
      executions: { exe_1: { executionId: 'exe_1', status: 'FILLED' } },
    }),
    signer,
    prices: pricesAt('0.900000'),
  });

  it('reports that it is driving, and actually drives a recovered job', async () => {
    await store.createJob(jobInput({ at: T0, trigger: FAKE_TRIGGER, expiresAt: later(NOW, 86_400_000) }));
    // A long interval: every pass below is asked for explicitly, so the assertion
    // is about the daemon's decision to drive rather than about timing.
    const handle = await startDaemon({ driver: driver(), tickIntervalMs: 3_600_000 });

    expect(handle.driving).toBe(true);
    const client = await connect(handle);
    expect(client.driving).toBe(true);
    const status = (await client.request('runner.status')) as Record<string, unknown>;
    expect(status['driving']).toBe(true);
    expect(status['driverGaps']).toEqual([]);

    // Recovery already claimed the job, so a single pass arms it and the next one
    // takes it all the way through the server.
    await daemons[0]?.tick();
    await daemons[0]?.tick();
    expect((await store.getJob('job_1'))?.state).toBe('FILLED');
  });

  it('still refuses an agent command on the socket, and says why differently', async () => {
    const handle = await startDaemon({ driver: driver(), tickIntervalMs: 3_600_000 });
    const client = await connect(handle);

    const error = await client.request('order.execute', {}).then(
      () => undefined,
      (caught: unknown) => caught as { code?: string; message?: string },
    );
    expect(error?.code).toBe('NOT_IMPLEMENTED');
    // Not "missing a signer" — it has one. The refusal is about surface, not gaps.
    expect(error?.message).toContain('drives durable jobs, not one-shot intents');
  });

  it('refuses a tick when nothing was given to drive with', async () => {
    await startDaemon();
    await expect(daemons[0]?.tick()).rejects.toThrow(/without a driver/);
  });

  it('stops the loop before it hands the leases back', async () => {
    await store.createJob(jobInput({ at: T0, trigger: FAKE_TRIGGER, expiresAt: later(NOW, 86_400_000) }));
    const handle = await startDaemon({ driver: driver(), tickIntervalMs: 3_600_000 });
    expect(handle.driving).toBe(true);

    await daemons[0]?.stop();

    expect(daemons[0]?.driving).toBe(false);
    // Stopped cleanly: the job is where the last completed pass left it, not
    // half-written by a pass that was abandoned.
    expect((await store.getJob('job_1'))?.state).toBe('DRAFT');
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

/**
 * The strategy surface, which is the first thing on this socket that writes
 * something a person would call a trade.
 *
 * Two properties carry the weight here. The mandate is *configuration*: a peer
 * cannot send one, and a daemon nobody configured refuses to arm anything, so the
 * failure mode of an unfinished install is a Runner that says no rather than one
 * that signs. And the answers are the service's own — the refusals a client sees
 * are `EXPIRY_REQUIRED` and `SIZE_AMBIGUOUS`, not a schema violation, because the
 * socket delegates to `StrategyService` instead of re-deciding what a strategy is.
 */
describe('strategies over the socket', () => {
  const DELEGATED = {
    mode: 'delegated-auto',
    source: 'file:/etc/waterx/runner.json',
    maxOrderNotional: '250.00',
  } as const;

  const buyLeg = {
    marketId: 'mkt_btts_yes',
    outcomeId: 'YES',
    side: 'BUY',
    buyAmount: '25.000000',
    maxSlippageBps: 50,
  } as const;

  const createBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    ownerAddress: '0xowner',
    accountId: 'acct_1',
    agentWallet: '0xagent',
    legs: [buyLeg],
    trigger: { kind: 'PRICE', targetPrice: '0.450000' },
    expiresAt: later(NOW, 3_600_000),
    ...overrides,
  });

  it('refuses to arm anything when nobody configured a mandate', async () => {
    // The default is `interactive`: a durable strategy fires while nobody is being
    // asked, so an unconfigured Runner must not accept one.
    const client = await connect(await startDaemon());

    expect(await rejectsCode(client.request('strategy.create', createBody()))).toBe(
      'POLICY_REQUIRES_DELEGATION',
    );
    expect(await store.listJobs()).toEqual([]);
  });

  it('admits a strategy under the host policy, ignoring anything the client sends', async () => {
    const client = await connect(await startDaemon({ policy: DELEGATED }));

    // There is no `policy` input at all, so this is refused before it reaches the
    // service — a peer able to name its own mode would be granting itself the
    // authority to sign unattended.
    expect(
      await rejectsCode(
        client.request(
          'strategy.create',
          createBody({ policy: { mode: 'delegated-auto', source: 'the client said so' } }),
        ),
      ),
    ).toBe('INVALID_INPUT');

    const reply = (await client.request('strategy.create', createBody())) as {
      strategy: { jobId: string; state: string; expiry: { expiresAt: string } };
      policy: { mode: string; source: string };
      driving: boolean;
      driverGaps: string[];
    };

    expect(reply.strategy.state).toBe('DRAFT');
    expect(reply.policy).toEqual({ mode: 'delegated-auto', source: DELEGATED.source });
    // A durable job now exists that nothing in this process will ever advance, and
    // the reply says so in the same breath as the job id.
    expect(reply.driving).toBe(false);
    expect(reply.driverGaps).toEqual([...RUNNER_DRIVER_GAPS]);

    const stored = await store.getJob(reply.strategy.jobId);
    expect(stored?.policy).toEqual(DELEGATED);
    expect(stored?.expiresAt).toBe(later(NOW, 3_600_000));
  });

  it('answers with the strategy rule that was broken, not with a schema violation', async () => {
    const client = await connect(await startDaemon({ policy: DELEGATED }));

    // Mandatory, and there is no permanent watcher to fall back on (ADR-0005).
    expect(
      await rejectsCode(client.request('strategy.create', createBody({ expiresAt: undefined }))),
    ).toBe('EXPIRY_REQUIRED');
    expect(
      await rejectsCode(
        client.request('strategy.create', createBody({ expiresAt: later(NOW, 8 * 86_400_000) })),
      ),
    ).toBe('EXPIRY_TOO_FAR');
    // Ambiguity stops before a write: a BUY carrying a share count is not resolved
    // by picking one.
    expect(
      await rejectsCode(
        client.request(
          'strategy.create',
          createBody({ legs: [{ ...buyLeg, sellShares: '10.000000' }] }),
        ),
      ),
    ).toBe('SIZE_AMBIGUOUS');
    // A percentage SELL freezes shares at creation, which takes a position read —
    // and a driverless daemon has no server to read one from. Named, not guessed.
    expect(
      await rejectsCode(
        client.request(
          'strategy.create',
          createBody({
            legs: [
              {
                marketId: 'mkt_btts_yes',
                outcomeId: 'YES',
                side: 'SELL',
                sellFractionOfPosition: '0.5',
                positionId: 'pos_1',
                maxSlippageBps: 50,
              },
            ],
          }),
        ),
      ),
    ).toBe('POSITION_READ_UNAVAILABLE');

    expect(await store.listJobs()).toEqual([]);
  });

  it('reads back, lists, follows and cancels the job it created', async () => {
    const client = await connect(await startDaemon({ policy: DELEGATED }));
    const { strategy } = (await client.request('strategy.create', createBody())) as {
      strategy: { jobId: string; strategyId: string };
    };

    const got = (await client.request('strategy.get', { jobId: strategy.jobId })) as {
      strategy: {
        state: string;
        job: { intent: unknown[] };
        legs: unknown[];
        openSideEffects: unknown[];
      };
      leasedHere: boolean;
    };
    expect(got.strategy.state).toBe('DRAFT');
    expect(got.strategy.job.intent).toHaveLength(1);
    // Empty, and that is the answer: a row appears here when a leg is *reserved*
    // under an idempotency key, so nothing has been committed to on the server.
    expect(got.strategy.legs).toEqual([]);
    expect(got.strategy.openSideEffects).toEqual([]);
    // Created after recovery, so this instance never claimed it. Honest rather
    // than flattering: nothing is running this job.
    expect(got.leasedHere).toBe(false);

    const listed = (await client.request('strategy.list', {
      strategyId: strategy.strategyId,
    })) as { strategies: { jobId: string }[] };
    expect(listed.strategies.map((entry) => entry.jobId)).toEqual([strategy.jobId]);
    expect(
      ((await client.request('strategy.list', { accountId: 'nobody' })) as { strategies: unknown[] })
        .strategies,
    ).toEqual([]);

    const feed = (await client.request('strategy.events', { jobId: strategy.jobId })) as {
      state: string;
      events: { kind: string }[];
    };
    expect(feed.state).toBe('DRAFT');
    expect(feed.events.map((event) => event.kind)).toEqual(['TRANSITION']);

    const cancelled = (await client.request('strategy.cancel', {
      jobId: strategy.jobId,
      reason: 'user asked',
    })) as Record<string, unknown>;
    // No lease here, so the request is durable and unapplied — the same answer
    // `runner.cancel-job` gives, because it is the same implementation.
    expect(cancelled).toMatchObject({
      jobId: strategy.jobId,
      recorded: true,
      applied: false,
      pending: 'NOT_LEASED_BY_THIS_RUNNER',
    });
    expect((await store.getJob(strategy.jobId))?.cancelRequestedAt).toBe(NOW);
  });

  it('refuses an unknown job rather than answering an empty feed', async () => {
    const client = await connect(await startDaemon({ policy: DELEGATED }));
    // `StrategyService.events` answers `[]` for a job it has never heard of, which
    // over a socket would let a typo'd id read as a job that has done nothing yet.
    expect(await rejectsCode(client.request('strategy.events', { jobId: 'job_absent' }))).toBe(
      'UNKNOWN_JOB',
    );
    expect(await rejectsCode(client.request('strategy.get', { jobId: 'job_absent' }))).toBe(
      'UNKNOWN_JOB',
    );
  });

  it('serves the socket from the same service an embedder gets', async () => {
    // Not two services over one store: a second one would be a second set of
    // sizing and expiry rules reachable from the same process.
    const handle = await startDaemon({ policy: DELEGATED });
    const client = await connect(handle);
    const { strategy } = (await client.request('strategy.create', createBody())) as {
      strategy: { jobId: string };
    };

    const direct = await daemons[0]?.strategies.get(strategy.jobId);
    expect(direct?.jobId).toBe(strategy.jobId);
    expect(daemons[0]?.admissionPolicy).toEqual(DELEGATED);
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

/**
 * What an operator reads when a Runner is not driving, and what a client reads
 * when it is. Both answers are about not mistaking one silence for another.
 */
describe('what the status says about why', () => {
  it('reports the configuration gaps it was given rather than a generic list', async () => {
    // `runnerd` knows *why* it built no driver — a missing keystore command is a
    // line an operator can add. "No signer" would only restate the absence.
    const handle = await startDaemon({ driverGaps: ['signer-command'] });
    const client = await connect(handle);

    const status = (await client.request('runner.status')) as Record<string, unknown>;
    expect(status['driving']).toBe(false);
    expect(status['driverGaps']).toEqual(['signer-command']);
  });

  it('says nothing about prices when nothing is watching them', async () => {
    const handle = await startDaemon();
    const client = await connect(handle);

    // `null`, not an empty report: a Runner with no price source at all is not
    // the same as one watching a market that has gone quiet.
    const status = (await client.request('runner.status')) as Record<string, unknown>;
    expect(status['prices']).toBeNull();
  });

  it('surfaces a feed that has given up, which otherwise looks like a quiet market', async () => {
    const topics: PriceTopicStatus[] = [
      {
        marketId: 'mkt_1',
        outcomeId: 'YES',
        subscribedAt: T0,
        lastAskedAt: NOW,
        lastObservedAt: undefined,
        unavailable: 'DEGRADED',
        gapped: false,
      },
      {
        marketId: 'mkt_2',
        outcomeId: 'NO',
        subscribedAt: T0,
        lastAskedAt: NOW,
        lastObservedAt: undefined,
        unavailable: undefined,
        gapped: true,
      },
    ];
    const handle = await startDaemon({ priceTopics: () => topics });
    const client = await connect(handle);

    const status = (await client.request('runner.status')) as Record<string, unknown>;
    const prices = status['prices'] as Record<string, unknown>;
    expect(prices['watching']).toBe(2);
    // The one status that never recovers on its own: those topics answer nothing
    // for the life of the process, and every job watching them waits forever.
    expect(prices['degraded']).toBe(1);
    // Subscribed but never observed — a job that has not been able to trigger yet.
    expect(prices['silent']).toBe(2);
    expect((prices['topics'] as Record<string, unknown>[])[1]).toMatchObject({
      marketId: 'mkt_2',
      gapped: true,
      unavailable: null,
      lastObservedAt: null,
    });
  });
});
