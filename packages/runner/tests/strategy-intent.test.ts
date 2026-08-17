/**
 * What a strategy request has to say before anything durable is written.
 *
 * Each group below is a way an under-specified intent could otherwise become an
 * order nobody described: an expiry that never arrives, a size the side does not
 * take, "half" of a position that grew afterwards, or a price target watching
 * whichever market happened to be listed first.
 */
import type { ListPositionsResponseBody, PredictPositionSummary } from '@waterx/predict-agent-sdk';

import type { JobPolicySnapshot } from '../src/job.ts';
import { StrategyError } from '../src/strategy/errors.ts';
import {
  BETA_MAX_EXPIRY_MS,
  normalizeStrategy,
  resolveExpiry,
  type StrategyLegRequest,
  type StrategyRequest,
} from '../src/strategy/intent.ts';
import type { StrategyPositionReader } from '../src/strategy/positions.ts';
import { later, T0 } from './harness.ts';

const POLICY: JobPolicySnapshot = { mode: 'delegated-auto', source: 'file:policy.json' };
const DAY = 86_400_000;

/*
 * The bases carry no size, and the cases below add exactly one.
 *
 * Writing `{ ...SELL_LEG, sellShares: undefined }` would test a different thing:
 * the rules here are about which fields are *absent*, and a key present with an
 * undefined value is a shape a JSON caller cannot even send.
 */
const BUY_BASE: Omit<StrategyLegRequest, 'buyAmount'> = {
  marketId: 'mkt_1',
  outcomeId: 'YES',
  side: 'BUY',
  maxSlippageBps: 50,
};

const SELL_BASE: Omit<StrategyLegRequest, 'sellShares' | 'positionId'> = {
  marketId: 'mkt_1',
  outcomeId: 'YES',
  side: 'SELL',
  maxSlippageBps: 50,
};

/** A SELL that names its position but not its size. */
const SELL_SIZELESS = { ...SELL_BASE, positionId: 'pos_1' };

const BUY_LEG: StrategyLegRequest = { ...BUY_BASE, buyAmount: '25.000000' };

const SELL_LEG: StrategyLegRequest = { ...SELL_SIZELESS, sellShares: '10.000000' };

const request = (overrides: Partial<StrategyRequest> = {}): StrategyRequest => ({
  ownerAddress: '0xowner',
  accountId: 'acct_1',
  agentWallet: '0xagent',
  legs: [BUY_LEG],
  trigger: { kind: 'PRICE', targetPrice: '0.400000' },
  policy: POLICY,
  expiresAt: later(T0, DAY),
  ...overrides,
});

const position = (overrides: Partial<PredictPositionSummary> = {}): PredictPositionSummary => ({
  positionId: 'pos_1',
  marketId: 'mkt_1',
  outcomeId: 'YES',
  strategyId: null,
  originalCost: '10.000000',
  remainingCost: '10.000000',
  shares: '25.000000',
  avgEntryPrice: '0.400000',
  currentPrice: '0.500000',
  unrealizedPnl: '2.500000',
  openedAt: T0,
  ...overrides,
});

/** A reader over fixed pages, recording how many the walk actually read. */
const reader = (
  pages: ListPositionsResponseBody[],
): StrategyPositionReader & { calls: number } => {
  const state = {
    calls: 0,
    getPositions: (_accountId: string, page?: { cursor?: string }) => {
      const index = page?.cursor === undefined ? 0 : Number(page.cursor);
      state.calls += 1;
      return Promise.resolve(pages[index] ?? { positions: [], nextCursor: null });
    },
  };
  return state;
};

const onePage = (...positions: PredictPositionSummary[]): ListPositionsResponseBody => ({
  positions,
  nextCursor: null,
});

const refusal = async (promise: Promise<unknown>): Promise<StrategyError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StrategyError) return error;
    throw error;
  }
  throw new Error('expected a StrategyError, but normalization succeeded');
};

describe('expiry (ADR-0005)', () => {
  it('is mandatory: there is no permanent watcher to fall back on', () => {
    expect(() => resolveExpiry(undefined, T0)).toThrow(
      expect.objectContaining({ code: 'EXPIRY_REQUIRED' }),
    );
    expect(() => resolveExpiry('   ', T0)).toThrow(
      expect.objectContaining({ code: 'EXPIRY_REQUIRED' }),
    );
  });

  it('rejects an expiry the machine would interpret for itself', () => {
    // Both parse under `Date.parse`. Neither names an instant: one is decided by
    // the host's locale, the other by its timezone.
    for (const value of ['01/02/2026', '2026-08-18T12:00:00']) {
      expect(() => resolveExpiry(value, T0)).toThrow(
        expect.objectContaining({ code: 'EXPIRY_INVALID' }),
      );
    }
  });

  it('rejects an expiry that has already passed, and one that is exactly now', () => {
    expect(() => resolveExpiry(later(T0, -1), T0)).toThrow(
      expect.objectContaining({ code: 'EXPIRY_IN_PAST' }),
    );
    expect(() => resolveExpiry(T0, T0)).toThrow(
      expect.objectContaining({ code: 'EXPIRY_IN_PAST' }),
    );
  });

  it('caps at seven days, naming the cap, and never clamps silently', () => {
    expect(resolveExpiry(later(T0, BETA_MAX_EXPIRY_MS), T0)).toEqual({
      expiresAt: later(T0, BETA_MAX_EXPIRY_MS),
      expiresInMs: BETA_MAX_EXPIRY_MS,
    });

    let thrown: unknown;
    try {
      resolveExpiry(later(T0, BETA_MAX_EXPIRY_MS + 1000), T0);
    } catch (error) {
      thrown = error;
    }
    const error = thrown as StrategyError;
    expect(error.code).toBe('EXPIRY_TOO_FAR');
    expect(error.message).toContain('7 days');
    // The refusal carries the latest instant that WOULD have been accepted, so a
    // caller can retry deliberately rather than have its request quietly shortened.
    expect(error.detail).toMatchObject({ latestAllowed: later(T0, BETA_MAX_EXPIRY_MS) });
  });

  it('resolves to a canonical absolute instant, so a preview shows what is enforced', () => {
    expect(resolveExpiry('2026-08-18T14:00:00+02:00', T0).expiresAt).toBe('2026-08-18T12:00:00.000Z');
  });

  it('seven days is the default, not a hard-coded literal in the caller', async () => {
    const normalized = await normalizeStrategy(
      request({ expiresAt: later(T0, 3 * DAY) }),
      { at: T0 },
    );
    expect(normalized.expiresAt).toBe(later(T0, 3 * DAY));
    expect(normalized.expiresInMs).toBe(3 * DAY);
  });
});

describe('sizing (ADR-0001 §11)', () => {
  it('accepts a BUY sized by budget and a SELL sized by shares', async () => {
    // Immediate, because two legs on opposite sides have no single side for a
    // price target to be read as — see the trigger group below.
    const normalized = await normalizeStrategy(
      request({ legs: [BUY_LEG, SELL_LEG], trigger: { kind: 'IMMEDIATE' } }),
      { at: T0 },
    );
    expect(normalized.legs[0]).toMatchObject({
      side: 'BUY',
      buyAmount: '25.000000',
      sizing: { kind: 'ABSOLUTE' },
    });
    expect(normalized.legs[1]).toMatchObject({
      side: 'SELL',
      sellShares: '10.000000',
      positionId: 'pos_1',
      sizing: { kind: 'ABSOLUTE' },
    });
    expect(normalized.legs[0]).not.toHaveProperty('sellShares');
    expect(normalized.legs[1]).not.toHaveProperty('buyAmount');
  });

  it('stops when a leg carries no size at all', async () => {
    const { maxSlippageBps, marketId, outcomeId, side } = BUY_LEG;
    const error = await refusal(
      normalizeStrategy(request({ legs: [{ marketId, outcomeId, side, maxSlippageBps }] }), {
        at: T0,
      }),
    );
    expect(error.code).toBe('SIZE_MISSING');
  });

  it('stops when a leg carries two sizes, naming both', async () => {
    const error = await refusal(
      normalizeStrategy(
        request({ legs: [{ ...SELL_LEG, sellFractionOfPosition: '0.5' }] }),
        { at: T0 },
      ),
    );
    expect(error.code).toBe('SIZE_AMBIGUOUS');
    expect(error.detail).toMatchObject({ given: ['sellShares', 'sellFractionOfPosition'] });
  });

  it('refuses a size that belongs to the other side', async () => {
    const buyWithShares = await refusal(
      normalizeStrategy(
        request({ legs: [{ ...BUY_BASE, sellShares: '5.000000' }] }),
        { at: T0 },
      ),
    );
    expect(buyWithShares.code).toBe('SIZE_AMBIGUOUS');

    const sellWithBudget = await refusal(
      normalizeStrategy(
        request({
          legs: [{ ...SELL_SIZELESS, buyAmount: '5.000000' }],
        }),
        { at: T0 },
      ),
    );
    expect(sellWithBudget.code).toBe('SIZE_AMBIGUOUS');
  });

  it('refuses a zero size and a malformed decimal rather than sending either', async () => {
    const zero = await refusal(
      normalizeStrategy(request({ legs: [{ ...BUY_LEG, buyAmount: '0' }] }), { at: T0 }),
    );
    expect(zero.code).toBe('SIZE_INVALID');

    const overScale = await refusal(
      normalizeStrategy(request({ legs: [{ ...BUY_LEG, buyAmount: '1.1234567' }] }), { at: T0 }),
    );
    expect(overScale.code).toBe('SIZE_INVALID');
  });

  it('requires a position for a SELL and refuses one on a BUY', async () => {
    const noPosition = await refusal(
      normalizeStrategy(request({ legs: [{ ...SELL_BASE, sellShares: '10.000000' }] }), { at: T0 }),
    );
    expect(noPosition.code).toBe('POSITION_REQUIRED');

    const buyPosition = await refusal(
      normalizeStrategy(request({ legs: [{ ...BUY_LEG, positionId: 'pos_1' }] }), { at: T0 }),
    );
    expect(buyPosition.code).toBe('POSITION_NOT_APPLICABLE');
  });
});

describe('percentage SELL (D-15)', () => {
  const half: StrategyLegRequest = { ...SELL_SIZELESS, sellFractionOfPosition: '0.5' };

  it('freezes the share count at creation, so a position that grows later is not sold', async () => {
    const positions = reader([onePage(position({ shares: '25.000000' }))]);
    const normalized = await normalizeStrategy(request({ legs: [half] }), {
      at: T0,
      positions,
    });

    expect(normalized.legs[0]).toMatchObject({
      sellShares: '12.500000',
      sizing: {
        kind: 'FROZEN_FRACTION',
        fraction: '0.5',
        positionSharesAtCreation: '25.000000',
        frozenAt: T0,
      },
    });
  });

  it('truncates rather than rounds up: a frozen size never exceeds what was held', async () => {
    const positions = reader([onePage(position({ shares: '3.000001' }))]);
    const normalized = await normalizeStrategy(
      request({ legs: [{ ...half, sellFractionOfPosition: '0.333333' }] }),
      { at: T0, positions },
    );
    // 3.000001 × 0.333333 = 0.99999966..., and the sixth decimal is kept, not rounded.
    expect(normalized.legs[0]?.sellShares).toBe('0.999999');
  });

  it('the dynamic reading exists, but only under its own field, and freezes nothing', async () => {
    const positions = reader([onePage(position())]);
    const normalized = await normalizeStrategy(
      request({
        legs: [{ ...SELL_SIZELESS, dynamicSellFractionOfPosition: '0.5' }],
      }),
      { at: T0, positions },
    );

    expect(normalized.legs[0]).toMatchObject({
      sizing: { kind: 'DYNAMIC_FRACTION', fraction: '0.5' },
    });
    // No share count: the size does not exist yet, and a reader cannot mistake a
    // stale number for one that was frozen.
    expect(normalized.legs[0]).not.toHaveProperty('sellShares');
    // And nothing was read, because nothing was frozen.
    expect(positions.calls).toBe(0);
  });

  it('refuses a fraction outside (0, 1]', async () => {
    for (const fraction of ['0', '1.000001', '-0.5', 'half']) {
      const error = await refusal(
        normalizeStrategy(request({ legs: [{ ...half, sellFractionOfPosition: fraction }] }), {
          at: T0,
          positions: reader([onePage(position())]),
        }),
      );
      expect(error.code).toBe('FRACTION_INVALID');
    }
  });

  it('refuses when the fraction rounds down to nothing', async () => {
    const error = await refusal(
      normalizeStrategy(
        request({ legs: [{ ...half, sellFractionOfPosition: '0.000001' }] }),
        { at: T0, positions: reader([onePage(position({ shares: '0.100000' }))]) },
      ),
    );
    expect(error.code).toBe('FRACTION_RESOLVES_TO_ZERO');
  });

  it('refuses when no position reader is wired: a fraction is not sizeable alone', async () => {
    const error = await refusal(normalizeStrategy(request({ legs: [half] }), { at: T0 }));
    expect(error.code).toBe('POSITION_READ_UNAVAILABLE');
  });

  it('refuses an unknown share count, because null is not zero', async () => {
    const error = await refusal(
      normalizeStrategy(request({ legs: [half] }), {
        at: T0,
        positions: reader([onePage(position({ shares: null }))]),
      }),
    );
    expect(error.code).toBe('POSITION_SHARES_UNKNOWN');
  });

  it('refuses a position in another market or outcome', async () => {
    const error = await refusal(
      normalizeStrategy(request({ legs: [half] }), {
        at: T0,
        positions: reader([onePage(position({ marketId: 'mkt_other' }))]),
      }),
    );
    expect(error.code).toBe('POSITION_MISMATCH');
  });

  it('walks pages to find the position', async () => {
    const positions = reader([
      { positions: [position({ positionId: 'pos_other' })], nextCursor: '1' },
      onePage(position()),
    ]);
    const normalized = await normalizeStrategy(request({ legs: [half] }), {
      at: T0,
      positions,
    });
    expect(normalized.legs[0]?.sellShares).toBe('12.500000');
    expect(positions.calls).toBe(2);
  });

  it('distinguishes a proven absence from an unfinished walk', async () => {
    const proven = await refusal(
      normalizeStrategy(request({ legs: [half] }), {
        at: T0,
        positions: reader([onePage(position({ positionId: 'pos_other' }))]),
      }),
    );
    expect(proven.code).toBe('POSITION_UNKNOWN');

    // An ABSENT `nextCursor` is the server declining to answer, not the end of
    // the list. Sizing against that absence would be a guess about a holding.
    const inconclusive = await refusal(
      normalizeStrategy(request({ legs: [half] }), {
        at: T0,
        positions: reader([{ positions: [position({ positionId: 'pos_other' })] }]),
      }),
    );
    expect(inconclusive.code).toBe('POSITION_LOOKUP_INCONCLUSIVE');
  });

  it('stops a server that pages forever instead of walking forever', async () => {
    const looping: StrategyPositionReader = {
      getPositions: () => Promise.resolve({ positions: [], nextCursor: 'always-the-same' }),
    };
    const error = await refusal(
      normalizeStrategy(request({ legs: [half] }), { at: T0, positions: looping }),
    );
    expect(error.code).toBe('POSITION_LOOKUP_INCONCLUSIVE');
  });
});

describe('trigger', () => {
  it('derives the watched market from a unanimous leg list, and the side from it', async () => {
    const buy = await normalizeStrategy(request({ legs: [BUY_LEG] }), { at: T0 });
    expect(buy.trigger).toEqual({
      kind: 'PRICE',
      targetPrice: '0.400000',
      marketId: 'mkt_1',
      outcomeId: 'YES',
      side: 'BUY',
      // A BUY target is a ceiling on the ask.
      observe: 'ASK',
    });

    const sell = await normalizeStrategy(request({ legs: [SELL_LEG] }), { at: T0 });
    // A SELL target is a floor under the bid.
    expect(sell.trigger).toMatchObject({ side: 'SELL', observe: 'BID' });
  });

  it('refuses to pick a market when the legs disagree', async () => {
    const error = await refusal(
      normalizeStrategy(request({ legs: [BUY_LEG, { ...BUY_LEG, marketId: 'mkt_2' }] }), {
        at: T0,
      }),
    );
    expect(error.code).toBe('TRIGGER_AMBIGUOUS');
    expect(error.detail).toMatchObject({ field: 'marketId', distinct: ['mkt_1', 'mkt_2'] });
  });

  it('lets a caller watch one market and trade another, all three fields or none', async () => {
    const explicit = await normalizeStrategy(
      request({
        legs: [BUY_LEG, { ...BUY_LEG, marketId: 'mkt_2' }],
        trigger: {
          kind: 'PRICE',
          targetPrice: '0.900000',
          marketId: 'mkt_watch',
          outcomeId: 'NO',
          side: 'SELL',
        },
      }),
      { at: T0 },
    );
    expect(explicit.trigger).toMatchObject({ marketId: 'mkt_watch', outcomeId: 'NO', observe: 'BID' });

    const partial = await refusal(
      normalizeStrategy(
        request({ trigger: { kind: 'PRICE', targetPrice: '0.9', marketId: 'mkt_watch' } }),
        { at: T0 },
      ),
    );
    expect(partial.code).toBe('TRIGGER_INCOMPLETE');
  });

  it('refuses a price trigger with no target and an immediate one that carries a target', async () => {
    const noTarget = await refusal(
      normalizeStrategy(
        request({ trigger: { kind: 'PRICE' } as never }),
        { at: T0 },
      ),
    );
    expect(noTarget.code).toBe('TRIGGER_INVALID');

    const strayTarget = await refusal(
      normalizeStrategy(
        request({ trigger: { kind: 'IMMEDIATE', targetPrice: '0.4' } as never }),
        { at: T0 },
      ),
    );
    expect(strayTarget.code).toBe('TRIGGER_INVALID');
  });

  it('refuses a target that is not a probability', async () => {
    const error = await refusal(
      normalizeStrategy(request({ trigger: { kind: 'PRICE', targetPrice: '42' } }), { at: T0 }),
    );
    expect(error.code).toBe('FIELD_INVALID');
  });

  it('an immediate trigger carries no watched market', async () => {
    const normalized = await normalizeStrategy(request({ trigger: { kind: 'IMMEDIATE' } }), {
      at: T0,
    });
    expect(normalized.trigger).toEqual({ kind: 'IMMEDIATE' });
  });
});

describe('the rest of the request', () => {
  it('refuses a read-only policy at creation rather than hours later at the trigger', async () => {
    const error = await refusal(
      normalizeStrategy(request({ policy: { mode: 'read-only', source: 'file:policy.json' } }), {
        at: T0,
      }),
    );
    expect(error.code).toBe('POLICY_FORBIDS_WRITE');
  });

  /**
   * The refusal that looks wrong until you follow it through.
   *
   * `interactive` is the DEFAULT approval mode, so refusing it reads at first like
   * refusing the common case. But interactive means *a person approves this write
   * when it happens*, and a durable strategy fires when its target is met — a
   * moment nobody is present for. Accepting one would either sign without the
   * approval it promises, or watch for seven days and refuse at the very end; and
   * it would make delegated-auto's explicit scope evadable by anyone willing to
   * phrase an order as a strategy whose trigger is already met.
   */
  it('refuses the interactive default, because a strategy fires while nobody is being asked', async () => {
    const error = await refusal(
      normalizeStrategy(request({ policy: { mode: 'interactive', source: 'default' } }), {
        at: T0,
      }),
    );
    expect(error.code).toBe('POLICY_REQUIRES_DELEGATION');
    expect(error.message).toContain('delegated-auto');
    expect(error.detail).toMatchObject({ mode: 'interactive' });
  });

  it('refuses a policy mode it does not recognize rather than treating it as permissive', async () => {
    const error = await refusal(
      normalizeStrategy(
        request({ policy: { mode: 'yolo' as never, source: 'file:policy.json' } }),
        { at: T0 },
      ),
    );
    expect(error.code).toBe('POLICY_MODE_UNRECOGNIZED');
  });

  it('refuses the authority before it looks at anything else', async () => {
    // The order matters for the message an owner sees. A read-only strategy with
    // a bad expiry has one problem worth naming, and it is not the expiry.
    const error = await refusal(
      normalizeStrategy(
        request({ policy: { mode: 'read-only', source: 'file:policy.json' }, expiresAt: 'never' }),
        { at: T0 },
      ),
    );
    expect(error.code).toBe('POLICY_FORBIDS_WRITE');
  });

  it('refuses a strategy with no legs', async () => {
    const error = await refusal(normalizeStrategy(request({ legs: [] }), { at: T0 }));
    expect(error.code).toBe('NO_LEGS');
  });

  it('refuses missing identity and malformed enums', async () => {
    expect((await refusal(normalizeStrategy(request({ accountId: '' }), { at: T0 }))).code).toBe(
      'FIELD_REQUIRED',
    );
    expect(
      (
        await refusal(
          normalizeStrategy(request({ legs: [{ ...BUY_LEG, outcomeId: 'MAYBE' as never }] }), {
            at: T0,
          }),
        )
      ).code,
    ).toBe('FIELD_INVALID');
    expect(
      (
        await refusal(
          normalizeStrategy(request({ legs: [{ ...BUY_LEG, maxSlippageBps: 12.5 }] }), { at: T0 }),
        )
      ).code,
    ).toBe('FIELD_INVALID');
  });

  it('refuses before it reads: an invalid expiry never triggers a position lookup', async () => {
    const positions = reader([onePage(position())]);
    await refusal(
      normalizeStrategy(
        request({
          expiresAt: later(T0, 30 * DAY),
          legs: [{ ...SELL_SIZELESS, sellFractionOfPosition: '0.5' }],
        }),
        { at: T0, positions },
      ),
    );
    expect(positions.calls).toBe(0);
  });
});
