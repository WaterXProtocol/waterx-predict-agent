/**
 * Time, as an injected value.
 *
 * Every durable decision in this package — a lease expiry, a heartbeat, an
 * `expiresAt` — is an ISO-8601 string the caller supplies, never a clock the
 * store reads for itself. That is what makes the crash-recovery table testable
 * as a table. The daemon needs a clock somewhere, so it takes one here rather
 * than calling `Date.now()` in the middle of a lease decision.
 */
export type Clock = () => string;

export const systemClock: Clock = () => new Date().toISOString();
