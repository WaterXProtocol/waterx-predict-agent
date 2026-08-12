/**
 * The agent's session token and the rules for replacing it.
 *
 * A strategy outlives its token. The server's JWT is short-lived, so a wait that
 * runs for an hour will meet a 401 in the middle of a flow that may already have
 * created an execution — and the one thing that must never happen there is a
 * second order. Two properties make that safe, and both live here:
 *
 *  - SINGLE FLIGHT. Every concurrent request that observes the same dead token
 *    joins ONE mint. Ten in-flight requests must produce one signature and one
 *    session, not ten logins racing to overwrite each other's token.
 *  - COMPARE AND SWAP. A request re-authenticates only when the token it just
 *    used is still the current one. If another request already replaced it, the
 *    replacement is handed back and no new challenge is signed.
 *
 * Replacing a token changes nothing about the request being replayed: the body
 * bytes and the `Idempotency-Key` are the caller's, not the session's, so a
 * replay after re-authentication is the same logical write.
 */
import type { AgentAuthResponseBody } from './contract.ts';

/**
 * Replace a self-minted token this long before it expires.
 *
 * Small on purpose. The margin exists to avoid spending a token that dies
 * between the create and the submit of one order, not to second-guess the
 * server's lifetime — a large margin on a short token would re-authenticate
 * constantly under clock skew.
 */
const EXPIRY_MARGIN_MS = 5_000;

export interface AuthSessionOptions {
  /**
   * An existing token to reuse. Its expiry is UNKNOWN to this session, so it is
   * only ever replaced reactively, after the server rejects it.
   */
  token?: string;
  /** Signs a fresh challenge and returns the server's answer. */
  mint: () => Promise<AgentAuthResponseBody>;
  /** Whether a rejected or expiring token may be replaced without the caller asking. */
  automatic: boolean;
}

export class AuthSession {
  /** Exposed so the transport can skip the re-authentication path entirely. */
  readonly automatic: boolean;

  private readonly mint: () => Promise<AgentAuthResponseBody>;
  private token: string | undefined;
  /** Epoch ms, or undefined when the lifetime is unknown (a caller's token). */
  private expiresAt: number | undefined;
  private inFlight: Promise<AgentAuthResponseBody> | undefined;

  constructor(options: AuthSessionOptions) {
    this.token = options.token;
    this.mint = options.mint;
    this.automatic = options.automatic;
  }

  /**
   * Open a session now, joining a mint already in flight rather than starting a
   * competing one.
   */
  async authenticate(): Promise<AgentAuthResponseBody> {
    this.inFlight ??= this.mintOnce();
    return await this.inFlight;
  }

  /** The token to send with the next attempt. */
  async require(): Promise<string> {
    const token = this.token;
    if (token === undefined) {
      throw new Error('Not authenticated — call authenticate() or pass a token');
    }
    // A token this session minted carries a known lifetime, so it can be rolled
    // over BEFORE it dies. That is what keeps a long wait from meeting a 401
    // between an execution's create and its submit.
    if (this.automatic && this.expiresAt !== undefined && Date.now() >= this.expiresAt - EXPIRY_MARGIN_MS) {
      return (await this.authenticate()).token;
    }
    return token;
  }

  /**
   * Replace a token the server just rejected.
   *
   * Returns `undefined` when this session may not re-authenticate, so the caller
   * surfaces the server's original rejection instead of inventing a recovery.
   * Returns the CURRENT token without minting when another request already
   * replaced the rejected one — the compare-and-swap that stops a burst of
   * concurrent 401s from becoming a burst of logins.
   */
  async refresh(rejected: string | undefined): Promise<string | undefined> {
    if (!this.automatic) return undefined;
    const current = this.token;
    if (current !== undefined && current !== rejected) return current;
    return (await this.authenticate()).token;
  }

  /** The current token without minting anything. */
  peek(): string | undefined {
    return this.token;
  }

  private async mintOnce(): Promise<AgentAuthResponseBody> {
    try {
      const response = await this.mint();
      this.token = response.token;
      this.expiresAt =
        typeof response.expiresIn === 'number' && Number.isFinite(response.expiresIn)
          ? Date.now() + response.expiresIn * 1_000
          : undefined;
      return response;
    } finally {
      // Cleared before any awaiter resumes, so the next failure starts a new
      // mint instead of re-awaiting a settled one.
      this.inFlight = undefined;
    }
  }
}
