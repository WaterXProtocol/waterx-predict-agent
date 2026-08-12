/**
 * Exact decimal arithmetic on strings, at this API's scale.
 *
 * Money, sizes and prices arrive as decimal STRINGS and stay that way: a double
 * cannot hold 6-dp money exactly, and every guarantee downstream — the size you
 * stated is the size that trades, the bound you asked for is never loosened —
 * depends on not passing through one. So the CLI parses to a scaled BigInt,
 * computes in integers, and renders back to a string.
 *
 * This mirrors the backend's `domain/decimal.ts` and `domain/price-protection.ts`
 * deliberately, including the rounding DIRECTIONS. It is a local mirror and not a
 * second opinion: it exists so `order preview` can show the caller the boundary
 * their protection implies before anything is signed. The server recomputes the
 * authoritative bound against the SUBMISSION-time quote and may tighten it
 * further at chain granularity — never loosen it — which is why every value
 * derived here is labelled as an estimate where it is reported.
 */

/** wxUSD amounts, share quantities and prices are all 6 dp on this API. */
export const DECIMALS = 6;

/** 1.0 at `DECIMALS` — the maximum legal price. */
export const ONE = 10n ** BigInt(DECIMALS);

export const BPS_DENOMINATOR = 10_000n;

/** Digits only, optional single fraction part. No sign, no exponent, no spaces. */
const DECIMAL_PATTERN = /^(?<whole>\d+)(?:\.(?<fraction>\d+))?$/u;

/**
 * Parse a non-negative decimal string into an integer scaled by `10 ** DECIMALS`,
 * or null when it is not one.
 *
 * Excess precision is a REJECTION, not a rounding: a value with 7 fractional
 * digits means the caller stated a size this API cannot trade, and quietly
 * truncating it would trade a different size than the one they wrote. Returning
 * null rather than throwing keeps this module free of the CLI's error namespace —
 * the caller knows whether a bad value is a config error or an input error.
 */
export function parseDecimal(value: string): bigint | null {
  const match = DECIMAL_PATTERN.exec(value);
  const whole = match?.groups?.whole;
  if (whole === undefined) return null;
  const fraction = match?.groups?.fraction ?? '';
  if (fraction.length > DECIMALS) return null;
  return BigInt(whole + fraction.padEnd(DECIMALS, '0'));
}

/** Render a scaled integer as its canonical decimal string (no trailing zeros). */
export function formatDecimal(scaled: bigint): string {
  const whole = scaled / ONE;
  const fraction = (scaled % ONE).toString().padStart(DECIMALS, '0').replace(/0+$/u, '');
  return fraction === '' ? whole.toString() : `${whole.toString()}.${fraction}`;
}

/** `floor(a * b / c)`. Integer throughout: no intermediate ever becomes a double. */
export function mulDivFloor(a: bigint, b: bigint, c: bigint): bigint {
  return (a * b) / c;
}

/** `ceil(a * b / c)`. */
export function mulDivCeil(a: bigint, b: bigint, c: bigint): bigint {
  const product = a * b;
  return product / c + (product % c === 0n ? 0n : 1n);
}

export interface WorstPriceIntent {
  readonly side: 'BUY' | 'SELL';
  /** The reference quote's expected price, as a decimal string. */
  readonly referencePrice: string;
  /** `0 <= maxSlippageBps < 10000`. */
  readonly maxSlippageBps: number;
  /** An absolute bound, applied only when it is stricter than the slippage one. */
  readonly worstAcceptablePrice?: string | undefined;
}

export interface WorstPriceEstimate {
  /** The bound the slippage budget alone implies. */
  readonly fromSlippage: string;
  /** The stricter of the slippage bound and any absolute bound. */
  readonly effective: string;
  /** Which of the two decided it, so a caller can see their bound was redundant. */
  readonly binding: 'SLIPPAGE' | 'WORST_ACCEPTABLE_PRICE';
}

/**
 * The worst price this intent's protection implies, given this quote.
 *
 * A BUY is bounded ABOVE (a higher price is adverse) and a SELL BELOW, and each
 * bound rounds toward the caller — down for a buy ceiling, up for a sell floor —
 * because rounding the other way hands back a fraction of a basis point of
 * slippage nobody asked for. The absolute bound wins only when it is stricter.
 *
 * Returns null when the reference price is outside `(0, 1]`, rather than
 * inventing a bound from a price that cannot exist.
 */
export function estimateWorstAcceptablePrice(
  intent: WorstPriceIntent,
): WorstPriceEstimate | null {
  const reference = parseDecimal(intent.referencePrice);
  if (reference === null || reference <= 0n || reference > ONE) return null;
  if (
    !Number.isInteger(intent.maxSlippageBps) ||
    intent.maxSlippageBps < 0 ||
    BigInt(intent.maxSlippageBps) >= BPS_DENOMINATOR
  ) {
    return null;
  }

  const slippage = BigInt(intent.maxSlippageBps);
  const isBuy = intent.side === 'BUY';
  const raw = isBuy
    ? mulDivFloor(reference, BPS_DENOMINATOR + slippage, BPS_DENOMINATOR)
    : mulDivCeil(reference, BPS_DENOMINATOR - slippage, BPS_DENOMINATOR);
  // A buy ceiling above 1.0 is meaningless: an outcome share can never cost more
  // than the $1 it pays out.
  const fromSlippage = isBuy && raw > ONE ? ONE : raw;

  const absolute =
    intent.worstAcceptablePrice === undefined ? null : parseDecimal(intent.worstAcceptablePrice);
  if (absolute === null || absolute <= 0n || absolute > ONE) {
    return {
      fromSlippage: formatDecimal(fromSlippage),
      effective: formatDecimal(fromSlippage),
      binding: 'SLIPPAGE',
    };
  }

  const stricter = isBuy
    ? (absolute < fromSlippage ? absolute : fromSlippage)
    : (absolute > fromSlippage ? absolute : fromSlippage);
  return {
    fromSlippage: formatDecimal(fromSlippage),
    effective: formatDecimal(stricter),
    binding: stricter === absolute && stricter !== fromSlippage ? 'WORST_ACCEPTABLE_PRICE' : 'SLIPPAGE',
  };
}
