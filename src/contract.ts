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
 * 202 response. A submitted predict order is NOT a completed fill — the contract
 * is a two-stage broker model and a keeper fills asynchronously.
 */
export interface SubmitExecutionResponseBody {
  executionId: string;
  status: PredictExecutionStatus;
  /** The EXECUTED on-chain digest, which may differ from `sponsoredDigest`. */
  transactionDigest?: string;
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
  quotes: 'agent-api/v1/predict/quotes',
  executions: 'agent-api/v1/predict/executions',
  submitExecution: 'agent-api/v1/predict/executions/:executionId/submit',
  getExecution: 'agent-api/v1/predict/executions/:executionId',
  allowance: 'agent-api/v1/predict/accounts/:accountId/allowance',
  positions: 'agent-api/v1/predict/accounts/:accountId/positions',
  listExecutions: 'agent-api/v1/predict/accounts/:accountId/executions',
  riskProfile: 'agent-api/v1/predict/accounts/:accountId/agents/:agentWallet/risk-profile',
  listRiskProfiles: 'agent-api/v1/predict/accounts/agents/risk-profiles',
} as const;

/** Header carrying the agent-generated idempotency token on execution creation. */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
