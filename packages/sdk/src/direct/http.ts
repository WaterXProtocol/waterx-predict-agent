/**
 * The HTTP client for the public routes: the envelope, and what a failure means.
 *
 * TWO DIFFERENCES FROM THE AGENT API TRANSPORT, and both are forced by the
 * server rather than chosen:
 *
 * - Every response is wrapped in `{ success, data | error }` with a NUMERIC
 *   code, and there is no `retryable` field. So this module holds the one table
 *   that says which numbers mean what (`symbolFor`). It is a local judgement
 *   because the server offers none; it is kept small, and anything it does not
 *   name is reported as the generic failure it is, with the number attached.
 * - Nothing here is idempotent on the server. GETs are retried, bounded; a POST
 *   never is. A build that fails reserved nothing a retry could duplicate, but a
 *   `/sponsor/execute` that fails without an answer may have executed — the
 *   caller (`client.ts`) is the one that knows which it sent.
 *
 * Errors are surfaced as `PredictAgentApiError` with the symbolic code nearest
 * in meaning, so every surface above keeps one error vocabulary; the numeric
 * code travels in `details.publicCode`.
 */
import type { PredictAgentErrorCode } from '../contract.ts';
import { PredictAgentApiError, PredictAgentTransportError } from '../errors.ts';
import { sleep } from '../sleep.ts';
import { PUBLIC_ERROR_CODES as C, type PublicEnvelope } from './wire.ts';

export interface DirectHttpOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  /** Attempts for a GET, including the first. */
  readonly maxGetAttempts?: number;
}

type Query = Record<string, string | number | boolean | undefined>;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_GET_ATTEMPTS = 3;

/** Numeric code (or HTTP status when the body names none) → symbol, retryable. */
export function symbolFor(code: number, httpStatus: number): { code: PredictAgentErrorCode; retryable: boolean } {
  switch (code) {
    case C.DelegateNotAuthorized:
    case C.DelegateInsufficientPermission:
      return { code: 'DELEGATION_PERMISSION_DENIED', retryable: false };
    case C.SponsoredTxNotConfigured:
    case C.SponsorshipRequiredForDelegate:
    case C.SponsorGasBudgetDepleted:
      return { code: 'SPONSOR_UNAVAILABLE', retryable: true };
    case C.TxWouldFail:
      return { code: 'CHAIN_REJECTED', retryable: false };
    case C.SponsorSessionExpired:
      return { code: 'SIGNATURE_EXPIRED', retryable: false };
    case C.RateLimited:
      return { code: 'RATE_LIMITED', retryable: true };
    case C.PredictPositionCloseInFlight:
      return { code: 'POSITION_CLOSE_IN_FLIGHT', retryable: false };
    case C.PredictSellPositionNotFound:
    case C.PredictNoSellablePositions:
      return { code: 'POSITION_NOT_FOUND', retryable: false };
    case C.BetBelowMinimum:
    case C.PredictSellAmbiguousTarget:
    case C.PredictSellAdminGrantedPosition:
    case C.InvalidParameter:
    case C.MissingRequiredField:
      return { code: 'INVALID_REQUEST', retryable: false };
    case C.DelegatesQueryFailed:
    case C.ServiceBusy:
    case C.TransientUpstream:
      return { code: 'INTERNAL_ERROR', retryable: true };
    default:
      break;
  }
  if (httpStatus === 429) return { code: 'RATE_LIMITED', retryable: true };
  if (httpStatus >= 400 && httpStatus < 500) return { code: 'INVALID_REQUEST', retryable: false };
  return { code: 'INTERNAL_ERROR', retryable: true };
}

/**
 * How long a 429 asks the caller to wait, in ms.
 *
 * The backend's throttler has several windows and names each one
 * (`retry-after-short|medium|long`); the longest is the one that decides when
 * a request can succeed again.
 */
export function retryAfterOf(headers: Headers): number | undefined {
  let longest: number | undefined;
  headers.forEach((value, name) => {
    if (name !== 'retry-after' && !name.startsWith('retry-after-')) return;
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) return;
    longest = Math.max(longest ?? 0, seconds * 1_000);
  });
  return longest;
}

export class DirectHttp {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxGetAttempts: number;

  constructor(options: DirectHttpOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxGetAttempts = Math.max(1, options.maxGetAttempts ?? DEFAULT_GET_ATTEMPTS);
  }

  async get<T>(path: string, query?: Query, signal?: AbortSignal): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxGetAttempts; attempt += 1) {
      try {
        return await this.send<T>('GET', path, undefined, query, signal);
      } catch (error: unknown) {
        lastError = error;
        const retryable =
          error instanceof PredictAgentTransportError ||
          (error instanceof PredictAgentApiError && error.retryable);
        // A rate limit is not retried here: another request inside the same
        // window only spends quota. The caller reads `retryAfterMs` and waits.
        const limited = error instanceof PredictAgentApiError && error.code === 'RATE_LIMITED';
        if (!retryable || limited || attempt === this.maxGetAttempts || signal?.aborted === true) throw error;
        await sleep(Math.min(250 * 2 ** (attempt - 1), 2_000), signal);
      }
    }
    throw lastError;
  }

  /** Never retried. See the module comment. */
  async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return await this.send<T>('POST', path, body, undefined, signal);
  }

  private async send<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    query: Query | undefined,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}/${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: combined,
      });
    } catch (error: unknown) {
      if (signal?.aborted === true) throw error;
      throw new PredictAgentTransportError(`${method} ${path} did not complete`, error);
    }

    const text = await response.text().catch(() => '');
    let parsed: PublicEnvelope<T> | undefined;
    try {
      parsed = JSON.parse(text) as PublicEnvelope<T>;
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined || typeof parsed !== 'object' || typeof parsed.success !== 'boolean') {
      // A proxy page or a truncated body is not a server answer, and is not
      // turned into one: the request may or may not have been handled.
      throw new PredictAgentTransportError(
        `${method} ${path} answered HTTP ${String(response.status)} without a WaterX envelope`,
        text.slice(0, 200),
      );
    }
    if (parsed.success) return parsed.data;

    const numeric = typeof parsed.error?.code === 'number' ? parsed.error.code : response.status;
    const symbol = symbolFor(numeric, response.status);
    const retryAfterMs = response.status === 429 ? retryAfterOf(response.headers) : undefined;
    throw new PredictAgentApiError(response.status, {
      code: symbol.code,
      message: parsed.error?.message ?? `HTTP ${String(response.status)}`,
      retryable: symbol.retryable,
      details: {
        publicCode: numeric,
        route: `${method} ${path}`,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        ...(parsed.details === undefined ? {} : { server: parsed.details }),
      },
    });
  }
}
