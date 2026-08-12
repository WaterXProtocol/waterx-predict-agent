/**
 * Exact comparison of the API's decimal strings.
 *
 * `parseFloat` is not an option on a price that gates a trade: `0.505 > 0.5049`
 * happens to work, but the moment a comparison sits on a boundary the float
 * rounding decides whether money moves. Everything here scales to BigInt first.
 */

/** The API's decimal strings carry at most 6 fractional digits. */
const SCALE = 6;

/** Digits, optional single fraction part. No sign, no exponent. */
const DECIMAL = /^\d+(?:\.\d+)?$/;

/**
 * A decimal string as an exact integer scaled by 1e6.
 *
 * Throws rather than coercing: a malformed price reaching a comparison would
 * silently answer "target not met" forever, and a strategy would simply never
 * fire with nothing to show why.
 */
export function toScaled(value: string): bigint {
  if (!DECIMAL.test(value)) {
    throw new RangeError(`not a decimal string: ${JSON.stringify(value)}`);
  }
  const [whole = '0', fraction = ''] = value.split('.');
  if (fraction.length > SCALE) {
    throw new RangeError(`more than ${String(SCALE)} decimal places: ${value}`);
  }
  return BigInt(whole + fraction.padEnd(SCALE, '0'));
}

/** `-1` when `a < b`, `0` when equal, `1` when `a > b`. */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const left = toScaled(a);
  const right = toScaled(b);
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/**
 * Whether a quoted price has reached the agent's target, for the given side.
 *
 * The two sides are NOT symmetric and getting it backwards is the kind of bug
 * that only shows up as "my strategy sold at the worst possible moment":
 *   - BUY  — the target is a CEILING. Fire when the ask is at or below it.
 *   - SELL — the target is a FLOOR.   Fire when the bid is at or above it.
 *
 * `PredictQuote.expectedPrice` is already the side-appropriate price (the ask for
 * a BUY, the bid for a SELL), so one comparison covers both once the direction is
 * right.
 */
export function targetReached(
  side: 'BUY' | 'SELL',
  quotedPrice: string,
  targetPrice: string,
): boolean {
  const comparison = compareDecimal(quotedPrice, targetPrice);
  return side === 'BUY' ? comparison <= 0 : comparison >= 0;
}
