/**
 * The HTTP layer: one place that knows about base URLs, the bearer token, the
 * flat error envelope, and the retry policy. Uses global `fetch`, so this package
 * has no runtime dependencies at all.
 *
 * THE RETRY RULE, because it is the part that can lose money if it is wrong:
 * a request is only ever retried when the caller passed `idempotent: true`. That
 * flag is a promise from the call site that repeating the exact bytes is safe —
 * an execution create carries a stable Idempotency-Key, a submit is idempotent
 * server-side, and reads are trivially safe. A create with a FRESH key is not
 * idempotent and must never be retried here, because a timeout does not tell you
 * whether the order was placed.
 */
import { PredictAgentApiError, PredictAgentTransportError, isRetryable } from './errors.ts';
import { IDEMPOTENCY_KEY_HEADER, type PredictAgentErrorBody } from './contract.ts';

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
  /** Bearer token. Omitted on the auth route, which has none yet. */
  token?: string;
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

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('Aborted'));
      },
      { once: true },
    );
  });

export class Transport {
  private readonly baseUrl: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;

  constructor(options: TransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxAttempts = options.retry?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseDelayMs = options.retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  }

  async request<T>(options: RequestOptions): Promise<T> {
    const attempts = options.idempotent === true ? this.maxAttempts : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await this.attempt<T>(options);
      } catch (error: unknown) {
        lastError = error;
        // Stop immediately on anything the server called permanent, and on the
        // last attempt. Backoff is exponential from `baseDelayMs`.
        if (attempt === attempts || !isRetryable(error)) throw error;
        await sleep(this.baseDelayMs * 2 ** (attempt - 1), options.signal);
      }
    }
    throw lastError;
  }

  private async attempt<T>(options: RequestOptions): Promise<T> {
    const url = new URL(`${this.baseUrl}/${options.path.replace(/^\/+/, '')}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
    if (options.idempotencyKey !== undefined) {
      headers[IDEMPOTENCY_KEY_HEADER] = options.idempotencyKey;
    }

    let response: Response;
    try {
      response = await this.doFetch(url, {
        method: options.method,
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
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
