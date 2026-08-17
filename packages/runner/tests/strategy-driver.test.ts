/**
 * What a strategy actually does, and what it must never do twice.
 *
 * The property under test in the last group is the whole reason this package
 * exists: **exactly one logical submission per leg, across a crash at any
 * side-effect boundary.** So those tests do not fake the store. They open a real
 * SQLite file, kill the pass at a chosen boundary by making the very next write
 * throw, CLOSE the database the way a dying process would, reopen it, run
 * recovery, and then count what the gateway was ever asked to send. A store
 * double would prove only that the double behaves.
 *
 * The crash is injected at the STORE, not at the gateway, on purpose. A gateway
 * that throws is a failure the driver handles — it records the ambiguity and
 * moves the job to `UNKNOWN_PENDING`. A process that dies gets to write nothing
 * at all, and that is the case the ledger has to survive.
 */
import { existsSync, readFileSync } from 'node:fs';

import type {
  PredictAgentMarket,
  PredictExecutionStatus,
  SubmitExecutionResponseBody,
} from '@waterx/predict-agent-sdk';
import { PredictAgentTransportError } from '@waterx/predict-agent-sdk';

import type { JobLease, JobLegIntent, JobRecord } from '../src/job.ts';
import { recoverJobs } from '../src/recovery.ts';
import { createExternalCommandSigner } from '../src/signer.ts';
import { SqliteJobStore } from '../src/sqlite/store.ts';
import type { JobState } from '../src/state-machine.ts';
import type { JobStore, TransitionInput } from '../src/store.ts';
import { driveJob, type DriveResult } from '../src/strategy/driver.ts';
import type { PriceObserver, StrategyGateway, StrategySigner } from '../src/strategy/gateway.ts';
import { jobInput, later, LEG, T0, tempStoreDir, type TempStoreDir } from './harness.ts';
import {
  apiError,
  BYTES,
  created,
  gatewayOf,
  INSTANCE,
  limits,
  market,
  MARKET,
  NOW,
  pricesAt,
  quote,
  SIGNATURE,
  signer,
  TRIGGER,
} from './strategy-fakes.ts';

/* ── A real store, and a way to kill it mid-pass ───────────────────────────── */

class Crash extends Error {
  override readonly name = 'Crash';
}

/**
 * The store, with a trip wire. `hook` runs BEFORE the delegated call, so a throw
 * from it leaves the database in exactly the state a process that died one
 * instruction earlier would have left it in.
 */
const wired = (inner: JobStore, hook: (method: string, args: readonly unknown[]) => void): JobStore =>
  new Proxy(inner, {
    get(target, property, receiver): unknown {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        hook(String(property), args);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as JobStore;

/** Dies just before the job records that it reached `state`. */
const crashBefore = (inner: JobStore, state: JobState): JobStore =>
  wired(inner, (method, args) => {
    if (method !== 'transition') return;
    if ((args[0] as TransitionInput).to === state) throw new Crash(`crash before ${state}`);
  });

let dir: TempStoreDir;
let store: SqliteJobStore;
let lease: JobLease;

const open = (): SqliteJobStore => new SqliteJobStore({ path: dir.path });

const arm = async (overrides: Parameters<typeof jobInput>[0] = {}): Promise<JobRecord> => {
  await store.registerInstance({ instanceId: INSTANCE, pid: 42, host: 'laptop', at: T0 });
  const job = await store.createJob(jobInput({ trigger: TRIGGER, ...overrides }));
  lease = (await store.claimJob({
    jobId: job.jobId,
    instanceId: INSTANCE,
    at: T0,
    leaseTtlMs: 600_000,
  })) as JobLease;
  await store.transition({ lease, to: 'WATCHING', reason: 'SETUP', at: T0 });
  return job;
};

const drive = async (
  gateway: StrategyGateway,
  prices: PriceObserver,
  options: { at?: string; store?: JobStore; signer?: StrategySigner } = {},
): Promise<DriveResult> =>
  await driveJob({
    store: options.store ?? store,
    gateway,
    signer: options.signer ?? signer,
    prices,
    lease,
    at: options.at ?? NOW,
  });

const stateOf = async (): Promise<JobState> => (await store.getJob('job_1'))?.state ?? 'DRAFT';

/** Re-claims after a reopen, the way a restarted Runner does. */
const restart = async (at: string = later(NOW, 1000)): Promise<void> => {
  await store.close();
  store = open();
  const report = await recoverJobs({
    store,
    instanceId: INSTANCE,
    at,
    leaseTtlMs: 600_000,
    staleAfterMs: 60_000,
  });
  const recovered = report.jobs[0];
  if (recovered?.lease !== undefined) lease = recovered.lease;
};

beforeEach(() => {
  dir = tempStoreDir();
  store = open();
});

afterEach(async () => {
  await store.close();
  dir.cleanup();
});

/* ── Watching ──────────────────────────────────────────────────────────────── */

describe('watching a price', () => {
  it('arms a draft before it watches anything', async () => {
    await store.registerInstance({ instanceId: INSTANCE, pid: 42, host: 'laptop', at: T0 });
    await store.createJob(jobInput({ trigger: TRIGGER }));
    lease = (await store.claimJob({
      jobId: 'job_1',
      instanceId: INSTANCE,
      at: T0,
      leaseTtlMs: 600_000,
    })) as JobLease;

    const gateway = gatewayOf();
    const result = await drive(gateway, pricesAt('0.900000'));

    expect(result.action).toBe('ARMED');
    expect(await stateOf()).toBe('WATCHING');
    // Arming is not watching: nothing was read on the pass that only armed.
    expect(gateway.marketCalls).toEqual([]);
  });

  it('waits when the feed says nothing, rather than reading silence as a price', async () => {
    await arm();
    const gateway = gatewayOf();

    const result = await drive(gateway, pricesAt(null));

    expect(result.action).toBe('WAITING');
    expect(result.reason).toBe('NO_PRICE_OBSERVED');
    expect(gateway.quoteCalls).toEqual([]);
    expect(await stateOf()).toBe('WATCHING');
  });

  it('waits while a SELL floor has not been reached', async () => {
    await arm();
    const gateway = gatewayOf();

    const result = await drive(gateway, pricesAt('0.810000'));

    expect(result.reason).toBe('TARGET_NOT_MET');
    expect(gateway.quoteCalls).toEqual([]);
  });

  it('prices the order off a fresh quote, never off the observed price', async () => {
    await arm();
    const gateway = gatewayOf({
      quotes: [quote()],
      creates: [created('exe_1')],
      submits: [{ executionId: 'exe_1', status: 'SUBMITTED', transactionDigest: '0xsubmit' }],
      executions: { exe_1: { executionId: 'exe_1', status: 'PENDING_FILL' } },
    });

    const result = await drive(gateway, pricesAt('0.900000'));

    expect(result.action).toBe('EXECUTED');
    expect(gateway.quoteCalls).toEqual([
      { marketId: MARKET, outcomeId: 'YES', side: 'SELL', size: { sellShares: '25.000000' } },
    ]);
    expect(gateway.createCalls[0]?.body.referenceQuoteId).toBe('q_1');
  });

  it('goes back to watching when the executable quote no longer meets the target', async () => {
    await arm();
    // The indicative bid said 0.90; the quote that can actually be executed says
    // 0.81, below the floor. ADR-0001 §14: re-arm, never trade at the worse price.
    const gateway = gatewayOf({ quotes: [quote({ expectedPrice: '0.810000' })] });

    const result = await drive(gateway, pricesAt('0.900000'));

    expect(result.action).toBe('REARMED');
    expect(result.legs?.[0]?.skip?.reason).toBe('TARGET_NO_LONGER_MET');
    expect(gateway.createCalls).toEqual([]);
    expect(await stateOf()).toBe('WATCHING');
    // Nothing was reserved, so no key was minted for an order that never was.
    expect(await store.listLegs('job_1')).toEqual([]);
  });

  it('refuses a quote that arrived already expired', async () => {
    await arm();
    const gateway = gatewayOf({ quotes: [quote({ expiresAt: later(NOW, -1) })] });

    const result = await drive(gateway, pricesAt('0.900000'));

    expect(result.legs?.[0]?.skip?.reason).toBe('QUOTE_EXPIRED');
    expect(gateway.createCalls).toEqual([]);
  });
});

/* ── Pausing ───────────────────────────────────────────────────────────────── */

describe('a market that stops trading', () => {
  it('pauses on an untradeable market and keeps the original expiry', async () => {
    const job = await arm();
    const gateway = gatewayOf({ markets: [market({ tradeable: false })] });

    const result = await drive(gateway, pricesAt('0.900000'));

    expect(result.action).toBe('PAUSED');
    expect(result.reason).toBe('MARKET_NOT_TRADEABLE');
    expect(await stateOf()).toBe('PAUSED');
    expect((await store.getJob('job_1'))?.expiresAt).toBe(job.expiresAt);
  });

  it('resumes into watching, never straight into an order', async () => {
    await arm();
    await drive(gatewayOf({ markets: [market({ tradeable: false })] }), pricesAt('0.900000'));

    // Quotable again, but the target is not met on this pass.
    const result = await drive(gatewayOf(), pricesAt('0.500000'));

    expect(result.action).toBe('RESUMED');
    expect(await stateOf()).toBe('WATCHING');
  });

  it('stays paused without writing the same fact twice', async () => {
    await arm();
    const gateway = gatewayOf({ markets: [market({ tradeable: false })] });
    await drive(gateway, pricesAt('0.900000'));
    const before = (await store.listTransitions('job_1')).length;

    const result = await drive(gateway, pricesAt('0.900000'));

    expect(result.action).toBe('WAITING');
    expect((await store.listTransitions('job_1')).length).toBe(before);
  });

  it('ends the job when the market resolved, because it will not quote again', async () => {
    await arm();
    const gateway = gatewayOf({ markets: [market({ status: 'RESOLVED', tradeable: false })] });

    const result = await drive(gateway, pricesAt('0.900000'));

    expect(result.action).toBe('ENDED');
    expect(result.reason).toBe('MARKET_RESOLVED');
    expect(await stateOf()).toBe('FAILED');
  });

  it('pauses rather than ends on a status this build does not know', async () => {
    await arm();
    const gateway = gatewayOf({
      markets: [market({ status: 'HALTED' as PredictAgentMarket['status'], tradeable: false })],
    });

    expect((await drive(gateway, pricesAt('0.900000'))).reason).toBe('MARKET_STATUS_UNKNOWN');
    expect(await stateOf()).toBe('PAUSED');
  });
});

/* ── The authority a job was admitted under ────────────────────────────────── */

describe('a job whose policy cannot authorize an unattended write', () => {
  /**
   * These records cannot be created through `normalizeStrategy` any more — it
   * refuses both modes. They are written straight to the store here, which is
   * exactly the case this check exists for: a row an older build wrote, or one
   * written by a surface that skipped normalization.
   */
  const armUnder = async (mode: string): Promise<void> => {
    await arm({
      policy: { mode: mode as 'interactive', source: 'file:policy.json' },
    });
  };

  it('ends an interactive job at the trigger, and reads nothing to decide it', async () => {
    await armUnder('interactive');
    const gateway = gatewayOf();

    const result = await drive(gateway, pricesAt('0.900000'));

    expect(result.reason).toBe('POLICY_REQUIRES_APPROVAL');
    expect(await stateOf()).toBe('FAILED');
    // The cheapest question in the pass, so it is asked first: no limits read, no
    // market read, no quote, and above all no execution created for an order this
    // Runner could never have authorized.
    expect(gateway.marketCalls).toEqual([]);
    expect(gateway.quoteCalls).toEqual([]);
    expect(gateway.createCalls).toEqual([]);
  });

  it('ends a read-only job at the trigger for the same reason', async () => {
    await armUnder('read-only');
    const gateway = gatewayOf();

    const result = await drive(gateway, pricesAt('0.900000'));

    expect(result.reason).toBe('POLICY_READ_ONLY');
    expect(await stateOf()).toBe('FAILED');
    expect(gateway.createCalls).toEqual([]);
  });

  it('pauses on a policy mode it does not recognize, rather than ending the job', async () => {
    await armUnder('delegated-auto-v2');
    const gateway = gatewayOf();

    const result = await drive(gateway, pricesAt('0.900000'));

    // ADR-0004's rule, applied to an authority instead of a market: the build that
    // understands this mode may be the next one to start, and a job ended here
    // could not be brought back by installing it.
    expect(result.reason).toBe('POLICY_MODE_UNRECOGNIZED');
    expect(await stateOf()).toBe('PAUSED');
    expect(gateway.createCalls).toEqual([]);
  });
});

describe('a signer that refuses', () => {
  /**
   * The real gate, wired into a real pass. No child process and no key: `run` is
   * injected, and it fails loudly, because a spawn here would mean the gate let
   * through a job it was built to stop.
   */
  const gatedSigner = (signingAt: string): StrategySigner =>
    createExternalCommandSigner({
      command: ['/opt/keystore/bin/sign'],
      agentWallet: '0xagent',
      now: () => signingAt,
      run: async () => {
        throw new Error('the signer spawned a child for a job it should have refused');
      },
    });

  it('leaves a created execution unsigned, records the reason, and lets the reconciler own it', async () => {
    // The snapshot says delegated-auto and its scope is still open when preflight
    // reads it, so the pass proceeds — and by the time the bytes come back the
    // mandate has run out. This state exists only because the scope is read
    // twice, once before the network calls and once at the signature itself.
    await arm({ policy: { ...jobInput().policy, notAfter: later(NOW, 5_000) } });
    const gateway = gatewayOf({
      quotes: [quote()],
      creates: [created('exe_1')],
      executions: { exe_1: { executionId: 'exe_1', status: 'AWAITING_SIGNATURE' } },
    });

    const result = await drive(gateway, pricesAt('0.900000'), {
      signer: gatedSigner(later(NOW, 10_000)),
    });

    // The execution EXISTS. A policy that forbids signing does not un-create it,
    // and this module never calls an order failed on its own reading.
    expect(gateway.createCalls).toHaveLength(1);
    expect(gateway.submitCalls).toEqual([]);
    expect(result.reason).toBe('NOTHING_SIGNED');
    expect(result.legs?.[0]?.signRefusedCode).toBe('POLICY_SCOPE_EXPIRED');
    // Kept apart from a server refusal: the two send an operator to different
    // systems, and this one is local.
    expect(result.legs?.[0]?.refusedCode).toBeUndefined();

    const events = await store.listTransitions('job_1');
    const nothingSigned = events.find((event) => event.reason === 'NOTHING_SIGNED');
    expect(nothingSigned?.detail).toMatchObject({
      unsigned: [{ legIndex: 0, code: 'POLICY_SCOPE_EXPIRED' }],
    });
  });

  it('records a code even for a refusal that is not a SignerError', async () => {
    await arm();
    const gateway = gatewayOf({
      quotes: [quote()],
      creates: [created('exe_1')],
      executions: { exe_1: { executionId: 'exe_1', status: 'AWAITING_SIGNATURE' } },
    });

    const result = await drive(gateway, pricesAt('0.900000'), {
      signer: { sign: async () => Promise.reject(new Error('keystore socket closed')) },
    });

    // A third-party signer may throw anything. The leg still reports *that* it
    // was refused, because silence here is a leg nobody looks for.
    expect(result.legs?.[0]?.signRefusedCode).toBe('SIGNER_ERROR');
    expect(gateway.submitCalls).toEqual([]);
  });
});

/* ── Fresh authorization ───────────────────────────────────────────────────── */

describe('what is re-read at the trigger', () => {
  it('ends the job when the owner revoked the permission it needs', async () => {
    await arm();
    const gateway = gatewayOf({
      limits: limits({
        delegation: { mayPlaceOrder: true, mayRequestClose: false, checkedAt: T0 },
      }),
    });

    const result = await drive(gateway, pricesAt('0.900000'));

    expect(result.reason).toBe('DELEGATION_REVOKED');
    expect(await stateOf()).toBe('FAILED');
    expect(gateway.quoteCalls).toEqual([]);
  });

  it('pauses when the chain read failed, because null is not a denial', async () => {
    await arm();
    const gateway = gatewayOf({
      limits: limits({
        delegation: { mayPlaceOrder: true, mayRequestClose: null, checkedAt: T0 },
      }),
    });

    const result = await drive(gateway, pricesAt('0.900000'));

    expect(result.reason).toBe('DELEGATION_UNREADABLE');
    expect(await stateOf()).toBe('PAUSED');
  });

  it('pauses on an owner blocker rather than deciding for itself', async () => {
    await arm();
    const gateway = gatewayOf({ limits: limits({ blockers: ['ORDERS_PER_HOUR_EXHAUSTED'] }) });

    const result = await drive(gateway, pricesAt('0.900000'));

    expect(result.reason).toBe('BLOCKED');
    expect(result.detail).toMatchObject({ blockers: ['ORDERS_PER_HOUR_EXHAUSTED'] });
    expect(await stateOf()).toBe('PAUSED');
  });

  it('pauses when no mandate has been granted', async () => {
    await arm();
    const gateway = gatewayOf({ limits: limits({ limits: null, allowance: null }) });

    expect((await drive(gateway, pricesAt('0.900000'))).reason).toBe('NO_MANDATE');
  });

  it('ends the job when the local mandate ran out while it was armed', async () => {
    await arm({
      policy: {
        mode: 'delegated-auto',
        source: 'file:~/.waterx/policy.json',
        notAfter: later(T0, 30_000),
      },
    });

    const result = await drive(gatewayOf(), pricesAt('0.900000'));

    expect(result.reason).toBe('POLICY_EXPIRED');
    expect(await stateOf()).toBe('FAILED');
  });

  it('re-reads the position for a dynamic fraction, and sizes off what is held now', async () => {
    const dynamic: JobLegIntent = {
      marketId: MARKET,
      outcomeId: 'YES',
      side: 'SELL',
      positionId: 'pos_1',
      maxSlippageBps: 50,
      sizing: { kind: 'DYNAMIC_FRACTION', fraction: '0.500000' },
    };
    await arm({ intent: [dynamic] });
    const gateway = gatewayOf({
      positions: {
        positions: [
          {
            positionId: 'pos_1',
            marketId: MARKET,
            outcomeId: 'YES',
            strategyId: null,
            originalCost: '40.000000',
            remainingCost: '40.000000',
            shares: '80.000000',
            avgEntryPrice: '0.500000',
            currentPrice: '0.830000',
            unrealizedPnl: '26.400000',
            openedAt: T0,
          },
        ],
        nextCursor: null,
      },
      quotes: [quote({ expectedFillSize: '40.000000' })],
      creates: [created('exe_1')],
      submits: [{ executionId: 'exe_1', status: 'SUBMITTED' }],
      executions: { exe_1: { executionId: 'exe_1', status: 'PENDING_FILL' } },
    });

    await drive(gateway, pricesAt('0.900000'));

    // Half of the 80 shares held NOW, not of whatever was held at creation.
    expect(gateway.createCalls[0]?.body.size).toEqual({ sellShares: '40.000000' });
  });

  it('leaves a frozen fraction frozen, and never pages positions for it', async () => {
    await arm({
      intent: [
        {
          ...LEG,
          sizing: {
            kind: 'FROZEN_FRACTION',
            fraction: '0.500000',
            positionSharesAtCreation: '50.000000',
            frozenAt: T0,
          },
        },
      ],
    });
    const gateway = gatewayOf({
      quotes: [quote()],
      creates: [created('exe_1')],
      submits: [{ executionId: 'exe_1', status: 'SUBMITTED' }],
      executions: { exe_1: { executionId: 'exe_1', status: 'PENDING_FILL' } },
    });

    await drive(gateway, pricesAt('0.900000'));

    expect(gateway.createCalls[0]?.body.size).toEqual({ sellShares: '25.000000' });
  });

  it('pauses instead of skipping when a position lookup was never proven complete', async () => {
    await arm({
      intent: [
        {
          marketId: MARKET,
          outcomeId: 'YES',
          side: 'SELL',
          positionId: 'pos_1',
          maxSlippageBps: 50,
          sizing: { kind: 'DYNAMIC_FRACTION', fraction: '0.500000' },
        },
      ],
    });
    // No `nextCursor` at all: the server never said the walk reached the end.
    const gateway = gatewayOf({ positions: { positions: [] } });

    const result = await drive(gateway, pricesAt('0.900000'));

    expect(result.reason).toBe('POSITION_UNVERIFIED');
    expect(await stateOf()).toBe('PAUSED');
  });
});

/* ── Local endings ─────────────────────────────────────────────────────────── */

describe('ending without the server', () => {
  it('ends a job at its own expiry while the Runner is up', async () => {
    const job = await arm();
    const gateway = gatewayOf();

    const result = await drive(gateway, pricesAt('0.900000'), {
      at: later(job.expiresAt, 1),
    });

    expect(result.action).toBe('ENDED');
    expect(result.reason).toBe('EXPIRY_REACHED');
    expect(await stateOf()).toBe('EXPIRED');
    // Not one read, let alone an order, after the expiry passed.
    expect(gateway.marketCalls).toEqual([]);
  });

  it('honours a cancellation the owner asked for', async () => {
    await arm();
    await store.requestCancel('job_1', 'user asked', later(T0, 5000));

    const result = await drive(gatewayOf(), pricesAt('0.900000'));

    expect(result.reason).toBe('CANCEL_REQUESTED');
    expect(await stateOf()).toBe('CANCELLED');
  });

  it('does nothing to a job that already ended', async () => {
    await arm();
    await store.transition({ lease, to: 'CANCELLED', reason: 'SETUP', at: later(T0, 1000) });

    const result = await drive(gatewayOf(), pricesAt('0.900000'));

    expect(result.action).toBe('ALREADY_TERMINAL');
  });
});

/* ── Multi-leg ─────────────────────────────────────────────────────────────── */

describe('legs that succeed and fail independently', () => {
  const twoLegs: readonly JobLegIntent[] = [
    { ...LEG, positionId: 'pos_1' },
    { ...LEG, positionId: 'pos_2', sellShares: '10.000000' },
  ];

  it('carries on with the sibling when the server refuses one leg', async () => {
    await arm({ intent: twoLegs });
    const gateway = gatewayOf({
      quotes: [quote(), quote({ quoteId: 'q_2' })],
      creates: [apiError(), created('exe_2')],
      submits: [{ executionId: 'exe_2', status: 'SUBMITTED', transactionDigest: '0xsubmit' }],
      executions: { exe_2: { executionId: 'exe_2', status: 'FILLED' } },
    });

    const result = await drive(gateway, pricesAt('0.900000'));

    expect(gateway.createCalls.length).toBe(2);
    expect(gateway.submitCalls).toEqual(['exe_2']);
    const legs = await store.listLegs('job_1');
    expect(legs.map((leg) => leg.status)).toEqual(['FAILED', 'SUCCEEDED']);
    // One leg traded, so the job is not a no-op.
    expect(await stateOf()).toBe('FILLED');
    expect(result.legs?.[0]?.refusedCode).toBe('SLIPPAGE_EXCEEDED');
  });

  it('mints one key per leg and never shares one between them', async () => {
    await arm({ intent: twoLegs });
    const gateway = gatewayOf({
      quotes: [quote(), quote({ quoteId: 'q_2' })],
      creates: [created('exe_1'), created('exe_2')],
      submits: [
        { executionId: 'exe_1', status: 'SUBMITTED' },
        { executionId: 'exe_2', status: 'SUBMITTED' },
      ],
      executions: {
        exe_1: { executionId: 'exe_1', status: 'PENDING_FILL' },
        exe_2: { executionId: 'exe_2', status: 'PENDING_FILL' },
      },
    });

    await drive(gateway, pricesAt('0.900000'));

    const keys = gateway.createCalls.map((call) => call.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect(keys).toEqual((await store.listLegs('job_1')).map((leg) => leg.idempotencyKey));
  });

  it('records a leg it passed over as SKIPPED, so the job can still conclude', async () => {
    await arm({ intent: twoLegs });
    const gateway = gatewayOf({
      // The second leg's quote is below the floor; the first is fine.
      quotes: [quote(), quote({ quoteId: 'q_2', expectedPrice: '0.100000' })],
      creates: [created('exe_1')],
      submits: [{ executionId: 'exe_1', status: 'SUBMITTED' }],
      executions: { exe_1: { executionId: 'exe_1', status: 'FILLED' } },
    });

    await drive(gateway, pricesAt('0.900000'));

    expect(gateway.createCalls.length).toBe(1);
    expect((await store.listLegs('job_1')).map((leg) => leg.status)).toEqual([
      'SUCCEEDED',
      'SKIPPED',
    ]);
    expect(await stateOf()).toBe('FILLED');
  });
});

/* ── Exactly one logical submission ────────────────────────────────────────── */

describe('a crash at every side-effect boundary', () => {
  const runToCrash = async (at: JobState, gateway: StrategyGateway): Promise<void> => {
    await expect(
      drive(gateway, pricesAt('0.900000'), { store: crashBefore(store, at) }),
    ).rejects.toThrow(Crash);
  };

  it('reuses the persisted key when the crash happened before anything was sent', async () => {
    await arm();
    const gateway = gatewayOf({
      quotes: [quote()],
      creates: [created('exe_1')],
      submits: [{ executionId: 'exe_1', status: 'SUBMITTED' }],
      executions: { exe_1: { executionId: 'exe_1', status: 'PENDING_FILL' } },
    });

    // Legs reserved, then the process dies before the job records CREATING.
    await runToCrash('CREATING', gateway);
    expect(gateway.createCalls).toEqual([]);
    const mintedKey = (await store.listLegs('job_1'))[0]?.idempotencyKey;

    await restart();
    // Nothing was sent, so recovery re-arms rather than reconciling.
    expect(await stateOf()).toBe('WATCHING');

    await drive(gateway, pricesAt('0.900000'));

    expect(gateway.createCalls.length).toBe(1);
    // The SAME key: a second one would make one intent into two orders.
    expect(gateway.createCalls[0]?.idempotencyKey).toBe(mintedKey);
  });

  it('never sends a second create for a request that may already exist', async () => {
    await arm();
    const gateway = gatewayOf({
      quotes: [quote(), quote()],
      // The request leaves, and nothing comes back.
      creates: [new PredictAgentTransportError('socket hang up', undefined)],
      executions: { exe_1: { executionId: 'exe_1', status: 'PENDING_FILL' } },
    });

    // The create is attempted, and the process dies before it can even move the
    // job to UNKNOWN_PENDING. All that survives is the attempt row opened BEFORE
    // the request — which is the whole point of opening it first.
    await runToCrash('UNKNOWN_PENDING', gateway);
    expect(gateway.createCalls.length).toBe(1);

    await restart();
    expect(await stateOf()).toBe('UNKNOWN_PENDING');
    expect((await store.listOpenSideEffects('job_1')).length).toBe(1);

    // Every later pass reads, and refuses to invent a second order.
    const first = await drive(gateway, pricesAt('0.900000'));
    const second = await drive(gateway, pricesAt('0.900000'));

    expect(first.action).toBe('UNKNOWN_PENDING');
    expect(first.reason).toBe('NO_EXECUTION_ID');
    expect(second.action).toBe('UNKNOWN_PENDING');
    expect(gateway.createCalls.length).toBe(1);
    expect(gateway.submitCalls).toEqual([]);
    // The evidence is left where the reconciler and an operator can see it.
    expect((await store.listOpenSideEffects('job_1')).length).toBe(1);
  });

  it('reads back an execution the crash left created but unsubmitted', async () => {
    await arm();
    const gateway = gatewayOf({
      quotes: [quote()],
      creates: [created('exe_1')],
      // The execution outlives the process, and eventually the server expires it
      // because nobody ever signed it.
      executions: { exe_1: { executionId: 'exe_1', status: 'EXPIRED' } },
    });

    await runToCrash('AWAITING_SIGNATURE', gateway);
    expect(gateway.createCalls.length).toBe(1);

    await restart();
    // The execution id is on disk, so recovery reconciles rather than re-arming.
    expect(await stateOf()).toBe('RECONCILING');

    const result = await drive(gateway, pricesAt('0.900000'));

    expect(result.action).toBe('ENDED');
    expect(await stateOf()).toBe('EXPIRED');
    expect(gateway.createCalls.length).toBe(1);
    expect(gateway.submitCalls).toEqual([]);
  });

  it('resolves a submit that may have landed by reading it, not by resending it', async () => {
    await arm();
    const gateway = gatewayOf({
      quotes: [quote()],
      creates: [created('exe_1')],
      submits: [new PredictAgentTransportError('connection reset', undefined)],
      executions: {
        exe_1: {
          executionId: 'exe_1',
          status: 'FILLED',
          transactionDigest: '0xsubmit',
          fill: {
            filledAmount: '20.750000',
            filledShares: '25.000000',
            avgFillPrice: '0.830000',
            actualFee: null,
            txDigest: '0xkeeper',
            filledAt: NOW,
          },
        },
      },
    });

    await runToCrash('UNKNOWN_PENDING', gateway);
    expect(gateway.submitCalls).toEqual(['exe_1']);

    await restart();
    const result = await drive(gateway, pricesAt('0.900000'));

    expect(result.action).toBe('ENDED');
    expect(await stateOf()).toBe('FILLED');
    // It did land. The digest proves it, and no second submit was ever sent.
    expect(gateway.submitCalls).toEqual(['exe_1']);
    expect(gateway.createCalls.length).toBe(1);
    const leg = (await store.listLegs('job_1'))[0];
    expect(leg?.submissionDigest).toBe('0xsubmit');
    expect(leg?.keeperDigest).toBe('0xkeeper');
    expect((await store.listOpenSideEffects('job_1')).length).toBe(0);
  });

  it('records the ambiguity without a crash when the transport simply fails', async () => {
    await arm();
    const gateway = gatewayOf({
      quotes: [quote()],
      creates: [created('exe_1')],
      submits: [new PredictAgentTransportError('timeout', undefined)],
      executions: { exe_1: { executionId: 'exe_1', status: 'SUBMITTED' } },
    });

    const result = await drive(gateway, pricesAt('0.900000'));

    expect(result.action).toBe('UNKNOWN_PENDING');
    expect(result.reason).toBe('SUBMIT_UNRESOLVED');
    expect(await stateOf()).toBe('UNKNOWN_PENDING');
    expect((await store.listOpenSideEffects('job_1')).length).toBe(1);
  });
});

/* ── Secrets ───────────────────────────────────────────────────────────────── */

describe('what never reaches the disk', () => {
  it('keeps sponsored bytes and signatures out of the store entirely', async () => {
    await arm();
    const gateway = gatewayOf({
      quotes: [quote()],
      creates: [created('exe_1')],
      submits: [{ executionId: 'exe_1', status: 'SUBMITTED', transactionDigest: '0xsubmit' }],
      executions: { exe_1: { executionId: 'exe_1', status: 'PENDING_FILL' } },
    });

    const result = await drive(gateway, pricesAt('0.900000'));

    const written = JSON.stringify({
      result,
      legs: await store.listLegs('job_1'),
      attempts: await store.listSideEffects('job_1'),
      transitions: await store.listTransitions('job_1'),
    });
    expect(written).not.toContain(BYTES);
    expect(written).not.toContain(SIGNATURE);
  });

  it('keeps a real signer child out of the record too — file bytes included', async () => {
    // The previous case uses the permissive fake. This one runs the module that
    // actually talks to a keystore, because that is the path where a signature,
    // the sponsored bytes and a child's stdout all exist in one process at once.
    await arm();
    const gateway = gatewayOf({
      quotes: [quote()],
      creates: [created('exe_1')],
      submits: [{ executionId: 'exe_1', status: 'SUBMITTED', transactionDigest: '0xsubmit' }],
      executions: { exe_1: { executionId: 'exe_1', status: 'PENDING_FILL' } },
    });
    const CHATTER = 'keystore: touch the hardware key to approve';
    const diagnostics: string[] = [];
    let sentToChild = '';

    const result = await drive(gateway, pricesAt('0.900000'), {
      signer: createExternalCommandSigner({
        command: ['/opt/keystore/bin/sign'],
        agentWallet: '0xagent',
        now: () => NOW,
        onDiagnostic: (message) => diagnostics.push(message),
        run: async (_command, stdin) => {
          sentToChild = stdin;
          return {
            code: 0,
            stdout: `${JSON.stringify({ signature: SIGNATURE })}\n`,
            stderr: `${CHATTER}\n`,
            timedOut: false,
          };
        },
      }),
    });

    // It really did sign and submit — otherwise this proves only that a failing
    // path writes nothing.
    expect(gateway.submitCalls).toEqual(['exe_1']);
    // The child was handed the bytes, so they were in memory during this pass.
    expect(sentToChild).toContain(BYTES);
    // stderr is an operator's channel and may be forwarded…
    expect(diagnostics.join('\n')).toContain(CHATTER);

    // …and none of it — signature, bytes, or the child's own words — is in the
    // record. Read from the FILE, not the store's return values: an in-memory
    // check would pass for a store that writes more than it hands back.
    const written = JSON.stringify({
      result,
      legs: await store.listLegs('job_1'),
      attempts: await store.listSideEffects('job_1'),
      transitions: await store.listTransitions('job_1'),
    });
    await store.close();
    const onDisk = [dir.path, `${dir.path}-wal`]
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path).toString('binary'))
      .join('');
    store = open();
    for (const secret of [SIGNATURE, BYTES, CHATTER]) {
      expect(written, secret).not.toContain(secret);
      expect(onDisk, secret).not.toContain(secret);
    }
  });

  it('fingerprints the submit over the execution id, so a replay is provable', async () => {
    await arm();
    const gateway = gatewayOf({
      quotes: [quote()],
      creates: [created('exe_1')],
      submits: [{ executionId: 'exe_1', status: 'SUBMITTED' }],
      executions: { exe_1: { executionId: 'exe_1', status: 'PENDING_FILL' } },
    });
    await drive(gateway, pricesAt('0.900000'));

    const attempts = await store.listSideEffects('job_1');
    const submit = attempts.find((attempt) => attempt.kind === 'SUBMIT_EXECUTION');
    expect(submit?.requestFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(submit?.idempotencyKey).toBe((await store.listLegs('job_1'))[0]?.idempotencyKey);
  });
});

/* ── Statuses the driver must not interpret ────────────────────────────────── */

describe('what a pass refuses to decide', () => {
  it('leaves an order the server has not finished alone', async () => {
    await arm();
    const pending: PredictExecutionStatus = 'PENDING_FILL';
    const gateway = gatewayOf({
      quotes: [quote()],
      creates: [created('exe_1')],
      submits: [{ executionId: 'exe_1', status: 'SUBMITTED' }],
      executions: { exe_1: { executionId: 'exe_1', status: pending } },
    });

    const result = await drive(gateway, pricesAt('0.900000'));

    expect(result.action).toBe('EXECUTED');
    expect(await stateOf()).toBe('RECONCILING');
    expect((await store.listLegs('job_1'))[0]?.status).toBe('PENDING');
  });

  it('will not drive a job that is mid-write; that belongs to recovery', async () => {
    await arm();
    await store.reserveLeg({
      lease,
      legIndex: 0,
      idempotencyKey: 'aaaaaaaa-0000-4000-8000-000000000000',
      intent: LEG,
      at: T0,
    });
    for (const to of ['TRIGGERED', 'QUOTING', 'CREATING'] as const) {
      await store.transition({ lease, to, reason: 'SETUP', at: later(T0, 100) });
    }

    const result = await drive(gatewayOf(), pricesAt('0.900000'));

    expect(result.action).toBe('NOT_DRIVABLE');
    expect(result.reason).toBe('AWAITING_RECOVERY');
    expect(await stateOf()).toBe('CREATING');
  });
});
