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
  description:
    'Rows to return. The server caps this at 200. On the account history reads it composes with `cursor`; the market catalog has no cursor, so there `limit` is the whole of paging.',
  type: 'integer',
  minimum: 1,
  maximum: 200,
};

/**
 * The keyset page cursor for the account history reads.
 *
 * Opaque: it is passed back exactly as received. No `pattern` is asserted beyond
 * non-empty, because its contents are the server's business and a local format
 * rule would start refusing valid cursors the day the server changes its
 * encoding. The server refuses one it cannot honour, and that refusal is the
 * check that matters — an ignored cursor would restart the page at the newest
 * row and a caller walking a history would count those rows twice.
 */
const cursor: JsonSchema = {
  title: 'Page cursor',
  description:
    'The `nextCursor` from the previous page, passed back VERBATIM. Omit it for the newest page. It names the exact row the last page ended on, so rows arriving at the head between two requests cannot shift anything past you. A cursor that is edited, truncated, or taken from a different list is REJECTED with INVALID_REQUEST, never silently ignored.',
  type: 'string',
  minLength: 1,
  maxLength: 512,
};

/**
 * Free text for server-side market resolution.
 *
 * Bounded to match the server's own `@MaxLength(200)`, and non-empty because an
 * empty search is a malformed question rather than a request for everything —
 * the server rejects it outright and the local schema must not accept what the
 * server would refuse.
 */
const searchText: JsonSchema = {
  title: 'Search text',
  description:
    'Free text matched SERVER-SIDE against each market’s published aliases. Matching is deterministic and purely lexical: every token must be a prefix of an alias token. There is no fuzzy distance and no synonym table, so the same text against the same catalog always resolves the same way.',
  type: 'string',
  minLength: 1,
  maxLength: 200,
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

/* ── Strategy definitions ────────────────────────────────────────────────────
 * A durable conditional job, as an operator states it. These describe SHAPE.
 * The rules — exactly one sizing field, a mandatory expiry, the seven-day cap,
 * which trigger fields go together — are deliberately NOT restated here, and
 * that is the same decision `packages/runner/src/ipc/commands.ts` documents at
 * length: they are decided once, in the Runner's `strategy/intent.ts`, by the
 * process that will act on them. A second copy in this document would be a
 * second opinion about how much gets traded, and the caller would get an
 * anonymous schema violation instead of `SIZE_AMBIGUOUS` or `EXPIRY_REQUIRED`
 * with the sentence explaining why.
 *
 * What IS enforced here is everything a shape can carry, and several fields are
 * deliberately stricter than the socket accepts — six-decimal money, a
 * probability price, `YES`/`NO`, slippage below 10000 — because those are the
 * wire contract's own rules and an intent that violated one could never trade. */

const ownerAddress: JsonSchema = {
  title: 'Owner address',
  description:
    'The address that owns the account, as a full 0x-prefixed Sui address. The Runner records it on the job; it is not a second authorization.',
  type: 'string',
  pattern: SUI_ADDRESS_PATTERN,
};

const agentWallet: JsonSchema = {
  title: 'Agent wallet',
  description:
    'The delegated agent wallet the eventual order is signed by, as a full 0x-prefixed Sui address. The private key stays inside the Runner’s signer and never reaches this surface.',
  type: 'string',
  pattern: SUI_ADDRESS_PATTERN,
};

/**
 * A fraction of a holding, in `(0, 1]`.
 *
 * Excludes zero for the same reason `positiveDecimalAmount` does, and excludes
 * anything above 1 because there is no such thing as selling 150% of a position:
 * the Runner would refuse it, and refusing it here names the field.
 */
const positionFraction: JsonSchema = {
  title: 'Fraction of a position',
  description:
    'A decimal string greater than 0 and at most 1 — "0.5" is half. Never a percentage and never a JSON number.',
  type: 'string',
  pattern: '^(0\\.(?!0+$)[0-9]{1,6}|1(\\.0{1,6})?)$',
};

const jobId: JsonSchema = {
  title: 'Job id',
  description:
    'The durable job identifier the Runner minted when the strategy was created. Local to the Runner; the exchange has never heard of it.',
  type: 'string',
  minLength: 1,
  maxLength: 128,
};

/**
 * One leg of a strategy.
 *
 * The four sizing fields are mutually exclusive and all four are optional here:
 * the Runner answers `SIZE_MISSING` or `SIZE_AMBIGUOUS`, which says which rule
 * was broken. `sellFractionOfPosition` and `dynamicSellFractionOfPosition` are
 * separate fields rather than a flag because they are different trades — the
 * first freezes a share count when the strategy is created, the second re-reads
 * the position at the trigger and therefore sells whatever is held then,
 * including shares bought in between.
 */
const strategyLeg: JsonSchema = {
  title: 'Strategy leg',
  description:
    'One order the strategy will place when it triggers. Legs execute INDEPENDENTLY: each has its own quote, its own idempotency key and its own outcome, and no leg is rolled back because another failed.',
  type: 'object',
  required: ['marketId', 'outcomeId', 'side', 'maxSlippageBps'],
  additionalProperties: false,
  properties: {
    marketId: { $ref: '#/$defs/marketId' },
    outcomeId: { $ref: '#/$defs/outcomeId' },
    side: { $ref: '#/$defs/side' },
    buyAmount: {
      $ref: '#/$defs/positiveDecimalAmount',
      title: 'BUY size (buyAmount)',
      description: 'BUY only: the wxUSD budget to commit. Exactly one sizing field per leg.',
    },
    sellShares: {
      $ref: '#/$defs/positiveDecimalAmount',
      title: 'SELL size (sellShares)',
      description: 'SELL only: an exact share count to close. Exactly one sizing field per leg.',
    },
    sellFractionOfPosition: {
      $ref: '#/$defs/positionFraction',
      title: 'SELL a frozen fraction of the position',
      description:
        'SELL only, and the DEFAULT meaning of a percentage: the fraction is resolved to a share count AT CREATION, against an authoritative position read, and that count is what trades. Buying more of the same outcome afterwards does not enlarge this sale.',
    },
    dynamicSellFractionOfPosition: {
      $ref: '#/$defs/positionFraction',
      title: 'SELL a fraction re-read at the trigger',
      description:
        'SELL only: the fraction is applied to whatever is held WHEN THE STRATEGY TRIGGERS, so a position that grew in the meantime sells more shares than existed when this was armed. A distinct field, never a default, because the difference is a different trade.',
    },
    positionId: {
      title: 'Position id',
      description: 'Required for a SELL: the on-chain position being closed. Absent for a BUY.',
      type: 'string',
      minLength: 1,
      maxLength: 128,
    },
    maxSlippageBps: { $ref: '#/$defs/maxSlippageBps' },
    worstAcceptablePrice: {
      $ref: '#/$defs/probabilityPrice',
      title: 'Worst acceptable price',
      description:
        'An absolute bound applied at execution, on top of the slippage budget. Checked against a FRESH quote at the trigger, never against the price that was current when the strategy was armed.',
    },
  },
};

/**
 * When the strategy fires.
 *
 * `observe` is absent and must stay absent: which side of the book a target is
 * read against is derived from the leg's side — a BUY ceiling watches the ask, a
 * SELL floor watches the bid — and letting a caller state it would let them arm
 * a strategy that triggers off the wrong half of the market.
 */
const strategyTrigger: JsonSchema = {
  title: 'Strategy trigger',
  description:
    'IMMEDIATE runs at the next scheduler pass. PRICE waits for a market to reach targetPrice, which is watched by the Runner process — nothing server-side stores a target, so a Runner that is not running is a strategy that is not watching.',
  type: 'object',
  required: ['kind'],
  additionalProperties: false,
  properties: {
    kind: {
      title: 'Trigger kind',
      description: 'A closed set on this schema version.',
      type: 'string',
      enum: ['IMMEDIATE', 'PRICE'],
    },
    targetPrice: {
      $ref: '#/$defs/probabilityPrice',
      title: 'Target price',
      description: 'PRICE only. Crossed, not matched: a BUY fires at or below it, a SELL at or above.',
    },
    marketId: {
      $ref: '#/$defs/marketId',
      title: 'Watched market',
      description: 'PRICE only. Defaults to the single leg’s market when every leg agrees.',
    },
    outcomeId: {
      $ref: '#/$defs/outcomeId',
      title: 'Watched outcome',
      description: 'PRICE only. Defaults the same way the market does.',
    },
    side: {
      $ref: '#/$defs/side',
      title: 'Watched side',
      description:
        'PRICE only. Decides the direction of the comparison, and which half of the book is read.',
    },
  },
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
  cursor,
  searchText,
  idempotencyKey,
  orderIntent,
  ownerAddress,
  agentWallet,
  positionFraction,
  jobId,
  strategyLeg,
  strategyTrigger,
};
