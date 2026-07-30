/**
 * THE WIRE CONTRACT for /agent-api/v1. Every request and response shape an agent
 * sees, in one file with ZERO imports.
 *
 * ⚠️ VENDORED — the authoritative copy is
 * `apps/waterx/src/predict/agent-api/agent-api.contract.ts` in bucket-backend-mono,
 * where the controllers are typed against it so a shape change fails that build.
 * Keep the two byte-identical below the header; `tests/contract.test.ts` pins the
 * route map so a silent divergence in the part an SDK URL depends on is caught.
 *
 * That constraint is the whole point. The TypeScript SDK (a separate repo) needs
 * types that cannot silently drift from this backend, and for a TypeScript-only
 * client the strongest guarantee is not generated code — it is the SAME types,
 * compile-checked on both sides. Keeping this file self-contained means it can be
 * published as a tiny `@waterx/predict-agent-api-types` package (or vendored
 * verbatim) without dragging in Nest, knex, the Sui SDK, or the domain layer.
 *
 * RULES for editing:
 *   - No imports. Not even type-only ones. A single import makes this
 *     unpublishable and the guarantee evaporates.
 *   - Money, sizes and prices are decimal STRINGS, never numbers (spec §8.2).
 *     A JS number cannot hold 6-dp money exactly.
 *   - Adding an optional field is backwards-compatible. Renaming, removing, or
 *     changing the type of an existing one is a BREAKING change to deployed
 *     strategies — version the path, do not mutate this in place.
 *   - `null` means "known to be absent"; an absent optional key means "not
 *     applicable". They are different answers and agents branch on both.
 */

/** A decimal number as a string, e.g. `"12.5"`, `"0.6725"`. At most 6 dp. */
export type DecimalString = string;

/** A probability price as a decimal string in the inclusive range `0`–`1`. */
export type PriceString = string;

/** ISO-8601 UTC instant. */
export type Iso8601 = string;

/* ── Identity ────────────────────────────────────────────────────────────── */

/**
 * The on-chain binary leg. The Agent API identifies an outcome by its leg, which
 * is the same identifier the existing tx-build routes take.
 */
export type PredictOutcomeId = 'YES' | 'NO';

export type PredictSide = 'BUY' | 'SELL';

/* ── Auth ────────────────────────────────────────────────────────────────── */

/**
 * `message` must be exactly:
 *
 * ```
 * Sign in to Bucket Agent
 * Wallet: <walletAddress>
 * Timestamp: <timestamp>
 * ```
 *
 * The server re-derives the wallet and timestamp from the signed text and
 * compares them to these fields, so a captured signature cannot be replayed
 * against a different wallet. Signatures older than 5 minutes are rejected.
 */
export interface AgentAuthRequestBody {
  walletAddress: string;
  signature: string;
  message: string;
  /** Epoch milliseconds. */
  timestamp: number;
}

export interface AgentAuthResponseBody {
  token: string;
  /** Token lifetime in seconds. */
  expiresIn: number;
}

/* ── Quotes ──────────────────────────────────────────────────────────────── */

/** Exactly one field is set, decided by `side`. */
export interface PredictOrderSize {
  /** Committed wxUSD budget. BUY only. */
  buyAmount?: DecimalString;
  /** Shares to close. SELL only. */
  sellShares?: DecimalString;
}

export interface CreateQuoteRequestBody {
  marketId: string;
  outcomeId: PredictOutcomeId;
  side: PredictSide;
  size: PredictOrderSize;
}

/**
 * Liquidity band. `C` is the most conservative and is what a size-blind quote
 * reports — it never claims a tier it cannot evidence.
 */
export type PredictLiquidityTier = 'A' | 'B' | 'C';

/**
 * Known quote quality caveats. Treat this as an open set: a client must tolerate
 * flags it does not recognise rather than rejecting the quote.
 *
 * `TOP_OF_BOOK_ONLY` — priced from the best bid/ask with NO depth information.
 * `availableSize` and `expectedFillSize` are therefore null, and a large order
 * may fail to fill even though its price is protected.
 */
export type PredictQuoteQualityFlag = 'TOP_OF_BOOK_ONLY' | (string & {});

export interface PredictQuote {
  quoteId: string;
  marketId: string;
  outcomeId: PredictOutcomeId;
  side: PredictSide;
  /** Size-weighted execution price. */
  expectedPrice: PriceString;
  /** Null when depth is unknown. NOT zero — that would assert "nothing available". */
  expectedFillSize: DecimalString | null;
  availableSize: DecimalString | null;
  /** Null when fees are already embedded in `expectedPrice`. */
  feeAmount: DecimalString | null;
  liquidityTier: PredictLiquidityTier;
  qualityFlags: PredictQuoteQualityFlag[];
  asOf: Iso8601;
  /** Never extended. A quote past this is gone; re-quote rather than retry. */
  expiresAt: Iso8601;
  /** The on-chain market/leg this quote priced. */
  onchainMarketIdHex: string;
  onchainSelection: PredictOutcomeId;
}

/* ── Executions ──────────────────────────────────────────────────────────── */

export interface CreateExecutionRequestBody {
  accountId: string;
  marketId: string;
  outcomeId: PredictOutcomeId;
  side: PredictSide;
  size: PredictOrderSize;
  /** Required for SELL: which on-chain position to close. */
  positionId?: string;
  referenceQuoteId: string;
  /** `0 <= maxSlippageBps <= 9999`. 10000 is rejected — it removes all protection. */
  maxSlippageBps: number;
  /** Absolute bound. Applied only when stricter than the slippage budget. */
  worstAcceptablePrice?: PriceString;
  /** A business label. NOT a substitute for the `Idempotency-Key` header. */
  clientOrderId?: string;
  strategyId?: string;
}

/**
 * Execution lifecycle (spec §12).
 *
 * `PENDING_FILL` is the long-lived on-chain wait — an order exists and a keeper
 * may still fill it. It is NOT finalized by a clock.
 *
 * `CANCELLED` means the chain cancelled an order that was successfully submitted
 * (expiry, a keeper unable to fill inside the price cap, or a self-cancel). It is
 * a different fact from `REJECTED`, which is a decision WaterX made.
 */
export type PredictExecutionStatus =
  | 'RECEIVED'
  | 'RISK_RESERVED'
  | 'AWAITING_SIGNATURE'
  | 'SUBMITTING'
  | 'SUBMITTED'
  | 'PENDING_FILL'
  | 'FILLED'
  | 'REJECTED'
  | 'CANCELLED'
  | 'EXPIRED';

export type PredictTerminalExecutionStatus = 'FILLED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED';

/** Where a rejection was decided. */
export type PredictRejectionStage = 'PRE_SUBMISSION' | 'CHAIN' | 'FILL';

/**
 * 201 response. `sponsoredTransactionBytes` is base64 and must be signed by the
 * AUTHENTICATED agent wallet — WaterX sponsors gas but never signs.
 */
export interface CreateExecutionResponseBody {
  executionId: string;
  status: PredictExecutionStatus;
  sponsoredTransactionBytes: string;
  sponsoredDigest: string;
  /** Sign and submit before this instant or the execution expires. */
  signatureExpiresAt: Iso8601;
  referenceQuoteId: string;
  submissionQuoteId: string;
  /**
   * The price the chain will actually enforce. Never looser than what the
   * request asked for; it may be STRICTER because the contract's price
   * granularity is coarser than the wire format's.
   */
  enforcedWorstPrice: PriceString;
}

export interface SubmitExecutionRequestBody {
  signature: string;
}

/**
 * What the chain actually settled, once it has.
 *
 * Absent until the reconciler observes the fill — an order that is merely
 * SUBMITTED has no fill, and inventing zeroes for one would let a strategy book a
 * trade that has not happened.
 */
export interface PredictExecutionFill {
  /** Cost for a BUY, proceeds for a SELL. */
  filledAmount: DecimalString;
  /** Null when the chain event carried no share count. */
  filledShares: DecimalString | null;
  /** `filledAmount / filledShares`. Null when shares are unknown or zero. */
  avgFillPrice: PriceString | null;
  /**
   * Always null today, and NOT zero: the broker's published price is already
   * fee-adjusted, so no separately observable fee exists (spec §19.1 forbids
   * putting an estimate here).
   */
  actualFee: DecimalString | null;
  /** The KEEPER's fill transaction — NOT the agent's submit digest. */
  txDigest: string | null;
  filledAt: Iso8601;
}

/**
 * 202 response. A submitted predict order is NOT a completed fill — the contract
 * is a two-stage broker model and a keeper fills asynchronously.
 */
export interface SubmitExecutionResponseBody {
  executionId: string;
  status: PredictExecutionStatus;
  /** The EXECUTED on-chain digest, which may differ from `sponsoredDigest`. */
  transactionDigest?: string;
  /** Present once the fill has been observed on chain. */
  fill?: PredictExecutionFill;
  /**
   * Spendable API allowance remaining after this execution settled.
   *
   * Present only on a TERMINAL read: while an order is in flight its reservation
   * is held but not yet spent, so a figure reported then would be neither the
   * before nor the after and a strategy sizing its next order off it would be
   * wrong in whichever direction the fill lands.
   */
  remainingAllowance?: DecimalString;
}

/** One execution, as returned by the history and single-read endpoints. */
export interface PredictExecutionSummary {
  executionId: string;
  status: PredictExecutionStatus;
  side: PredictSide;
  marketId: string;
  outcomeId: PredictOutcomeId;
  /** Committed budget for a BUY, shares for a SELL. */
  size: DecimalString;
  strategyId: string | null;
  clientOrderId: string | null;
  enforcedWorstPrice: PriceString | null;
  transactionDigest: string | null;
  positionId: string | null;
  /** Present once the fill has been observed on chain. */
  fill?: PredictExecutionFill;
  createdAt: Iso8601;
  terminalAt: Iso8601 | null;
}

export interface ListExecutionsResponseBody {
  executions: PredictExecutionSummary[];
}

/* ── Positions ───────────────────────────────────────────────────────────── */

export interface PredictPositionSummary {
  positionId: string;
  marketId: string;
  outcomeId: PredictOutcomeId;
  strategyId: string | null;
  /** What the fill cost. */
  originalCost: DecimalString;
  /** Still-deployed cost. Below `originalCost` after a partial exit. */
  remainingCost: DecimalString;
  /**
   * Shares still held.
   *
   * Null when the settling chain event carried no share count. Null is NOT zero:
   * zero would say the position is empty, which would read as a total loss.
   */
  shares: DecimalString | null;
  /** `remainingCost / shares`. Null when shares are unknown or zero. */
  avgEntryPrice: PriceString | null;
  /**
   * The live SELL-side price this valuation used — what the position could be
   * exited at, not the mid or the ask. Null when there is no fresh quote.
   */
  currentPrice: PriceString | null;
  /**
   * `shares × currentPrice − remainingCost`. Signed: a losing position is
   * negative.
   *
   * Null — never 0 — when the share count or the sell quote is unknown (spec
   * §19.2). Zero would tell a strategy the position is exactly break-even, and a
   * stop-loss reading that would sit on its hands through a crash.
   */
  unrealizedPnl: DecimalString | null;
  openedAt: Iso8601;
}

export interface ListPositionsResponseBody {
  positions: PredictPositionSummary[];
}

/* ── Allowance ───────────────────────────────────────────────────────────── */

/**
 * Spendable capacity (spec §14.3).
 *
 * `apiAllowance` is a WaterX API policy, NOT a protocol guarantee: a delegated
 * key can bypass it by submitting a transaction directly to Sui. On-chain
 * delegation revocation and the contract's price guards are the authoritative
 * controls.
 *
 * `effectiveBuyCapacity = min(apiAllowance.available, accountSpendableBalance)`.
 * The two are reported separately because a direct-chain spend moves one without
 * the other.
 */
export interface PredictAllowanceResponseBody {
  apiAllowance: {
    limit: DecimalString;
    reserved: DecimalString;
    deployed: DecimalString;
    available: DecimalString;
  };
  accountSpendableBalance: DecimalString;
  effectiveBuyCapacity: DecimalString;
}

/* ── Owner controls ──────────────────────────────────────────────────────── */

/**
 * Owner-authenticated risk profile write. FULL REPLACEMENT: an omitted optional
 * limit is CLEARED, not retained.
 */
export interface UpsertRiskProfileRequestBody {
  allowanceLimit: DecimalString;
  maxOrderAmount?: DecimalString;
  maxSlippageBps?: number;
  maxOrdersPerHour?: number;
  maxNotionalPerHour?: DecimalString;
  maxInFlightExecutions?: number;
  /** Kill switch: blocks new executions without altering the limits. */
  isSuspended?: boolean;
}

export interface RiskProfileResponseBody {
  accountId: string;
  agentWallet: string;
  allowanceLimit: DecimalString;
  maxOrderAmount: DecimalString | null;
  maxSlippageBps: number | null;
  maxOrdersPerHour: number | null;
  maxNotionalPerHour: DecimalString | null;
  maxInFlightExecutions: number | null;
  isSuspended: boolean;
  /** Increments on every owner write, so an execution traces to its policy. */
  policyVersion: number;
  updatedAt: Iso8601;
}

export interface ListRiskProfilesResponseBody {
  profiles: RiskProfileResponseBody[];
}

/* ── Errors ──────────────────────────────────────────────────────────────── */

/**
 * The stable symbolic codes an agent may branch on (spec §20). Numeric WaterX
 * error codes and Move aborts map INTO these; the numbers are not the contract.
 */
export type PredictAgentErrorCode =
  | 'DELEGATION_REVOKED'
  | 'DELEGATION_PERMISSION_DENIED'
  | 'INSUFFICIENT_ALLOWANCE'
  | 'INSUFFICIENT_ACCOUNT_BALANCE'
  | 'QUOTE_EXPIRED'
  | 'QUOTE_UNAVAILABLE'
  | 'SLIPPAGE_EXCEEDED'
  | 'MARKET_CLOSED'
  | 'POSITION_NOT_FOUND'
  | 'POSITION_CLOSE_IN_FLIGHT'
  | 'RATE_LIMITED'
  | 'RISK_LIMIT_EXCEEDED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'SIGNATURE_INVALID'
  | 'SIGNATURE_EXPIRED'
  | 'SPONSOR_UNAVAILABLE'
  | 'CHAIN_REJECTED'
  | 'EXECUTION_TIMEOUT'
  | 'RECONCILIATION_REQUIRED'
  | 'UNAUTHENTICATED'
  | 'INVALID_REQUEST';

/**
 * Error envelope. FLAT and NOT wrapped in the app-wide `{ success, data }` shape
 * — this is a separately versioned API whose error body is part of the contract.
 *
 * `retryable` is a property of the CODE, not of the moment: an SDK retry policy
 * can read it without a lookup table.
 */
export interface PredictAgentErrorBody {
  error: {
    code: PredictAgentErrorCode;
    message: string;
    retryable: boolean;
    executionId?: string;
    details?: Record<string, unknown>;
  };
}

/** Codes for which retrying the identical intent can succeed. */
export const RETRYABLE_PREDICT_AGENT_ERROR_CODES = [
  'QUOTE_EXPIRED',
  'QUOTE_UNAVAILABLE',
  'SLIPPAGE_EXCEEDED',
  'RATE_LIMITED',
  'SPONSOR_UNAVAILABLE',
  'EXECUTION_TIMEOUT',
] as const satisfies readonly PredictAgentErrorCode[];

/* ── Private execution stream ────────────────────────────────────────────── */

/**
 * Socket.IO namespace for the authenticated agent stream. SEPARATE from the
 * browser-facing gateway on purpose: this one authenticates at handshake and an
 * agent is joined to its own room automatically, so there is no subscribe message
 * to forge and no room name to guess.
 */
export const PREDICT_AGENT_STREAM_NAMESPACE = '/agent-api/v1/predict';

/** Event name carrying execution state changes. */
export const PREDICT_EXECUTION_STREAM = 'predict.executions.v1';

/**
 * One execution state change.
 *
 * `cursor` is monotonically increasing PER AGENT. Persist the last one you
 * processed and send it as `handshake.auth.cursor` on reconnect to receive
 * everything missed — the socket is a convenience, the server's log is the source
 * of truth, and a REST read of the execution is always authoritative.
 */
export interface PredictExecutionFrame {
  stream: typeof PREDICT_EXECUTION_STREAM;
  /** Opaque, ordered, per-agent. Compare only for equality and ordering. */
  cursor: string;
  executionId: string;
  status: PredictExecutionStatus;
  errorCode?: PredictAgentErrorCode;
  occurredAt: Iso8601;
}

/**
 * Sent once after a successful handshake, before any live frame.
 *
 * `replayed` is how many missed frames were delivered from the durable log.
 * `gap: true` means the requested cursor was too old to serve — the client MUST
 * reconcile over REST rather than assume it is caught up.
 */
export interface PredictStreamReadyFrame {
  stream: typeof PREDICT_EXECUTION_STREAM;
  agentWallet: string;
  cursor: string;
  replayed: number;
  gap: boolean;
}

export const PREDICT_STREAM_READY = 'predict.stream.ready';

/* ── Markets ─────────────────────────────────────────────────────────────── */

/**
 * Where a market sits in its round's life (spec §8.3).
 *
 * `CLOSED` and `RESOLVED` are both untradeable; they differ in whether the payout
 * is known yet. Only `PREGAME` and `IN_PLAY` can ever quote.
 */
export type PredictMarketStatus = 'PREGAME' | 'IN_PLAY' | 'CLOSED' | 'RESOLVED';

/**
 * One leg of a binary market.
 *
 * All three prices are INDICATIVE — they come from the same top-of-book cache the
 * FE reads, carry no depth, and are not committable. To trade, mint a quote via
 * `POST /quotes` and pass its id; only that path produces a price an execution
 * will honour. `null` means "we do not know", never "zero".
 */
export interface PredictMarketOutcome {
  outcomeId: PredictOutcomeId;
  name: string;
  /** Mid-market, derived from bid/ask. Null when either side is missing. */
  impliedProbability: PriceString | null;
  indicativeBid: PriceString | null;
  indicativeAsk: PriceString | null;
}

/**
 * The agent-facing market projection.
 *
 * `marketId` IS the on-chain market id — the same identifier `/quotes` and
 * `/executions` take, so a market from this list can be traded without a second
 * lookup.
 *
 * Two fields spec §8.3 lists are deliberately ABSENT rather than faked:
 * `priorityScore` is browse/trending product policy we retune freely, and
 * publishing it would invite strategies to depend on a ranking that is not a
 * trading signal; and the nested `event` object is reduced to `eventId`, which is
 * enough to group multi-outcome boards without this API taking on the event
 * catalog's read path.
 */
export interface PredictAgentMarket {
  marketId: string;
  title: string;
  category: string;
  status: PredictMarketStatus;
  /** False whenever an execution would be refused; `tradeabilityReason` says why. */
  tradeable: boolean;
  tradeabilityReason?: string;
  /** Groups the legs of a multi-outcome board. Null for standalone markets. */
  eventId: string | null;
  outcomes: PredictMarketOutcome[];
  /** When the round stops accepting orders. Null when the end is not scheduled. */
  closesAt: Iso8601 | null;
  updatedAt: Iso8601;
}

export interface ListMarketsResponseBody {
  markets: PredictAgentMarket[];
}

export interface GetMarketResponseBody {
  market: PredictAgentMarket;
}

/* ── Fills ───────────────────────────────────────────────────────────────── */

/**
 * A confirmed fill, recorded when the reconciler observed the chain event that
 * settled an execution (spec §19.1).
 *
 * Scope: fills this API produced. Direct-chain activity by the same delegated key
 * is NOT included — it never had an execution row, and inventing one would make
 * allowance accounting disagree with itself. That is a real gap for an agent
 * reconstructing total position history, and it is stated here rather than hidden
 * behind a list that merely looks complete.
 */
export interface PredictFill {
  executionId: string;
  orderId: string | null;
  positionId: string | null;
  marketId: string;
  outcomeId: PredictOutcomeId;
  side: PredictSide;
  /** What the agent asked for, for comparison against what filled. */
  requestedSize: PredictOrderSize;
  /** Cost for a BUY, proceeds for a SELL. */
  filledAmount: DecimalString;
  /** Null when the chain event carried no share count. */
  filledShares: DecimalString | null;
  /**
   * `filledAmount / filledShares`, computed on read so it can never disagree with
   * the two numbers it derives from. Null when shares are unknown or zero.
   */
  avgFillPrice: PriceString | null;
  /**
   * Always null today, and NOT zero: the broker's published price is already
   * fee-adjusted, so there is no separately observable fee to report. Zero would
   * assert a free trade (spec §19.1 forbids estimated fees here).
   */
  actualFee: DecimalString | null;
  /** The quote the agent priced against, and the price it carried. */
  referenceQuoteId: string;
  referenceQuotePrice: PriceString;
  /** The keeper's fill transaction — NOT the agent's submit digest. */
  txDigest: string | null;
  strategyId: string | null;
  filledAt: Iso8601;
}

export interface ListFillsResponseBody {
  fills: PredictFill[];
}

/* ── Routes ──────────────────────────────────────────────────────────────── */

/**
 * Every path in this API version, as a single literal map.
 *
 * An SDK builds its URLs from here rather than string-concatenating in each
 * method, so a path change is one edit and a route-drift test can compare this
 * map against the routes Nest actually registered.
 */
export const PREDICT_AGENT_API_ROUTES = {
  auth: 'agent-api/v1/auth',
  markets: 'agent-api/v1/predict/markets',
  market: 'agent-api/v1/predict/markets/:marketId',
  quotes: 'agent-api/v1/predict/quotes',
  executions: 'agent-api/v1/predict/executions',
  submitExecution: 'agent-api/v1/predict/executions/:executionId/submit',
  getExecution: 'agent-api/v1/predict/executions/:executionId',
  allowance: 'agent-api/v1/predict/accounts/:accountId/allowance',
  positions: 'agent-api/v1/predict/accounts/:accountId/positions',
  fills: 'agent-api/v1/predict/accounts/:accountId/fills',
  listExecutions: 'agent-api/v1/predict/accounts/:accountId/executions',
  riskProfile: 'agent-api/v1/predict/accounts/:accountId/agents/:agentWallet/risk-profile',
  listRiskProfiles: 'agent-api/v1/predict/accounts/agents/risk-profiles',
} as const;

/** Header carrying the agent-generated idempotency token on execution creation. */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
