/**
 * The two directions of a fixed-scale decimal, and the sign only one of them has.
 *
 * `parseScaled` reads prices and sizes, which have no sign and never should —
 * it refuses a negative on purpose. `formatScaled` writes one number the wire
 * contract requires to be signed, `unrealizedPnl`: "a losing position is
 * negative". Nothing had ever formatted one, and the composition it used
 * produced text that is not a number at all, because BigInt division and
 * remainder both truncate toward zero: `-164077n / 1000000n` is `0n` while
 * `-164077n % 1000000n` is `-164077n`, which concatenated to `0.-164077`.
 *
 * The first loss this runtime valued would have been reported as that string.
 */
import { describe, expect, it } from 'vitest';

import { formatScaled, parseScaled } from '../src/direct/protection.ts';

const SCALE = 6;

describe('writing a scaled decimal', () => {
  it('signs a negative instead of composing one out of two truncations', () => {
    expect(formatScaled(-164_077n, SCALE)).toBe('-0.164077');
    expect(formatScaled(-5_000_000n, SCALE)).toBe('-5');
    expect(formatScaled(-5_250_000n, SCALE)).toBe('-5.25');
    // The smallest loss representable at this scale still reads as a number.
    expect(formatScaled(-1n, SCALE)).toBe('-0.000001');
  });

  it('is unchanged for everything that was already right', () => {
    expect(formatScaled(0n, SCALE)).toBe('0');
    expect(formatScaled(164_077n, SCALE)).toBe('0.164077');
    expect(formatScaled(5_000_000n, SCALE)).toBe('5');
    expect(formatScaled(5_250_000n, SCALE)).toBe('5.25');
  });

  it('never writes a negative zero', () => {
    // There is no `-0n`, so the sign can only appear with a magnitude to carry
    // it. A "-0" would read as a loss too small to see rather than as no loss.
    expect(formatScaled(0n, SCALE)).not.toContain('-');
  });

  it('round-trips every non-negative value it writes', () => {
    for (const value of [0n, 1n, 164_077n, 5_000_000n, 5_250_000n, 999_999_999_999n]) {
      expect(parseScaled(formatScaled(value, SCALE), SCALE, 'value')).toBe(value);
    }
  });
});

describe('reading a scaled decimal', () => {
  it('still refuses a negative, because a price and a size have no sign', () => {
    // Deliberately NOT made symmetric with the writer. The asymmetry is the
    // design: one direction reads quantities, the other writes a valuation.
    expect(() => parseScaled('-1.5', SCALE, 'size')).toThrow(/non-negative/u);
  });
});
