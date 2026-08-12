/**
 * Last-resort secret suppression.
 *
 * The real defence is that this CLI never reads a private key and never puts a
 * token in a result: raw keys stay behind the external signer command, and the
 * session token lives in the SDK. This is the backstop for the paths that are
 * easy to get wrong anyway — an SDK error message that quoted a header, a
 * signer subprocess that printed its own configuration to stderr, a stack trace
 * from a dependency.
 *
 * It runs over the serialized stdout document AND over every stderr line, so
 * there is no output path that skips it.
 */

const PLACEHOLDER = '[redacted]';

/**
 * Below this, a "secret" is more likely to be a substring of ordinary output
 * than a credential, and replacing it would corrupt the result while protecting
 * nothing. A real bearer token or key is far longer.
 */
const MIN_SECRET_LENGTH = 12;

export class Redactor {
  readonly #secrets = new Set<string>();

  /** Ignores anything absent or too short to be a credential. */
  register(secret: string | undefined | null): void {
    if (typeof secret !== 'string') return;
    const trimmed = secret.trim();
    if (trimmed.length < MIN_SECRET_LENGTH) return;
    this.#secrets.add(trimmed);
  }

  redact(text: string): string {
    let out = text;
    for (const secret of this.#secrets) out = out.split(secret).join(PLACEHOLDER);
    return out;
  }

  /** For tests and diagnostics: how many secrets are being watched, never which. */
  get watched(): number {
    return this.#secrets.size;
  }
}

/**
 * Environment variables whose value is a credential. Registered before anything
 * else runs, so a failure during configuration is already covered.
 */
export const SECRET_ENV_KEYS = ['WATERX_PREDICT_TOKEN'] as const;
