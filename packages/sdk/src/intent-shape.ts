/**
 * What a write intent has to look like before this SDK will remember one.
 *
 * THIS IS A VENDORED COPY, NOT A SECOND OPINION. Every rule below is the
 * canonical one from `packages/schema/src/defs.ts`, which itself mirrors the
 * backend's request validation. The SDK cannot import that package — it has one
 * runtime dependency and `tests/workspace.test.ts` fails if that changes — so
 * the constants are duplicated here and the same test byte-compares them. A
 * copy that drifts is worse than no copy, and the comparison is what stops it.
 *
 * WHY THE LEDGER VALIDATES AT ALL, when the server owns the contract. An
 * earlier version of this file asked only whether the fields were present and
 * broadly the right JavaScript types, on the reasoning that the store's job is
 * "could this be re-sent" rather than "is this a legal order". That distinction
 * does not survive contact with the thing the store is for. A reservation is
 * durable: it takes a key, it goes on disk, and every later attempt at that
 * intent replays it. Writing down an intent the server will refuse produces a
 * key held against an order that can never exist — a PENDING record the
 * recovery path treats as recoverable and the API rejects every time it is
 * tried. `outcomeId: "MAYBE"`, a BUY carrying `sellShares`, a size of `"0"` or
 * `"1e3"`, a slippage of `10000`: all of them reached the ledger, and none of
 * them can ever be finished.
 *
 * Stricter than the wire in one place, deliberately, and the schema says the
 * same: a size of `"0"` is refused here rather than accepted and rejected
 * deeper in the stack, because an ambiguous size must stop before a write
 * (ADR-0001 §10).
 */

/** Money and share scale on this API. Matches `MONEY_DECIMALS`/`PRICE_DECIMALS`. */
export const DECIMAL_SCALE = 6;

/**
 * A decimal string greater than zero, at most 6 dp.
 *
 * Byte-identical to `POSITIVE_DECIMAL_AMOUNT_PATTERN` in the schema package.
 */
export const POSITIVE_DECIMAL_AMOUNT_PATTERN = '^(?!0+(\\.0+)?$)[0-9]+(\\.[0-9]{1,6})?$';

/** A probability price in the inclusive range 0–1, at most 6 dp. */
export const PROBABILITY_PRICE_PATTERN = '^(0+(\\.[0-9]{1,6})?|0*1(\\.0{1,6})?)$';

/** A full-length `0x`-prefixed Sui address. */
export const SUI_ADDRESS_PATTERN = '^0x[0-9a-fA-F]{64}$';

/** The bounds every opaque identifier on this API shares. */
export const IDENTIFIER_MIN_LENGTH = 1;
export const IDENTIFIER_MAX_LENGTH = 128;

/** Slippage is an integer in basis points; 10000 would remove all protection. */
export const MAX_SLIPPAGE_BPS_MIN = 0;
export const MAX_SLIPPAGE_BPS_MAX = 9999;

const positiveDecimal = new RegExp(POSITIVE_DECIMAL_AMOUNT_PATTERN, 'u');
const probabilityPrice = new RegExp(PROBABILITY_PRICE_PATTERN, 'u');
const suiAddress = new RegExp(SUI_ADDRESS_PATTERN, 'u');

const isIdentifier = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length >= IDENTIFIER_MIN_LENGTH &&
  value.length <= IDENTIFIER_MAX_LENGTH;

/** Optional intent fields that are opaque identifiers when they are present. */
const OPTIONAL_IDENTIFIERS = ['clientOrderId', 'strategyId'] as const;

/**
 * Why this intent could not be re-sent, or `undefined` if it could.
 *
 * One reason at a time, most structural first, because a caller fixes them one
 * at a time and a list of six complaints about one malformed object is a list
 * nobody reads to the end of.
 */
export function unrecoverableIntentReason(
  intent: Readonly<Record<string, unknown>>,
): string | undefined {
  if (!suiAddress.test(String(intent.accountId))) {
    return '`accountId` is not a full 0x-prefixed Sui address';
  }
  if (!isIdentifier(intent.marketId)) {
    return `\`marketId\` is not a string of ${String(IDENTIFIER_MIN_LENGTH)}–${String(IDENTIFIER_MAX_LENGTH)} characters`;
  }
  if (intent.outcomeId !== 'YES' && intent.outcomeId !== 'NO') {
    return '`outcomeId` is not YES or NO';
  }
  if (intent.side !== 'BUY' && intent.side !== 'SELL') return '`side` is not BUY or SELL';

  const size = intent.size as Record<string, unknown> | null;
  if (size === null || typeof size !== 'object' || Array.isArray(size)) {
    return '`size` is not an object';
  }
  // Exactly one unit, and the one the side calls for. Supplying both is an
  // intent whose size is genuinely unknown, and picking one would be the guess
  // the whole unit split exists to prevent (ADR-0001 §11).
  const unit = intent.side === 'BUY' ? 'buyAmount' : 'sellShares';
  const other = intent.side === 'BUY' ? 'sellShares' : 'buyAmount';
  if (size[other] !== undefined) {
    return `\`size.${other}\` is set on a ${String(intent.side)}; a BUY states buyAmount and a SELL states sellShares`;
  }
  if (Object.keys(size).length !== 1 || size[unit] === undefined) {
    return `\`size\` must carry exactly \`${unit}\` for a ${String(intent.side)}`;
  }
  if (typeof size[unit] !== 'string' || !positiveDecimal.test(size[unit])) {
    return `\`size.${unit}\` is not a decimal string greater than zero with at most ${String(DECIMAL_SCALE)} decimal places`;
  }

  // A SELL names the position it closes; a BUY opens one and names none.
  if (intent.side === 'SELL' && !isIdentifier(intent.positionId)) {
    return '`positionId` is required on a SELL and must be an identifier';
  }
  if (intent.side === 'BUY' && intent.positionId !== undefined) {
    return '`positionId` is set on a BUY, which opens a position rather than closing one';
  }

  if (
    typeof intent.maxSlippageBps !== 'number' ||
    !Number.isInteger(intent.maxSlippageBps) ||
    intent.maxSlippageBps < MAX_SLIPPAGE_BPS_MIN ||
    intent.maxSlippageBps > MAX_SLIPPAGE_BPS_MAX
  ) {
    return `\`maxSlippageBps\` is not an integer in ${String(MAX_SLIPPAGE_BPS_MIN)}–${String(MAX_SLIPPAGE_BPS_MAX)}`;
  }

  if (
    intent.worstAcceptablePrice !== undefined &&
    (typeof intent.worstAcceptablePrice !== 'string' ||
      !probabilityPrice.test(intent.worstAcceptablePrice))
  ) {
    return '`worstAcceptablePrice` is not a probability price in the inclusive range 0–1';
  }
  for (const field of OPTIONAL_IDENTIFIERS) {
    if (intent[field] !== undefined && !isIdentifier(intent[field])) {
      return `\`${field}\` is present and is not an identifier of ${String(IDENTIFIER_MIN_LENGTH)}–${String(IDENTIFIER_MAX_LENGTH)} characters`;
    }
  }
  return undefined;
}

/**
 * The same bounds, for the opaque identifiers a RECORD holds rather than the
 * intent it names — its idempotency key and the execution it points at.
 *
 * Both are replayed verbatim: the key into a request header, the execution id
 * into the path of the read that reconciles it. An empty one passed a `typeof`
 * check and would have been sent.
 */
export function unusableIdentifierReason(value: unknown): string | undefined {
  return isIdentifier(value)
    ? undefined
    : `not a string of ${String(IDENTIFIER_MIN_LENGTH)}–${String(IDENTIFIER_MAX_LENGTH)} characters`;
}
