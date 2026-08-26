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
 *
 * `INDICATIVE_ONLY` — this price is NOT committable. Only a quote minted through
 * `POST /quotes` can be executed; anything carrying this flag (every quote-stream
 * frame) is a decision input, never an order price.
 *
 * `POLLED_UPSTREAM` — the value reached this server by polling an upstream cache,
 * not by an upstream push. Its freshness is bounded by `freshness.pollIntervalMs`
 * plus the publisher's own cadence; see `PredictQuoteFreshness`.
 *
 * `STALE` — no value fresher than `freshness.staleAfterMs` exists. Prices are
 * null and nothing may be inferred from their absence except "we do not know".
 */
export type PredictQuoteQualityFlag =
  'TOP_OF_BOOK_ONLY' | 'INDICATIVE_ONLY' | 'POLLED_UPSTREAM' | 'STALE' | (string & {});

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

/* ── Paging ──────────────────────────────────────────────────────────────── */

/**
 * An opaque page cursor. Base64url text whose contents are this server's
 * business — a client must never parse, construct, or edit one.
 *
 * It is a KEYSET cursor, not an offset. It names the exact row the previous page
 * ended on, and the next page is everything ordered strictly after that row. An
 * offset would silently skip rows whenever anything landed at the head between
 * two requests, and an agent reconstructing its own order history would end up
 * with a gap it has no way to detect.
 */
export type PredictPageCursor = string;

/**
 * Paging for the agent-scoped history reads.
 *
 * The two fields compose: `limit` sizes a page, `cursor` says where it starts,
 * and `limit` alone still means "the newest page".
 *
 * A cursor this server cannot decode — truncated, edited, or minted for a
 * DIFFERENT list — is REJECTED with `INVALID_REQUEST`. It is never ignored:
 * ignoring it restarts the page at the head, and a caller walking its history
 * would append the newest rows a second time and double-count every fill in them.
 */
export interface PredictAgentListQuery {
  /** Rows per page. The server's own default and maximum still apply. */
  limit?: number;
  /** The `nextCursor` of the previous page. Omit for the first page. */
  cursor?: PredictPageCursor;
}

export type ListExecutionsQuery = PredictAgentListQuery;
export type ListFillsQuery = PredictAgentListQuery;
export type ListPositionsQuery = PredictAgentListQuery;

/**
 * The paging half of a list response. Three-valued on purpose:
 *
 *   - a STRING is the cursor to pass back for the next page;
 *   - `null` means EXHAUSTED. The server looked one row past this page and found
 *     nothing, so this is the end of the history — not merely the end of a page;
 *   - ABSENT means the deployment predates keyset paging and did not answer the
 *     question at all. That is UNKNOWN, and reading it as exhausted would end a
 *     reconstruction early while claiming it was complete.
 *
 * A full page is not evidence that more exists, and a short one is not evidence
 * that it does not — only this field answers that.
 */
export interface PredictPagedListResponse {
  nextCursor?: PredictPageCursor | null;
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

export interface ListExecutionsResponseBody extends PredictPagedListResponse {
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

export interface ListPositionsResponseBody extends PredictPagedListResponse {
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

/* ── Effective account facts ─────────────────────────────────────────────── */

/**
 * The owner-configured limits an agent is actually trading under, as an
 * AGENT-authenticated READ.
 *
 * Same numbers as the owner's `RiskProfileResponseBody`, minus nothing and plus
 * nothing — but reachable with an agent token, which the owner route is not. An
 * agent may see its mandate; it can never write one (spec §7.3), and no field
 * here is settable from this side.
 */
export interface PredictEffectiveRiskLimits {
  allowanceLimit: DecimalString;
  maxOrderAmount: DecimalString | null;
  maxSlippageBps: number | null;
  maxOrdersPerHour: number | null;
  maxNotionalPerHour: DecimalString | null;
  maxInFlightExecutions: number | null;
  isSuspended: boolean;
  /** Increments on every owner write, so a decision traces to its exact policy. */
  policyVersion: number;
  updatedAt: Iso8601;
}

/**
 * What this agent has already consumed against the windowed limits.
 *
 * The window is rolling and measured back from `asOf`, not a wall-clock bucket —
 * the write path measures it the same way, and a bucket boundary would let an
 * hourly budget be spent twice in two minutes by straddling it.
 */
export interface PredictAgentUsageWindow {
  windowSeconds: number;
  ordersInWindow: number;
  /** Committed BUY notional in the window. A SELL deploys nothing. */
  notionalInWindow: DecimalString;
  inFlightExecutions: number;
}

/**
 * Why the local risk gate would refuse a new order right now. A CLOSED set —
 * unlike `tradeabilityReason`, this is meant to be branched on.
 *
 * These are WaterX policy blocks only. Delegation is reported separately because
 * it is an on-chain authorization and answers with different authority.
 */
export type PredictTradingBlocker =
  | 'NO_RISK_PROFILE'
  | 'SUSPENDED'
  | 'ORDERS_PER_HOUR_EXHAUSTED'
  | 'NOTIONAL_PER_HOUR_EXHAUSTED'
  | 'IN_FLIGHT_LIMIT_REACHED'
  | 'NO_BUY_CAPACITY';

/**
 * Current on-chain delegation, read fresh.
 *
 * `null` on a permission means THE CHAIN READ FAILED — it does not mean denied.
 * Collapsing the two would tell a healthy strategy it had been revoked and make
 * it tear itself down over an RPC blip.
 */
export interface PredictDelegationFacts {
  mayPlaceOrder: boolean | null;
  mayRequestClose: boolean | null;
  checkedAt: Iso8601;
}

/**
 * Everything an agent needs to size its next order without guessing, in one
 * read: the mandate, the allowance, the window it has already used, the
 * delegation behind it, and the reasons a write would be refused.
 *
 * `blockers` being empty does NOT promise a fill. It says the limits published
 * here do not currently refuse an order; the market must still be tradeable, the
 * quote must still be executable, and the chain still decides last.
 */
export interface PredictEffectiveLimitsResponseBody {
  accountId: string;
  agentWallet: string;
  /** Null when no owner has granted this agent a mandate. Absence is denial. */
  limits: PredictEffectiveRiskLimits | null;
  /** Null exactly when `limits` is null — no mandate means no allowance ledger. */
  allowance: PredictAllowanceResponseBody | null;
  usage: PredictAgentUsageWindow;
  delegation: PredictDelegationFacts;
  blockers: PredictTradingBlocker[];
  asOf: Iso8601;
}

/**
 * One account this agent has been onboarded onto.
 *
 * WHY THIS EXISTS: every other account-scoped route takes an `accountId` the
 * agent cannot discover, because the id belongs to the owner. Without this the
 * first step of every integration is a person copying a 66-character hex string
 * out of a web UI into a config file — friction with no security value, since the
 * mandate and the on-chain delegation are what authorize the agent and both are
 * re-checked on every write.
 *
 * The rows come from the OWNER'S OWN WRITES: an account appears only because an
 * owner deliberately configured this agent on it.
 */
export interface PredictAgentAccountSummary {
  accountId: string;
  /** The owner who granted the mandate. */
  ownerAddress: string;
  /** The owner's kill switch. A suspended mandate still lists — silence would read as revoked. */
  isSuspended: boolean;
  /** Increments on every owner write, so a client can detect a policy change. */
  policyVersion: number;
  /**
   * On-chain delegation for THIS account, reported beside the mandate rather than
   * folded into it: the two are separate grants that fail independently, and an
   * owner who wrote a profile but never signed the delegation is the normal
   * half-finished onboarding state. `null` means the chain read FAILED.
   */
  delegation: PredictDelegationFacts;
  grantedAt: Iso8601;
  updatedAt: Iso8601;
}

/**
 * Every account this agent may act on, newest mandate first.
 *
 * An empty list is a complete answer, not an error: no owner has onboarded this
 * agent yet.
 */
export interface ListAgentAccountsResponseBody {
  accounts: PredictAgentAccountSummary[];
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

/* ── Private quote stream ────────────────────────────────────────────────── */

/**
 * Live indicative prices, on the SAME authenticated namespace as the execution
 * stream. One socket, one handshake, two feeds.
 *
 * HOW THIS DIFFERS FROM THE EXECUTION STREAM, and why the difference is in the
 * types rather than only in prose:
 *
 *   - The execution stream is an EVENT LOG. It has a durable outbox, a per-agent
 *     cursor, and a genuine replay window, so a reconnect can be told exactly what
 *     it missed.
 *   - This is a STATE feed. Nothing durable is written per price tick, so there is
 *     NO replay: whatever moved while a client was away is unrecoverable. Recovery
 *     is the SNAPSHOT, which is why every (re)subscribe emits one.
 *
 * Consequently `seq` is monotonic per (connection, topic), starting at `1` for a
 * newly subscribed topic and CONTINUING across a re-subscribe on the same
 * connection. It exists to detect frames dropped ON a live connection — not to
 * address history, and it is meaningless on any other connection. Do not persist
 * it; persist nothing here at all. A trading decision still needs `POST /quotes`
 * (executable) and a REST read (authoritative).
 */
export const PREDICT_QUOTE_STREAM = 'predict.quotes.v1';

/** Client → server. Payload: `PredictQuoteSubscribeMessage`. */
export const PREDICT_QUOTE_SUBSCRIBE = 'predict.quotes.subscribe';

/** Client → server. Payload: `PredictQuoteSubscribeMessage`. */
export const PREDICT_QUOTE_UNSUBSCRIBE = 'predict.quotes.unsubscribe';

/** Server → client, answering either of the two above. */
export const PREDICT_QUOTE_SUBSCRIPTION = 'predict.quotes.subscription';

/** Server → client, on a fixed interval whether or not prices moved. */
export const PREDICT_QUOTE_HEARTBEAT = 'predict.quotes.heartbeat';

/**
 * Topics one connection may hold. A quote topic is CLIENT-named (unlike the
 * execution room, which the server chooses), so it needs a cap: each topic costs
 * a cache read and a comparison on every tick, for every subscriber.
 */
export const PREDICT_QUOTE_STREAM_MAX_TOPICS = 32;

/** Subscribe/unsubscribe messages allowed per connection per rolling minute. */
export const PREDICT_QUOTE_STREAM_MAX_SUBSCRIBE_RATE = 60;

/** Heartbeat cadence. A client that misses two in a row should reconnect. */
export const PREDICT_QUOTE_STREAM_HEARTBEAT_MS = 15_000;

/** What a client names to receive prices. */
export interface PredictQuoteTopic {
  marketId: string;
  outcomeId: PredictOutcomeId;
}

export interface PredictQuoteSubscribeMessage {
  topics: PredictQuoteTopic[];
  /**
   * Set on a RESUME — a reconnect for topics you were already watching. It makes
   * the answering snapshot carry `gap: true`, because this feed cannot prove what
   * you missed. Omit it on a first subscribe to distinguish "new" from "resumed".
   */
  resume?: boolean;
}

/**
 * Why one topic was not accepted.
 *
 * `MARKET_CLOSED` and `NOT_QUOTABLE` differ: the first is terminal for the round,
 * the second is temporary (no live book). A strategy pauses on the second and
 * stops on the first — never the other way round.
 */
export type PredictQuoteRejectionReason =
  | 'INVALID_REQUEST'
  | 'UNKNOWN_MARKET'
  | 'MARKET_CLOSED'
  | 'NOT_QUOTABLE'
  | 'SUBSCRIPTION_LIMIT'
  | 'RATE_LIMITED';

/**
 * The topic fields are ECHOED from the request rather than typed as a valid
 * topic: a rejection must be able to name a request that was not a valid topic in
 * the first place. `null` means the field was missing or unreadable.
 */
export interface PredictQuoteRejection {
  marketId: string | null;
  outcomeId: PredictOutcomeId | null;
  reason: PredictQuoteRejectionReason;
}

/**
 * The answer to a subscribe/unsubscribe. Per-topic, never all-or-nothing: one
 * closed market in a batch must not silently drop the other thirty-one.
 *
 * On an UNSUBSCRIBE, `accepted` lists every well-formed topic — held or not.
 * Unsubscribing is idempotent, and a client retrying after a disconnect should
 * not have to distinguish "removed" from "was never there".
 */
export interface PredictQuoteSubscriptionFrame {
  stream: typeof PREDICT_QUOTE_STREAM;
  accepted: PredictQuoteTopic[];
  rejected: PredictQuoteRejection[];
  /** Topics held on this connection AFTER applying the message. */
  subscribed: number;
  limit: typeof PREDICT_QUOTE_STREAM_MAX_TOPICS;
}

/**
 * Everything needed to judge whether this price is worth acting on — stated as
 * facts, not as a latency claim.
 *
 * WaterX does not receive an upstream push. A publisher writes prices into a
 * cache and this server re-reads that cache every `pollIntervalMs`, so a frame
 * can never be fresher than one poll interval plus the publisher's own cadence.
 * `sourceAgeMs` is the only end-to-end number, and it is null when the publisher
 * stamped no origin time — absent, not zero.
 */
export interface PredictQuoteFreshness {
  /** When this server read the value. Null when there is no value at all. */
  observedAt: Iso8601 | null;
  /** When the upstream publisher stamped it. Null when it published no stamp. */
  sourceTimestamp: Iso8601 | null;
  /** `emittedAt - sourceTimestamp`. Null exactly when `sourceTimestamp` is. */
  sourceAgeMs: number | null;
  emittedAt: Iso8601;
  /** Upstream re-read cadence. A frame cannot be fresher than this. */
  pollIntervalMs: number;
  /** A value older than this reads as unavailable, never as its last price. */
  staleAfterMs: number;
  /** True ⇒ prices are null and `qualityFlags` carries `STALE`. */
  stale: boolean;
}

/**
 * One price update for one topic.
 *
 * Both prices are INDICATIVE and carry `INDICATIVE_ONLY`. They are the same
 * top-of-book values the market catalog reports, delivered as they change instead
 * of when polled — they are a trigger, never an execution price. After a target is
 * observed, mint a fresh quote and re-check the target before ordering.
 */
export interface PredictQuoteStreamFrame extends PredictQuoteTopic {
  stream: typeof PREDICT_QUOTE_STREAM;
  /**
   * `SNAPSHOT` is the full current state, emitted on every subscribe. `UPDATE` is
   * emitted only when the state changed.
   */
  kind: 'SNAPSHOT' | 'UPDATE';
  /** Monotonic per (connection, topic), from `1`. Never an address into history. */
  seq: string;
  /**
   * Only ever true on a `SNAPSHOT` answering a `resume`. It means: you were away,
   * this feed keeps no log, so treat this snapshot as your whole recovery.
   */
  gap: boolean;
  /** Null when unknown — never `0`, which would assert a real price of zero. */
  indicativeBid: PriceString | null;
  indicativeAsk: PriceString | null;
  /** Mid-market. Null when either side is missing. */
  impliedProbability: PriceString | null;
  qualityFlags: PredictQuoteQualityFlag[];
  freshness: PredictQuoteFreshness;
}

/**
 * Proof the feed is alive when nothing is moving.
 *
 * Without it a quiet market and a dead socket look identical, and an unattended
 * strategy cannot tell "no one is trading" from "I stopped receiving prices".
 * `topics` reports the server's `seq` per subscription so a client can detect a
 * frame it never received.
 */
export interface PredictQuoteHeartbeatFrame {
  stream: typeof PREDICT_QUOTE_STREAM;
  serverTime: Iso8601;
  intervalMs: typeof PREDICT_QUOTE_STREAM_HEARTBEAT_MS;
  topics: (PredictQuoteTopic & { seq: string; stale: boolean })[];
}

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
 * What is being predicted, for grounding a judgement.
 *
 * Every field except `eventId` is best-effort: it is derived from the market's
 * own structured display, so a sport match carries its league and teams while a
 * generic binary proposition carries neither. An absent key means "this family
 * does not have that", not "we failed to load it".
 */
export interface PredictMarketEvent {
  /** Groups the legs of a multi-outcome board. Null for standalone markets. */
  eventId: string | null;
  /** e.g. `NBA`. Present for sport families only. */
  league?: string;
  /** e.g. the two teams. Present for sport families only. */
  participants?: string[];
  /** When the round opens — kickoff, for a match. */
  startsAt?: Iso8601;
}

/**
 * The agent-facing market projection.
 *
 * `marketId` IS the on-chain market id — the same identifier `/quotes` and
 * `/executions` take, so a market from this list can be traded without a second
 * lookup.
 *
 * `priorityScore` from spec §8.3 is still absent. Publishing it correctly means
 * reusing the feed's own scorer rather than re-deriving it here, and that needs a
 * module extraction (see the backlog) — a second implementation of the same
 * number is precisely the drift this codebase avoids elsewhere. Note when it does
 * land that it is a ranking tuned for HUMAN attention (it includes a "fun" bonus
 * and a category boost), not a trading signal.
 */
export interface PredictAgentMarket {
  marketId: string;
  title: string;
  category: string;
  status: PredictMarketStatus;
  /** False whenever an execution would be refused; `tradeabilityReason` says why. */
  tradeable: boolean;
  tradeabilityReason?: string;
  event: PredictMarketEvent;
  outcomes: PredictMarketOutcome[];
  /**
   * The normalized handles this market answers to under `?search=`.
   *
   * Derived from the market's own structured display — never hand-curated and
   * never a synonym dictionary — so the set is reproducible from the catalog
   * alone. Publishing it means an agent can see EXACTLY what the server will
   * match on instead of guessing at a name and then guessing at an id, which is
   * how a strategy ends up trading the wrong event.
   */
  aliases: string[];
  /** When the round stops accepting orders. Null when the end is not scheduled. */
  closesAt: Iso8601 | null;
  updatedAt: Iso8601;
}

/**
 * How a `?search=` narrowed to a market, if it did.
 *
 * `AMBIGUOUS` is a real answer, not a failure: the caller asked for something
 * that names more than one market, and picking one for them is precisely the
 * hallucinated identity this API refuses to produce. The candidates are in
 * `markets`, so an agent can disambiguate and ask again.
 */
export type PredictMarketResolutionStatus = 'RESOLVED' | 'AMBIGUOUS' | 'NOT_FOUND';

export interface PredictMarketResolution {
  status: PredictMarketResolutionStatus;
  /** The search text after normalization — exactly what was matched against. */
  normalizedQuery: string;
  /** Set ONLY when `status` is `RESOLVED`. Null otherwise; never a best guess. */
  marketId: string | null;
  /** Markets that matched, counted BEFORE `limit` truncated the page. */
  matchCount: number;
}

/**
 * Narrowing for the catalog list. Every filter is optional and they AND together.
 *
 * `status` and `tradeable` are applied AFTER the page is assembled, because both
 * are derived from the round clock rather than stored — so a filtered page can
 * be shorter than `limit` without meaning the catalog is exhausted. Ask for more
 * than you need when filtering on them.
 *
 * DELIBERATELY NO `cursor`, unlike the account history reads. Those page over
 * stored rows with an immutable sort key; this page is projected in memory and
 * ordered partly by facts derived from the round clock, so a key that identified
 * a row now can order differently a minute later — a cursor over it would look
 * exactly like the keyset guarantee while skipping markets as rounds advance.
 * Narrow the catalog with `category`, `status`, `updatedAfter` or `search`
 * instead; it is bounded, and history is the thing that grows without limit.
 */
export interface ListMarketsQuery {
  limit?: number;
  category?: string;
  status?: PredictMarketStatus;
  tradeable?: boolean;
  /** ISO-8601. Only markets whose definition changed after this instant. */
  updatedAfter?: Iso8601;
  /**
   * Free text, resolved SERVER-SIDE against `aliases`.
   *
   * Matching is deterministic and purely lexical: the text is normalized, split
   * into tokens, and a market matches when EVERY token is a prefix of one of its
   * alias tokens. There is no fuzzy distance, no synonym table and no learned
   * ranking, so the same text against the same catalog always resolves the same
   * way — which is the only property that makes "resolve, then trade" safe.
   *
   * Search runs over the whole filtered catalog before `limit` truncates the
   * page, so `resolution.matchCount` is the true total.
   */
  search?: string;
}

export interface ListMarketsResponseBody {
  markets: PredictAgentMarket[];
  /**
   * Present ONLY when the request carried `search`.
   *
   * The list order is match specificity then the round clock then the market id
   * — a tie-break rule that makes the page reproducible. It is NOT a ranking of
   * which market is worth trading, and nothing in this API scores that.
   */
  resolution?: PredictMarketResolution;
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

export interface ListFillsResponseBody extends PredictPagedListResponse {
  fills: PredictFill[];
}

/* ── Performance ─────────────────────────────────────────────────────────── */

/**
 * A ratio in the inclusive range `0`–`1`, as a decimal string at 4 dp.
 *
 * A separate alias from `DecimalString` on purpose: these are NOT money and must
 * not be summed, converted, or compared against a balance. Null everywhere the
 * denominator is zero — a rate over no trades is undefined, and reporting `"0"`
 * there would read as "everything lost".
 */
export type RatioString = string;

/**
 * What population a performance figure was computed over.
 *
 * `API_ATTRIBUTED_ONLY` is the only value this API produces, and the only one it
 * can honestly produce. See `PredictAgentPerformanceResponseBody`.
 */
export type PredictPerformanceAttributionScope = 'API_ATTRIBUTED_ONLY' | (string & {});

/** Order lifecycle counts. Every execution this agent created on this account. */
export interface PredictOrderOutcomeStats {
  created: number;
  /** Reached a terminal status: FILLED + REJECTED + CANCELLED + EXPIRED. */
  terminal: number;
  filled: number;
  rejected: number;
  cancelled: number;
  expired: number;
  /** `created − terminal`. Still moving; counted in neither rate. */
  inFlight: number;
  /**
   * `filled / terminal` — of the orders that FINISHED, how many filled.
   *
   * The denominator is deliberately terminal, not created: dividing by created
   * would make a burst of still-in-flight orders look like a fall in success
   * rate, when nothing has failed yet.
   */
  successRate: RatioString | null;
  /** `terminal / created` — how much of the history has actually settled. */
  terminalRate: RatioString | null;
}

/**
 * One rejection bucket. `errorCode` and `stage` are null together only for a
 * terminal rejection recorded before either was known, which should not happen
 * and is surfaced rather than folded into a neighbouring bucket.
 */
export interface PredictRejectionReasonCount {
  errorCode: PredictAgentErrorCode | null;
  stage: PredictRejectionStage | null;
  count: number;
}

/**
 * Realized money, over SELL executions this API filled whose cost basis it also
 * recorded.
 *
 * `realizedPnl` is `grossProceeds − costBasis`, signed. The basis is the exact
 * amount the close released from deployed budget — the contract's own
 * `split_cost`, not a proportion inferred here — so this figure reconciles
 * against the allowance ledger by construction.
 */
export interface PredictRealizedStats {
  /** Exits counted. A partial exit counts once, on the portion sold. */
  closedExits: number;
  wins: number;
  losses: number;
  breakEven: number;
  /** `wins / closedExits`. Null when nothing has closed. */
  winRate: RatioString | null;
  grossProceeds: DecimalString;
  costBasis: DecimalString;
  /** Signed: a losing period is negative. */
  realizedPnl: DecimalString;
}

/**
 * What this API knows it did NOT count, as counts rather than as prose.
 *
 * These are published beside the totals because every one of them makes realized
 * PnL an understatement or an overstatement in a specific direction, and an agent
 * sizing off a win rate needs to see the size of the hole.
 */
export interface PredictPerformanceExclusions {
  /**
   * Filled SELLs closing a position this API never opened, so no cost basis
   * exists. Their proceeds are NOT in `grossProceeds` — counting them would
   * report the whole exit as profit.
   */
  exitsWithoutAttributedBasis: number;
  /**
   * Positions resolved and claimed rather than sold. The payout is collected from
   * the FE and never passes through this API, so the winning side of a resolved
   * market is invisible here — this is the exclusion that biases `winRate`
   * DOWNWARD, and by the most.
   */
  claimedPositions: number;
  /** Positions still carrying deployed cost. Unrealized; see `/positions`. */
  openPositions: number;
}

/**
 * Agent performance, over the orders this API executed (spec §19.2).
 *
 * SCOPE, STATED BEFORE THE NUMBERS. `attributionScope` is `API_ATTRIBUTED_ONLY`
 * and there is no other mode. The same delegated key can trade this market
 * directly on chain; that activity never had an execution row, was never
 * reserved against the allowance, and is not represented here at ANY confidence.
 * Blending it in would require inventing an entry price for a trade this backend
 * never priced, and the resulting win rate would look complete while being wrong.
 * So the incompleteness is named in `excluded` instead of smoothed away.
 *
 * There is no time window. Every figure is lifetime-to-date for the (account,
 * agent[, strategy]) triple, because the claim exclusions below have no recorded
 * instant to window on and a windowed total would silently disagree with them.
 */
export interface PredictAgentPerformanceResponseBody {
  accountId: string;
  agentWallet: string;
  /** Echo of the `strategyId` filter, or null when the read was unfiltered. */
  strategyId: string | null;
  attributionScope: PredictPerformanceAttributionScope;
  orders: PredictOrderOutcomeStats;
  /** Descending by count, then by code. Empty when nothing was rejected. */
  rejections: PredictRejectionReasonCount[];
  realized: PredictRealizedStats;
  excluded: PredictPerformanceExclusions;
  asOf: Iso8601;
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
  agentAccounts: 'agent-api/v1/predict/accounts',
  allowance: 'agent-api/v1/predict/accounts/:accountId/allowance',
  effectiveLimits: 'agent-api/v1/predict/accounts/:accountId/effective-limits',
  positions: 'agent-api/v1/predict/accounts/:accountId/positions',
  fills: 'agent-api/v1/predict/accounts/:accountId/fills',
  performance: 'agent-api/v1/predict/accounts/:accountId/performance',
  listExecutions: 'agent-api/v1/predict/accounts/:accountId/executions',
  riskProfile: 'agent-api/v1/predict/accounts/:accountId/agents/:agentWallet/risk-profile',
  listRiskProfiles: 'agent-api/v1/predict/accounts/agents/risk-profiles',
} as const;

/* ── Deployments ─────────────────────────────────────────────────────────── */

/**
 * The deployments this API version is served from, by name.
 *
 * A LOOKUP, and deliberately NOT a default. `baseUrl` stays required on the
 * client because the deployment is the one thing no library may choose on a
 * caller's behalf: a default would make "unconfigured" mean production, which
 * is the most expensive way to be wrong. What this map removes is the other
 * failure — a hand-typed host that differs from the intended one by a hyphen —
 * and it makes the environment visible in the diff that changes it:
 *
 * ```ts
 * new PredictAgentClient({ baseUrl: PREDICT_AGENT_ENDPOINTS.testnet, signer });
 * ```
 *
 * A deployment absent from this map is not thereby invalid; a private or
 * preview host is still passed as a plain string.
 */
export const PREDICT_AGENT_ENDPOINTS = {
  production: 'https://api.waterx.app',
  testnet: 'https://api-testnet.waterx.app',
} as const;

/** The named deployments in {@link PREDICT_AGENT_ENDPOINTS}. */
export type PredictAgentDeployment = keyof typeof PREDICT_AGENT_ENDPOINTS;

/** Header carrying the agent-generated idempotency token on execution creation. */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
