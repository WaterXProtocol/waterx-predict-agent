/**
 * The HTTP layer: one place that knows about base URLs, the bearer token, the
 * flat error envelope, and the retry policy. Uses global `fetch`, so nothing on
 * the REST path pulls in a dependency — the package's only one is the stream
 * transport, which is loaded lazily and never reached from here.
 *
 * THE RETRY RULE, because it is the part that can lose money if it is wrong:
 * a request is only ever retried when the caller passed `idempotent: true`. That
 * flag is a promise from the call site that repeating the exact bytes is safe —
 * an execution create carries a stable Idempotency-Key, a submit is idempotent
 * server-side, and reads are trivially safe. A create with a FRESH key is not
 * idempotent and must never be retried here, because a timeout does not tell you
 * whether the order was placed.
 *
 * THE EXACT-BYTES RULE: the body is serialized ONCE per `request` and that string
 * is what every attempt sends. Re-serializing per attempt would let a caller
 * mutating its intent object turn a retry — or a replay after re-authentication —
 * into a different order under the same idempotency key, which the server would
 * legitimately reject or, worse, resolve to the wrong intent.
 */
import {
  PredictAgentApiError,
  PredictAgentTransportError,
  isRetryable,
  isUnauthenticated,
} from './errors.ts';
import { IDEMPOTENCY_KEY_HEADER, type PredictAgentErrorBody } from './contract.ts';
import type { AuthSession } from './session.ts';
import { sleep } from './sleep.ts';

export interface RetryOptions {
  /** Attempts INCLUDING the first. 1 disables retrying. */
  maxAttempts?: number;
  /** Base delay; doubles per attempt. */
  baseDelayMs?: number;
}

export interface TransportOptions {
  /** e.g. `https://api.waterx.app` — no trailing slash required. */
  baseUrl: string;
  /** Overridable for tests and for runtimes with a non-global fetch. */
  fetch?: typeof globalThis.fetch;
  retry?: RetryOptions;
}

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  /**
   * Send the session's bearer token, and let one expired token be replaced.
   * False on the auth route, which is how a token is obtained in the first place.
   */
  authenticated?: boolean;
  idempotencyKey?: string;
  /**
   * True only when repeating these exact bytes is safe. Gates ALL retrying —
   * see the file header.
   */
  idempotent?: boolean;
  signal?: AbortSignal;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 200;

export class Transport {
  private readonly baseUrl: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly session: AuthSession;

  constructor(options: TransportOptions, session: AuthSession) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxAttempts = options.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseDelayMs = options.retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.session = session;
  }

  async request<T>(options: RequestOptions): Promise<T> {
    const attempts = options.idempotent === true ? this.maxAttempts : 1;
    // Serialized once. See the file header: every attempt of this logical write
    // sends these exact bytes under the caller's idempotency key.
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    let attempt = 1;
    let reauthenticated = false;

    for (;;) {
      const token = options.authenticated === true ? await this.session.require() : undefined;
      try {
        return await this.attempt<T>(options, payload, token);
      } catch (error: unknown) {
        // A rejected session is not a failed intent: the guard runs before the
        // handler, so nothing was written, and the replay below carries the same
        // key and the same bytes even if something had been. Bounded to ONE
        // re-authentication per request so a server issuing dead tokens produces
        // an error rather than a login loop.
        if (
          options.authenticated === true &&
          !reauthenticated &&
          this.session.automatic &&
          isUnauthenticated(error)
        ) {
          reauthenticated = true;
          const replacement = await this.session.refresh(token);
          // undefined means this session may not re-authenticate; surface the
          // server's own rejection rather than inventing a recovery.
          if (replacement !== undefined) continue;
        }
        // Stop immediately on anything the server called permanent, and on the
        // last attempt. Backoff is exponential from `baseDelayMs`.
        if (attempt >= attempts || !isRetryable(error)) throw error;
        await sleep(this.baseDelayMs * 2 ** (attempt - 1), options.signal);
        // Aborting DURING a backoff is not a clean cancellation: an attempt has
        // already been made, and the reason we are here is that its outcome was
        // ambiguous. Reported as a transport error so the caller's handler
        // recognises it as such and keeps the idempotency key — a bare Error
        // escaped every guard and took the key with it, which is the one way to
        // turn a lost answer into a second order.
        if (options.signal?.aborted === true) {
          throw new PredictAgentTransportError('aborted while waiting to retry', error);
        }
        attempt += 1;
      }
    }
  }

  private async attempt<T>(
    options: RequestOptions,
    payload: string | undefined,
    token: string | undefined,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}/${options.path.replace(/^\/+/, '')}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = { accept: 'application/json' };
    if (payload !== undefined) headers['content-type'] = 'application/json';
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    if (options.idempotencyKey !== undefined) {
      headers[IDEMPOTENCY_KEY_HEADER] = options.idempotencyKey;
    }

    let response: Response;
    try {
      response = await this.doFetch(url, {
        method: options.method,
        headers,
        ...(payload !== undefined ? { body: payload } : {}),
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
    } catch (error: unknown) {
      throw new PredictAgentTransportError(
        `${options.method} ${options.path} failed before a response`,
        error,
      );
    }

    if (!response.ok) throw await toApiError(response, options);
    // 202 with an empty body is legal on the submit route.
    const text = await response.text();
    return (text === '' ? undefined : JSON.parse(text)) as T;
  }
}

/**
 * Turn a non-2xx into a typed error. A body that is not the documented envelope
 * (a proxy's HTML 502, say) becomes a TRANSPORT error rather than being coerced
 * into a fabricated code — an agent must not branch on a code nobody sent.
 */
async function toApiError(
  response: Response,
  options: RequestOptions,
): Promise<PredictAgentApiError | PredictAgentTransportError> {
  const text = await response.text().catch(() => '');
  try {
    const parsed = JSON.parse(text) as PredictAgentErrorBody;
    if (typeof parsed.error?.code === 'string') {
      return new PredictAgentApiError(response.status, parsed.error);
    }
  } catch {
    // fall through to the transport error below
  }
  return new PredictAgentTransportError(
    `${options.method} ${options.path} returned ${String(response.status)} with an unrecognised body`,
    text.slice(0, 500),
  );
}
