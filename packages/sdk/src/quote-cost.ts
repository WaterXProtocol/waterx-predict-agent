/**
 * What an order actually costs, and what the quote is not able to promise.
 *
 * Two things this API reports honestly and no caller can act on directly.
 *
 * THE SPREAD IS NOT THE SLIPPAGE BOUND. `maxSlippageBps` protects a fill
 * against movement away from the quote it was priced at. It says nothing about
 * the distance between the bid and the ask, and on this venue that distance is
 * the dominant cost: a five-minute round quoting 0.4825 / 0.5275 is a spread of
 * roughly 890 bps, so a buy at a 100 bps slippage bound fills inside its
 * protection and the position still marks about nine percent underwater the
 * instant it exists — entry takes the ask, the mark takes the bid. A caller
 * reading only `expectedPrice` and `maxSlippageBps` cannot see that, has no
 * field to threshold on, and ends up explaining it in prose to a user who is
 * looking at a loss they did not expect. `spreadBps` and
 * `immediateMarkToMarketBps` are that field.
 *
 * A SIZE-BLIND QUOTE PROTECTS PRICE, NOT QUANTITY. `TOP_OF_BOOK_ONLY` with a
 * `liquidityTier` of `C` means exactly what the contract says: best bid and ask,
 * no depth, `expectedFillSize` and `availableSize` null. The consequence is the
 * part that is easy to miss — the order may simply not fill, at any price. At
 * five units it does not matter. At the per-order ceiling an owner signed it
 * does. `sizeConfidence` turns "the fields happen to be null" into something a
 * caller can refuse on.
 *
 * ROUNDING. Every bps figure here is rounded UP. These are costs, and a cost
 * that rounds down is a cost a threshold lets through. The error is under one
 * basis point and it is always in the direction of caution.
 *
 * Nothing here fetches anything, decides anything, or blocks anything. It reads
 * a quote — and, when the caller has one, the market's own top of book — and
 * states what follows. Whether an 890 bps spread is acceptable is a mandate
 * question, and mandates belong to owners.
 */
import { compareDecimal, fromScaled, toScaled } from './decimal.ts';
import type {
  DecimalString,
  PredictLiquidityTier,
  PredictMarketOutcome,
  PredictQuote,
  PredictSide,
  PriceString,
} from './contract.ts';

/** Basis points, rounded away from zero. See the header on why up. */
function bpsCeil(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) return 0;
  const scaled = numerator * 10_000n;
  const whole = scaled / denominator;
  return Number(scaled % denominator === 0n ? whole : whole + 1n);
}

export interface PriceSpread {
  readonly bid: PriceString | null;
  readonly ask: PriceString | null;
  /** Mid-market. Null whenever either side is missing — never half of one side. */
  readonly mid: PriceString | null;
  /** `(ask − bid) / mid`, in basis points. Null when either side is missing. */
  readonly spreadBps: number | null;
  /** True when the book is crossed or inverted — a venue fault, not a cheap trade. */
  readonly crossed: boolean;
}

/**
 * The top of book for one outcome, as a spread.
 *
 * A null on either side stays null all the way through. Substituting the other
 * side, or a last trade, would produce a spread of zero on exactly the markets
 * where the number matters most.
 */
export function describeSpread(
  outcome: Pick<PredictMarketOutcome, 'indicativeBid' | 'indicativeAsk'>,
): PriceSpread {
  const { indicativeBid: bid, indicativeAsk: ask } = outcome;
  if (bid === null || ask === null) {
    return { bid, ask, mid: null, spreadBps: null, crossed: false };
  }
  const bidScaled = toScaled(bid);
  const askScaled = toScaled(ask);
  if (compareDecimal(ask, bid) < 0) {
    return { bid, ask, mid: null, spreadBps: null, crossed: true };
  }
  const midScaled = (bidScaled + askScaled) / 2n;
  return {
    bid,
    ask,
    mid: fromScaled(midScaled),
    spreadBps: bpsCeil(askScaled - bidScaled, midScaled),
    crossed: false,
  };
}

/**
 * How much of the requested size the quote is willing to vouch for.
 *
 * `VOUCHED` — depth was priced; `expectedFillSize` is a number and covers the
 * order. `PARTIAL` — depth was priced and does NOT cover it. `TOP_OF_BOOK_ONLY`
 * — the server said so, and null sizes follow from that rather than from an
 * absence of liquidity. `UNKNOWN` — sizes are null and no flag explains it,
 * which is the one case that deserves suspicion rather than a shrug.
 */
export type SizeConfidence = 'VOUCHED' | 'PARTIAL' | 'TOP_OF_BOOK_ONLY' | 'UNKNOWN';

/** Where the fee went, when there is no number to report. */
export type FeeBasis = 'REPORTED' | 'EMBEDDED_IN_PRICE' | 'UNKNOWN';

export interface QuoteFeeFacts {
  readonly available: boolean;
  readonly amount: DecimalString | null;
  readonly basis: FeeBasis;
  readonly detail: string;
}

export interface QuoteCost {
  readonly quoteId: string;
  readonly side: PredictSide;
  readonly expectedPrice: PriceString;
  readonly liquidityTier: PredictLiquidityTier;
  /** Present only when the caller supplied the market's top of book. */
  readonly spread: PriceSpread | undefined;
  /**
   * What a BUY is down the moment it fills: the distance from the price paid to
   * the price the position will mark at, in basis points.
   *
   * Null for a SELL, which realizes rather than opens — the spread on an exit
   * was already paid on the way in, and reporting it again would double-count
   * it. Null for a BUY with no book, because the mark price is not known.
   */
  readonly immediateMarkToMarketBps: number | null;
  readonly sizeConfidence: SizeConfidence;
  /** The size the quote vouches for, when it vouches for one. */
  readonly vouchedSize: DecimalString | null;
  readonly fee: QuoteFeeFacts;
  /**
   * What a caller should say out loud before placing this order, most costly
   * first. Empty when there is nothing to warn about — which is a real answer,
   * not a default.
   */
  readonly concerns: readonly string[];
}

export interface DescribeQuoteCostOptions {
  /**
   * The market's top of book for the same outcome, from `getMarket` or
   * `getMarkets`. Without it the spread cannot be computed and every field that
   * depends on it stays null rather than being estimated from the quote alone.
   */
  readonly outcome?: Pick<PredictMarketOutcome, 'indicativeBid' | 'indicativeAsk'>;
  /**
   * The size this order asks for, so `sizeConfidence` can compare it against
   * what the quote vouches for. Omitted, a priced depth is reported as vouched
   * without a comparison to make.
   */
  readonly requestedSize?: DecimalString;
  /**
   * Spread at or above which to raise a concern. Default 300 bps — three
   * percent, which is wider than any liquid book here and narrower than every
   * short-dated round. It is a reporting threshold, never a refusal.
   */
  readonly wideSpreadBps?: number;
}

const DEFAULT_WIDE_SPREAD_BPS = 300;

function feeFacts(quote: PredictQuote): QuoteFeeFacts {
  if (quote.feeAmount !== null) {
    return {
      available: true,
      amount: quote.feeAmount,
      basis: 'REPORTED',
      detail: 'The server quoted a fee amount separately from the price.',
    };
  }
  return {
    available: false,
    amount: null,
    basis: 'EMBEDDED_IN_PRICE',
    detail:
      'No fee is quoted separately, which this contract defines as the fee being inside `expectedPrice`. Do not report a fee of zero and do not compute one — the price already carries it.',
  };
}

function sizeConfidenceFor(
  quote: PredictQuote,
  requestedSize: DecimalString | undefined,
): { confidence: SizeConfidence; vouchedSize: DecimalString | null } {
  const vouched = quote.expectedFillSize ?? quote.availableSize;
  if (vouched !== null) {
    if (requestedSize !== undefined && compareDecimal(vouched, requestedSize) < 0) {
      return { confidence: 'PARTIAL', vouchedSize: vouched };
    }
    return { confidence: 'VOUCHED', vouchedSize: vouched };
  }
  if (quote.qualityFlags.includes('TOP_OF_BOOK_ONLY')) {
    return { confidence: 'TOP_OF_BOOK_ONLY', vouchedSize: null };
  }
  return { confidence: 'UNKNOWN', vouchedSize: null };
}

/**
 * The cost and the caveats of one quote, as fields rather than as prose.
 *
 * Pass the market outcome alongside it wherever you have one: without a book
 * this can still report fees and size confidence, but the spread — the number
 * that dominates on this venue — is not derivable from a quote alone.
 */
export function describeQuoteCost(
  quote: PredictQuote,
  options: DescribeQuoteCostOptions = {},
): QuoteCost {
  const spread = options.outcome === undefined ? undefined : describeSpread(options.outcome);
  const { confidence, vouchedSize } = sizeConfidenceFor(quote, options.requestedSize);
  const fee = feeFacts(quote);
  const wideSpreadBps = options.wideSpreadBps ?? DEFAULT_WIDE_SPREAD_BPS;

  // Entry takes the ask; the position marks at the bid. That is the whole of it,
  // and it applies to the side that OPENS.
  let immediateMarkToMarketBps: number | null = null;
  if (quote.side === 'BUY' && spread?.bid != null) {
    const paid = toScaled(quote.expectedPrice);
    const marks = toScaled(spread.bid);
    immediateMarkToMarketBps = paid > marks ? bpsCeil(paid - marks, paid) : 0;
  }

  const concerns: string[] = [];
  if (spread?.crossed === true) {
    concerns.push(
      'The book is crossed — the bid is above the ask. Treat every price on this outcome as unusable until it un-crosses; this is a venue fault, not an opportunity.',
    );
  }
  // Reported as a field always; raised as a CONCERN only once it is material.
  // A ten-basis-point entry cost on a tight book is arithmetic, not a warning,
  // and a report that warns about everything is one nobody reads to the end of.
  if (immediateMarkToMarketBps !== null && immediateMarkToMarketBps >= wideSpreadBps) {
    concerns.push(
      `This buy fills at ${quote.expectedPrice} and marks at ${String(spread?.bid)} — about ${String(immediateMarkToMarketBps)} bps down the moment it exists. \`maxSlippageBps\` does not protect against this; it bounds movement away from the quote, not the spread you cross to reach it.`,
    );
  }
  if (spread?.spreadBps != null && spread.spreadBps >= wideSpreadBps) {
    concerns.push(
      `The spread is ${String(spread.spreadBps)} bps (${spread.bid} / ${spread.ask}). Round-tripping this position costs that much before the outcome resolves either way.`,
    );
  }
  if (confidence === 'TOP_OF_BOOK_ONLY') {
    concerns.push(
      'The quote priced the top of book with no depth, so the price is protected and the QUANTITY is not vouched for. A large order may not fill at all. Size accordingly, or split it.',
    );
  }
  if (confidence === 'PARTIAL') {
    concerns.push(
      `The quote vouches for ${String(vouchedSize)}, which is less than the ${String(options.requestedSize)} requested. Expect a partial fill or none.`,
    );
  }
  if (confidence === 'UNKNOWN') {
    concerns.push(
      'The quote reports no fill size and no flag explaining why. Nothing can be inferred about whether this size is available.',
    );
  }
  if (quote.qualityFlags.includes('STALE')) {
    concerns.push(
      'The quote carries `STALE`: no value fresher than the staleness bound exists. Do not order against it.',
    );
  }
  if (quote.qualityFlags.includes('INDICATIVE_ONLY')) {
    concerns.push(
      'The quote carries `INDICATIVE_ONLY` and is NOT committable. Only a quote minted through `POST /quotes` can be executed.',
    );
  }

  return {
    quoteId: quote.quoteId,
    side: quote.side,
    expectedPrice: quote.expectedPrice,
    liquidityTier: quote.liquidityTier,
    spread,
    immediateMarkToMarketBps,
    sizeConfidence: confidence,
    vouchedSize,
    fee,
    concerns,
  };
}
