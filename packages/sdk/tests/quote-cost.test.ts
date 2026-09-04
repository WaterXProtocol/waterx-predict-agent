/**
 * The two costs this API reports honestly and no caller could act on.
 *
 * The numbers in these fixtures are the ones from the session this module was
 * written after: a five-minute round quoting 0.4825 / 0.5275, a buy filled at
 * 0.527493 inside a 100 bps slippage bound, and a position that marked about
 * nine percent underwater the instant it existed. Every assertion below is a
 * sentence somebody had to write out in prose because there was no field for it.
 */
import { describe, expect, it } from 'vitest';

import type { PredictQuote } from '../src/contract.ts';
import { describeQuoteCost, describeSpread } from '../src/quote-cost.ts';

const BOOK = { indicativeBid: '0.4825', indicativeAsk: '0.5275' } as const;

function quote(overrides: Partial<PredictQuote> = {}): PredictQuote {
  return {
    quoteId: 'q-1',
    marketId: '0xmarket',
    outcomeId: 'YES',
    side: 'BUY',
    expectedPrice: '0.527493',
    expectedFillSize: null,
    availableSize: null,
    feeAmount: null,
    liquidityTier: 'C',
    qualityFlags: ['TOP_OF_BOOK_ONLY'],
    asOf: '2026-09-02T08:02:00.000Z',
    expiresAt: '2026-09-02T08:02:03.000Z',
    onchainMarketIdHex: '0xmarket',
    onchainSelection: 'YES',
    ...overrides,
  };
}

describe('the spread', () => {
  it('is measured against the mid, and rounded up', () => {
    // Up, because this is a cost, and a cost that rounds down is a cost a
    // threshold lets through. 891.09 → 892.
    expect(describeSpread(BOOK)).toEqual({
      bid: '0.4825',
      ask: '0.5275',
      mid: '0.505000',
      spreadBps: 892,
      crossed: false,
    });
  });

  it('stays null when either side is missing', () => {
    // Substituting the other side would report a spread of zero on exactly the
    // markets where the number matters most.
    expect(describeSpread({ indicativeBid: '0.48', indicativeAsk: null }).spreadBps).toBeNull();
    expect(describeSpread({ indicativeBid: null, indicativeAsk: '0.52' }).mid).toBeNull();
  });

  it('flags a crossed book rather than reporting a negative spread', () => {
    const crossed = describeSpread({ indicativeBid: '0.55', indicativeAsk: '0.50' });

    expect(crossed.crossed).toBe(true);
    expect(crossed.spreadBps).toBeNull();
  });
});

describe('what a buy is down the moment it fills', () => {
  it('measures the fill against the bid it will mark at', () => {
    // Entry takes the ask; the mark takes the bid. 0.527493 → 0.4825 is 852.96
    // bps, rounded up.
    const cost = describeQuoteCost(quote(), { outcome: BOOK });

    expect(cost.immediateMarkToMarketBps).toBe(853);
  });

  it('says out loud that the slippage bound does not protect against it', () => {
    // The sentence that had to be typed by hand, twice, in one session.
    const cost = describeQuoteCost(quote(), { outcome: BOOK });

    expect(cost.concerns.join(' ')).toMatch(/maxSlippageBps.*does not protect/u);
  });

  it('is null for a SELL, which realizes rather than opens', () => {
    // The spread on an exit was already paid on the way in. Reporting it again
    // would double-count it.
    const cost = describeQuoteCost(quote({ side: 'SELL', expectedPrice: '0.4825' }), {
      outcome: BOOK,
    });

    expect(cost.immediateMarkToMarketBps).toBeNull();
  });

  it('is null with no book, rather than estimated from the quote alone', () => {
    expect(describeQuoteCost(quote()).immediateMarkToMarketBps).toBeNull();
    expect(describeQuoteCost(quote()).spread).toBeUndefined();
  });

  it('is zero, not negative, for a fill at or below the mark', () => {
    const cost = describeQuoteCost(quote({ expectedPrice: '0.4800' }), { outcome: BOOK });

    expect(cost.immediateMarkToMarketBps).toBe(0);
    expect(cost.concerns.join(' ')).not.toMatch(/down the moment/u);
  });
});

describe('what the quote will and will not vouch for', () => {
  it('turns null sizes with a flag into something a caller can refuse on', () => {
    const cost = describeQuoteCost(quote(), { outcome: BOOK });

    expect(cost.sizeConfidence).toBe('TOP_OF_BOOK_ONLY');
    expect(cost.vouchedSize).toBeNull();
    expect(cost.concerns.join(' ')).toMatch(/QUANTITY is not vouched/u);
  });

  it('separates "no depth was priced" from "no flag explains it"', () => {
    // The second deserves suspicion rather than a shrug.
    const cost = describeQuoteCost(quote({ qualityFlags: [] }), { outcome: BOOK });

    expect(cost.sizeConfidence).toBe('UNKNOWN');
  });

  it('reports a priced depth that does not cover the order as PARTIAL', () => {
    const cost = describeQuoteCost(
      quote({ expectedFillSize: '4', qualityFlags: [], liquidityTier: 'A' }),
      { outcome: BOOK, requestedSize: '9.478798' },
    );

    expect(cost.sizeConfidence).toBe('PARTIAL');
    expect(cost.vouchedSize).toBe('4');
    expect(cost.concerns.join(' ')).toMatch(/partial fill or none/u);
  });

  it('reports a priced depth that covers the order as VOUCHED, with no concern', () => {
    const cost = describeQuoteCost(
      quote({ expectedFillSize: '20', qualityFlags: [], liquidityTier: 'A' }),
      { outcome: { indicativeBid: '0.5270', indicativeAsk: '0.5275' }, requestedSize: '9' },
    );

    expect(cost.sizeConfidence).toBe('VOUCHED');
    expect(cost.concerns).toEqual([]);
  });
});

describe('the fee', () => {
  it('reports an absent fee as embedded in the price, never as zero', () => {
    const cost = describeQuoteCost(quote(), { outcome: BOOK });

    expect(cost.fee).toMatchObject({ available: false, amount: null, basis: 'EMBEDDED_IN_PRICE' });
    expect(cost.fee.detail).toMatch(/do not report a fee of zero/iu);
  });

  it('reports a quoted fee as quoted', () => {
    const cost = describeQuoteCost(quote({ feeAmount: '0.05' }), { outcome: BOOK });

    expect(cost.fee).toMatchObject({ available: true, amount: '0.05', basis: 'REPORTED' });
  });
});

describe('quality flags that make a price unusable', () => {
  it('says a STALE quote is not something to order against', () => {
    const cost = describeQuoteCost(quote({ qualityFlags: ['STALE'] }), { outcome: BOOK });

    expect(cost.concerns.join(' ')).toMatch(/Do not order against it/u);
  });

  it('says an INDICATIVE_ONLY price is not committable', () => {
    const cost = describeQuoteCost(quote({ qualityFlags: ['INDICATIVE_ONLY'] }), {
      outcome: BOOK,
    });

    expect(cost.concerns.join(' ')).toMatch(/NOT committable/u);
  });

  it('tolerates a flag it has never heard of rather than rejecting the quote', () => {
    expect(() =>
      describeQuoteCost(quote({ qualityFlags: ['SOMETHING_NEW'] }), { outcome: BOOK }),
    ).not.toThrow();
  });
});

describe('the wide-spread threshold', () => {
  it('is a reporting threshold and never a refusal', () => {
    const cost = describeQuoteCost(quote(), { outcome: BOOK, wideSpreadBps: 300 });

    expect(cost.concerns.some((entry) => entry.includes('892 bps'))).toBe(true);
    // Nothing was blocked; the caller still holds a fully-formed cost report.
    expect(cost.expectedPrice).toBe('0.527493');
  });

  it('stays quiet on a book inside the threshold', () => {
    const cost = describeQuoteCost(
      quote({ expectedPrice: '0.5275', qualityFlags: [], expectedFillSize: '50' }),
      { outcome: { indicativeBid: '0.5270', indicativeAsk: '0.5275' } },
    );

    expect(cost.concerns.filter((entry) => entry.includes('spread'))).toEqual([]);
  });
});
