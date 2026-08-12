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
 * Whether an error is worth another attempt of the SAME request.
 *
 * A transport error counts as retryable ONLY because every retryable call site in
 * this SDK is idempotent — a create carries a stable Idempotency-Key and a submit
 * is idempotent server-side. Do not reuse this predicate for a request that lacks
 * that property: "the socket died" does not tell you whether the server acted.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof PredictAgentApiError) return error.retryable;
  return error instanceof PredictAgentTransportError;
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
