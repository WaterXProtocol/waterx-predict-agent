/**
 * Shared field definitions for the agent command schema.
 *
 * These mirror the backend's request validation
 * (`apps/waterx/src/predict/agent-api/dto/`) rather than inventing a second
 * opinion about what a valid amount or account id is. Where a definition is
 * deliberately STRICTER than the server, it says so and why — a local surface
 * may refuse an intent the server would accept, but it must never accept one the
 * server would reject and it must never claim a permission the server does not
 * grant (ADR-0001 §9).
 */
import type { JsonSchema } from './json-schema.ts';

/** Money and share scale on this API. Matches `MONEY_DECIMALS`/`PRICE_DECIMALS`. */
export const DECIMAL_SCALE = 6;

/**
 * A non-negative decimal string with at most 6 dp, matching the server's
 * `IsDecimalAmount`. Never a JSON number: a double cannot hold 6-dp money
 * exactly, and the whole API guarantee is that the size stated is the size that
 * trades.
 */
export const DECIMAL_AMOUNT_PATTERN = '^[0-9]+(\\.[0-9]{1,6})?$';

/**
 * The same shape, minus zero.
 *
 * Stricter than the server on purpose: the server accepts `"0"` and rejects the
 * order later, deeper in the stack. A zero-size order is an intent an agent did
 * not mean to state, and an ambiguous size must stop before a write (ADR-0001
 * §10), so it fails here where the error names the field.
 */
export const POSITIVE_DECIMAL_AMOUNT_PATTERN = '^(?!0+(\\.0+)?$)[0-9]+(\\.[0-9]{1,6})?$';

/**
 * A probability price in the inclusive range 0–1 with at most 6 dp, matching the
 * server's `IsProbabilityPrice`. Expressed as a pattern rather than a numeric
 * bound because the value is a string; parsing it to a float to bound it would
 * reintroduce the precision loss the string format exists to avoid.
 */
export const PROBABILITY_PRICE_PATTERN = '^(0+(\\.[0-9]{1,6})?|0*1(\\.0{1,6})?)$';

/** A full-length `0x`-prefixed Sui address, matching the server's `IsSuiAddress`. */
export const SUI_ADDRESS_PATTERN = '^0x[0-9a-fA-F]{64}$';

const positiveDecimalAmount: JsonSchema = {
  title: 'Positive decimal amount',
  description: `A decimal string greater than zero with at most ${String(DECIMAL_SCALE)} decimal places, e.g. "50". Never a JSON number.`,
  type: 'string',
  pattern: POSITIVE_DECIMAL_AMOUNT_PATTERN,
};

const probabilityPrice: JsonSchema = {
  title: 'Probability price',
  description: 'A decimal string in the inclusive range 0–1, e.g. "0.82". Never a JSON number.',
  type: 'string',
  pattern: PROBABILITY_PRICE_PATTERN,
};

const accountId: JsonSchema = {
  title: 'Account id',
  description:
    'The WaterX Predict account the order settles against, as a full 0x-prefixed Sui address.',
  type: 'string',
  pattern: SUI_ADDRESS_PATTERN,
};

const marketId: JsonSchema = {
  title: 'Market id',
  description:
    'A server-resolved market identifier. Obtain it from market.list or market.get; an agent must never construct or guess one (ADR-0001 §10).',
  type: 'string',
  minLength: 1,
  maxLength: 128,
};

const outcomeId: JsonSchema = {
  title: 'Outcome id',
  description: 'The binary leg. A closed set on this API version.',
  type: 'string',
  enum: ['YES', 'NO'],
};

const side: JsonSchema = {
  title: 'Side',
  description: 'BUY commits a wxUSD budget. SELL closes shares of an existing position.',
  type: 'string',
  enum: ['BUY', 'SELL'],
};

const buySize: JsonSchema = {
  title: 'BUY size (buyAmount)',
  description: 'A BUY commits a wxUSD budget.',
  type: 'object',
  required: ['buyAmount'],
  additionalProperties: false,
  properties: { buyAmount: { $ref: '#/$defs/positiveDecimalAmount' } },
};

const sellSize: JsonSchema = {
  title: 'SELL size (sellShares)',
  description: 'A SELL states a share quantity to close.',
  type: 'object',
  required: ['sellShares'],
  additionalProperties: false,
  properties: { sellShares: { $ref: '#/$defs/positiveDecimalAmount' } },
};

/**
 * Exactly one of `buyAmount`/`sellShares`.
 *
 * The two are NOT interchangeable and an ambiguous unit is never resolved by
 * guessing (ADR-0001 §11). `oneOf` over two closed objects is what makes
 * `{ buyAmount, sellShares }` — an intent whose size is genuinely unknown —
 * fail rather than quietly pick one.
 */
const orderSize: JsonSchema = {
  title: 'Order size',
  type: 'object',
  description:
    'Exactly one field, decided by side: buyAmount for a BUY, sellShares for a SELL. Supplying both or neither is an error, not a preference.',
  oneOf: [{ $ref: '#/$defs/buySize' }, { $ref: '#/$defs/sellSize' }],
};

/**
 * BUY ⇒ buyAmount, SELL ⇒ sellShares. Applied with `allOf` so it constrains the
 * same object the field definitions do.
 */
const sideSizeAgreement: JsonSchema = {
  title: 'Side and size unit agree',
  description: 'A BUY states buyAmount; a SELL states sellShares (ADR-0001 §11).',
  oneOf: [
    {
      title: 'BUY with buyAmount',
      type: 'object',
      required: ['side', 'size'],
      properties: { side: { const: 'BUY' }, size: { $ref: '#/$defs/buySize' } },
    },
    {
      title: 'SELL with sellShares',
      type: 'object',
      required: ['side', 'size'],
      properties: { side: { const: 'SELL' }, size: { $ref: '#/$defs/sellSize' } },
    },
  ],
};

/**
 * A SELL names the position it closes; a BUY opens one and names none.
 *
 * The `type: 'null'` in the BUY variant is how "must be absent" is expressed
 * within this schema subset: an absent property is not validated, so a BUY that
 * carries a positionId fails the variant while a BUY that omits it passes. The
 * top-level `positionId: { type: 'string' }` then rejects an explicit null, so
 * neither form of "a BUY with a position" gets through.
 */
const positionAgreement: JsonSchema = {
  title: 'Position id matches the side',
  description:
    'A SELL identifies the on-chain position being closed. A BUY must not name one.',
  oneOf: [
    {
      title: 'BUY closes no position',
      type: 'object',
      required: ['side'],
      properties: { side: { const: 'BUY' }, positionId: { type: 'null' } },
    },
    {
      title: 'SELL names the position it closes',
      type: 'object',
      required: ['side', 'positionId'],
      properties: { side: { const: 'SELL' }, positionId: { type: 'string', minLength: 1 } },
    },
  ],
};

const maxSlippageBps: JsonSchema = {
  title: 'Maximum slippage (bps)',
  description:
    'Mandatory price protection. 10000 is rejected rather than clamped — it would remove all protection while still looking protected.',
  type: 'integer',
  minimum: 0,
  maximum: 9999,
};

const limit: JsonSchema = {
  title: 'Page size',
  description: 'Rows to return. The server caps this at 200 and has no cursor yet.',
  type: 'integer',
  minimum: 1,
  maximum: 200,
};

const idempotencyKey: JsonSchema = {
  title: 'Idempotency key',
  description:
    'One key per logical order intent, reused for every retry of that intent. Supply it to make the intent replayable across a process restart; omitted, the runtime mints one that only covers in-process retries.',
  type: 'string',
  minLength: 1,
  maxLength: 128,
};

/**
 * One protected market order, as every surface must state it.
 *
 * Exported as properties rather than only as a finished schema because
 * `order.execute` adds wait options to the same field set. Composing in code
 * keeps one source for the intent; composing in JSON Schema could not, since a
 * closed object cannot be extended through `allOf`.
 */
export const ORDER_INTENT_PROPERTIES: Readonly<Record<string, JsonSchema>> = {
  accountId: { $ref: '#/$defs/accountId' },
  marketId: { $ref: '#/$defs/marketId' },
  outcomeId: { $ref: '#/$defs/outcomeId' },
  side: { $ref: '#/$defs/side' },
  size: { $ref: '#/$defs/orderSize' },
  positionId: {
    title: 'Position id',
    description: 'Required for a SELL: the on-chain position being closed. Absent for a BUY.',
    type: 'string',
    minLength: 1,
    maxLength: 128,
  },
  referenceQuoteId: {
    title: 'Reference quote id',
    description:
      'The executable quote this order is priced against, from market.quote. A quote lives seconds and is never extended, so obtain it immediately before the order — a catalog price is indicative and cannot be used here.',
    type: 'string',
    minLength: 1,
    maxLength: 128,
  },
  maxSlippageBps: { $ref: '#/$defs/maxSlippageBps' },
  worstAcceptablePrice: {
    // `$ref` plus annotations: the constraint stays stated once, in the shared
    // definition, while the title and description say what this particular use
    // of a probability price means.
    $ref: '#/$defs/probabilityPrice',
    title: 'Worst acceptable price',
    description:
      'A probability price in the inclusive range 0–1, as a decimal string. An absolute bound, applied only when it is stricter than the slippage budget. The price the chain enforces may be stricter still after granularity rounding, never looser.',
  },
  clientOrderId: {
    title: 'Client order id',
    description: 'A business label. NOT a substitute for the idempotency key.',
    type: 'string',
    minLength: 1,
    maxLength: 128,
  },
  strategyId: {
    title: 'Strategy id',
    description: 'Attribution label carried onto executions and fills.',
    type: 'string',
    minLength: 1,
    maxLength: 128,
  },
  idempotencyKey: { $ref: '#/$defs/idempotencyKey' },
};

export const ORDER_INTENT_REQUIRED: readonly string[] = [
  'accountId',
  'marketId',
  'outcomeId',
  'side',
  'size',
  'referenceQuoteId',
  'maxSlippageBps',
];

/** Cross-field rules every order intent carries, whatever command submits it. */
export const ORDER_INTENT_RULES: readonly JsonSchema[] = [
  { $ref: '#/$defs/sideSizeAgreement' },
  { $ref: '#/$defs/positionAgreement' },
];

const orderIntent: JsonSchema = {
  title: 'Order intent',
  description:
    'One price-protected market order. Each intent is independent: it has its own quote, idempotency key, execution and result, and no batch is atomic.',
  type: 'object',
  required: [...ORDER_INTENT_REQUIRED],
  additionalProperties: false,
  properties: ORDER_INTENT_PROPERTIES,
  allOf: [...ORDER_INTENT_RULES],
};

/**
 * `$defs` for the emitted document. Every command input `$ref`s into this map,
 * so a field rule is stated once and cannot disagree between commands.
 */
export const COMMAND_SCHEMA_DEFS: Readonly<Record<string, JsonSchema>> = {
  positiveDecimalAmount,
  probabilityPrice,
  accountId,
  marketId,
  outcomeId,
  side,
  buySize,
  sellSize,
  orderSize,
  sideSizeAgreement,
  positionAgreement,
  maxSlippageBps,
  limit,
  idempotencyKey,
  orderIntent,
};
