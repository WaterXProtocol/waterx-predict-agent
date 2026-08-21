/**
 * The error every method throws, and the rules a retry policy reads off it.
 *
 * The server sends a symbolic `code` plus a `retryable` boolean. We trust the
 * boolean rather than re-deriving it from a local table: the server owns which
 * conditions are transient, and a stale copy here would either retry something
 * permanent forever or give up on something that would have worked.
 */
import type { PredictAgentErrorBody, PredictAgentErrorCode } from './contract.ts';

export class PredictAgentApiError extends Error {
  /** Branch on this, never on `message`. */
  readonly code: PredictAgentErrorCode;
  /** Whether retrying the IDENTICAL intent can succeed. Server-decided. */
  readonly retryable: boolean;
  readonly httpStatus: number;
  readonly executionId: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    httpStatus: number,
    body: PredictAgentErrorBody['error'],
  ) {
    super(`${body.code}: ${body.message}`);
    this.name = 'PredictAgentApiError';
    this.httpStatus = httpStatus;
    this.code = body.code;
    this.retryable = body.retryable;
    this.executionId = body.executionId;
    this.details = body.details;
  }
}

/**
 * A transport-level failure with no server body — DNS, socket reset, a 502 from
 * a proxy. Distinct from PredictAgentApiError because the request may or may not
 * have reached the server, which is what makes blind retries dangerous.
 */
export class PredictAgentTransportError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'PredictAgentTransportError';
    this.cause = cause;
  }
}

export function isPredictAgentApiError(error: unknown): error is PredictAgentApiError {
  return error instanceof PredictAgentApiError;
}

/**
 * Codes that are retryable as an INTENT but not as the same bytes.
 *
 * The server's `retryable` answers "can this intent succeed later". The transport
 * asks a narrower question — "can resending exactly what I sent succeed" — and
 * for these three the answer is no, however many times it asks:
 *
 *   QUOTE_EXPIRED       the request names a quote that is gone. An executable
 *                       quote lives about three seconds, so the copy in the
 *                       already-serialized body is dead for good; only a REBUILT
 *                       request can succeed.
 *   SLIPPAGE_EXCEEDED   decided after the intent was accepted, which leaves the
 *                       execution terminal. The Idempotency-Key is spent: the
 *                       same key now resolves to that failed attempt forever.
 *   SPONSOR_UNAVAILABLE same shape — accepted, then terminal, same spent key.
 *
 * Resending burned the retry budget on requests that could not succeed and
 * delayed the real answer by the whole backoff. Excluding them here does not make
 * the intent unretryable; it moves the retry to the layer that can actually
 * rebuild it, which for a stale quote is `executeMarketOrder`, and for a spent
 * key is the caller, under a new one.
 */
const NOT_RESENDABLE_AS_IS: ReadonlySet<PredictAgentErrorCode> = new Set([
  'QUOTE_EXPIRED',
  'SLIPPAGE_EXCEEDED',
  'SPONSOR_UNAVAILABLE',
]);

/**
 * Whether an error is worth another attempt of the SAME request.
 *
 * A transport error counts as retryable ONLY because every retryable call site in
 * this SDK is idempotent — a create carries a stable Idempotency-Key and a submit
 * is idempotent server-side. Do not reuse this predicate for a request that lacks
 * that property: "the socket died" does not tell you whether the server acted.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof PredictAgentApiError) {
    return error.retryable && !NOT_RESENDABLE_AS_IS.has(error.code);
  }
  return error instanceof PredictAgentTransportError;
}

/**
 * Codes that say the write's OUTCOME is unknown, not that it failed.
 *
 * The server reaches for these when it could not learn what became of something
 * it had already handed to the chain — a submission that never answered, a
 * deadline that expired mid-flight. The order may well exist. Treating either as
 * a refusal tells a strategy that nothing happened, which is the one wrong
 * answer: a caller that believes nothing happened places the order again.
 */
const AMBIGUOUS_OUTCOME_CODES: ReadonlySet<PredictAgentErrorCode> = new Set([
  'RECONCILIATION_REQUIRED',
  'EXECUTION_TIMEOUT',
]);

/**
 * Whether this error leaves the outcome of a write UNKNOWN.
 *
 * A caller must not record the write as failed, roll back its own state, or
 * retry under a fresh key. The execution id, when the server sent one, is the
 * handle to reconcile with.
 */
export function isAmbiguousOutcome(error: unknown): boolean {
  if (error instanceof PredictAgentTransportError) return true;
  return error instanceof PredictAgentApiError && AMBIGUOUS_OUTCOME_CODES.has(error.code);
}

/** The one NOT_RESENDABLE_AS_IS code a caller can fix by rebuilding the request. */
export function isStaleQuote(error: unknown): boolean {
  return error instanceof PredictAgentApiError && error.code === 'QUOTE_EXPIRED';
}

/**
 * Whether the server rejected the SESSION — an expired or invalid bearer token —
 * as opposed to rejecting the intent.
 *
 * Deliberately narrow: 401 with `UNAUTHENTICATED` only. The server maps a 403
 * from outside the module onto the same code, but a forbidden request is not
 * fixed by a new token, and `SIGNATURE_INVALID` is also a 401 while being a fact
 * about the ORDER signature. Re-authenticating on either would hide a permanent
 * failure behind a login loop.
 */
export function isUnauthenticated(error: unknown): boolean {
  return (
    error instanceof PredictAgentApiError &&
    error.httpStatus === 401 &&
    error.code === 'UNAUTHENTICATED'
  );
}
