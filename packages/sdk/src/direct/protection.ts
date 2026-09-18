/**
 * Price protection for direct mode, in integers only.
 *
 * A port of the Agent API's `domain/price-protection.ts` (bucket-backend-mono
 * `f091697`), because direct mode now makes the decisions that module made on
 * the server: the buy's `price_cap` / `min_shares` and the floor a sell's
 * `min_proceeds` must clear. Every rounding goes toward the agent — a buy cap
 * down, a sell floor up — so the enforced bound is never looser than asked.
 *
 * The web app sends no cap at all (`priceCapBps = 10000`, `minShares = 0`);
 * this client always does, and refuses rather than send an order that cannot
 * be protected.
 */
import { PredictAgentApiError } from '../errors.ts';

export const MONEY_DECIMALS = 6;
export const PRICE_ONE = 1_000_000n;
export const BPS = 10_000n;
const PRICE_UNITS_PER_BP = PRICE_ONE / BPS;
const U64_MAX = 2n ** 64n - 1n;

const refuse = (reason: string, details: Record<string, unknown> = {}): never => {
  throw new PredictAgentApiError(0, {
    code: 'QUOTE_UNAVAILABLE',
    message: `Cannot construct a protected order: ${reason}`,
    retryable: false,
    details: { reason, ...details },
  });
};

const mulDivFloor = (a: bigint, b: bigint, d: bigint): bigint => (a * b) / d;
const mulDivCeil = (a: bigint, b: bigint, d: bigint): bigint => (a * b + d - 1n) / d;

/** A decimal string at `decimals` places → scaled integer. Exact; no floats. */
export function parseScaled(value: string, decimals: number, field: string): bigint {
  const match = /^(\d+)(?:\.(\d+))?$/u.exec(value.trim());
  if (match === null) return refuse(`${field} is not a non-negative decimal`, { [field]: value });
  const fraction = match[2] ?? '';
  if (fraction.length > decimals) {
    return refuse(`${field} has more than ${String(decimals)} decimal places`, { [field]: value });
  }
  return BigInt(match[1]!) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

export function formatScaled(value: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = value / scale;
  const fraction = (value % scale).toString().padStart(decimals, '0').replace(/0+$/u, '');
  return fraction === '' ? whole.toString() : `${whole.toString()}.${fraction}`;
}

/**
 * A public quote — cents, one decimal, as a JSON number — to a price scaled at
 * 1e6. Read through its one-decimal text so a float never decides a price.
 */
export function centsToPrice(cents: number): bigint {
  if (!Number.isFinite(cents) || cents <= 0 || cents >= 100) {
    return refuse('the quote is outside (0, 100) cents', { cents });
  }
  const [whole, fraction = '0'] = cents.toFixed(1).split('.');
  return (BigInt(whole!) * 10n + BigInt(fraction)) * 1_000n;
}

export function assertSlippage(maxSlippageBps: number): void {
  if (!Number.isInteger(maxSlippageBps) || maxSlippageBps < 0 || maxSlippageBps >= 10_000) {
    throw new PredictAgentApiError(0, {
      code: 'INVALID_REQUEST',
      message: 'maxSlippageBps must be an integer in [0, 10000)',
      retryable: false,
      details: { maxSlippageBps },
    });
  }
}

/** The worst acceptable price for `side`, from the reference and the bounds. */
export function worstAcceptable(
  side: 'BUY' | 'SELL',
  reference: bigint,
  maxSlippageBps: number,
  absolute: bigint | undefined,
): bigint {
  assertSlippage(maxSlippageBps);
  if (reference <= 0n || reference > PRICE_ONE) refuse('reference price out of range');
  const slip = BigInt(maxSlippageBps);
  if (side === 'BUY') {
    const fromSlippage = mulDivFloor(reference, BPS + slip, BPS);
    const bound = fromSlippage > PRICE_ONE ? PRICE_ONE : fromSlippage;
    return absolute === undefined || absolute > bound ? bound : absolute;
  }
  const bound = mulDivCeil(reference, BPS - slip, BPS);
  return absolute === undefined || absolute < bound ? bound : absolute;
}

export interface BuyGuards {
  readonly priceCapBps: bigint;
  readonly minShares: bigint;
  /** The price the cap really enforces, scaled 1e6. */
  readonly enforcedWorstPrice: bigint;
}

/** `price_cap` floored to bps; `min_shares` from the ENFORCED price. */
export function buyGuards(maxSpend: bigint, boundary: bigint): BuyGuards {
  if (maxSpend <= 0n) refuse('the amount is not positive');
  const priceCapBps = boundary / PRICE_UNITS_PER_BP;
  if (priceCapBps <= 0n) refuse('the price cap rounds to zero');
  const enforcedWorstPrice = priceCapBps * PRICE_UNITS_PER_BP;
  const minShares = mulDivFloor(maxSpend, PRICE_ONE, enforcedWorstPrice);
  if (minShares <= 0n) refuse('min_shares rounds to zero');
  if (priceCapBps > U64_MAX || minShares > U64_MAX || maxSpend > U64_MAX) refuse('a value exceeds u64');
  return { priceCapBps, minShares, enforcedWorstPrice };
}

/** The smallest `min_proceeds` that keeps a sell at or above `boundary`. */
export function sellFloor(shares: bigint, boundary: bigint): bigint {
  if (shares <= 0n) refuse('the size is not positive');
  if (boundary <= 0n) refuse('the sell floor rounds to zero');
  return mulDivCeil(shares, boundary, PRICE_ONE);
}

/** What a floor actually enforces per share, rounded up. */
export function enforcedSellPrice(minProceeds: bigint, shares: bigint): bigint {
  return mulDivCeil(minProceeds, PRICE_ONE, shares);
}

export const formatPrice = (scaled: bigint): string => formatScaled(scaled, 6);
