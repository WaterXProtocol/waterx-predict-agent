/**
 * Every way a strategy is refused before anything durable is written.
 *
 * These sit in front of the store rather than inside it. The store's refusals
 * protect an order that is already in motion; these protect the description of
 * one, and they exist because the alternative to refusing an under-specified
 * strategy is guessing what the owner meant about size, side, or when it stops.
 *
 * Each code names a decision a caller has to make, so a CLI or an agent can say
 * what is missing instead of re-reading a sentence. Nothing here is retryable by
 * repetition: the request has to change.
 */
export type StrategyErrorCode =
  /* ── Expiry (ADR-0005) ─────────────────────────────────────────────────── */
  /** `expiresAt` was absent. There is no permanent watcher to fall back on. */
  | 'EXPIRY_REQUIRED'
  /** Present but not a parseable instant. Never interpreted as "soon". */
  | 'EXPIRY_INVALID'
  /** At or before the creation instant; the job would exist already expired. */
  | 'EXPIRY_IN_PAST'
  /** Beyond the beta maximum. Named in the error, and never clamped silently. */
  | 'EXPIRY_TOO_FAR'

  /* ── Shape ─────────────────────────────────────────────────────────────── */
  /** A strategy with no legs would watch a price and then do nothing. */
  | 'NO_LEGS'
  /** A required identifier or field was absent or empty. */
  | 'FIELD_REQUIRED'
  /** Present but not of the required form. */
  | 'FIELD_INVALID'

  /* ── Size (ADR-0001 §11) ───────────────────────────────────────────────── */
  /** Neither a budget nor a share count reached the leg. */
  | 'SIZE_MISSING'
  /**
   * More than one sizing was given, or the sizing does not match the side — a
   * BUY carrying `sellShares`, a SELL carrying `buyAmount`, a share count and a
   * fraction together. Ambiguity stops here, before any write.
   */
  | 'SIZE_AMBIGUOUS'
  /** A size that is not an unsigned decimal, or is zero. */
  | 'SIZE_INVALID'

  /* ── Percentage SELL (D-15) ────────────────────────────────────────────── */
  /** A fraction outside `(0, 1]`, or not a decimal at all. */
  | 'FRACTION_INVALID'
  /** The fraction of the held position truncates to zero shares. */
  | 'FRACTION_RESOLVES_TO_ZERO'
  /** A SELL without the position it closes. */
  | 'POSITION_REQUIRED'
  /** A BUY carrying a position id; a BUY opens, it does not close. */
  | 'POSITION_NOT_APPLICABLE'
  /** Freezing a fraction needs an authoritative position read, and none was wired. */
  | 'POSITION_READ_UNAVAILABLE'
  /** The account's positions were walked to exhaustion and this one is not there. */
  | 'POSITION_UNKNOWN'
  /**
   * The walk ended without the server proving it was complete, so "not found" is
   * not a fact. Freezing a fraction against a position that may exist is the one
   * case where guessing changes the size of an order.
   */
  | 'POSITION_LOOKUP_INCONCLUSIVE'
  /** The position names a different market or outcome than the leg does. */
  | 'POSITION_MISMATCH'
  /**
   * The server reported the share count as unknown. Null is not zero, and a
   * fraction of an unknown quantity is not a size (contract: `shares`).
   */
  | 'POSITION_SHARES_UNKNOWN'

  /* ── Trigger ───────────────────────────────────────────────────────────── */
  /** A price trigger with no target, or an immediate trigger carrying one. */
  | 'TRIGGER_INVALID'
  /** The watched market was named in part. All of market, outcome and side, or none. */
  | 'TRIGGER_INCOMPLETE'
  /** The legs disagree, so the watched market cannot be derived from them. */
  | 'TRIGGER_AMBIGUOUS'

  /* ── Policy ────────────────────────────────────────────────────────────── */
  /**
   * The policy in force is read-only. A durable strategy exists to sign later, so
   * it is refused at creation rather than at the moment it would have traded.
   */
  | 'POLICY_FORBIDS_WRITE'
  /**
   * The policy in force is `interactive` — the default — and a durable strategy
   * fires while nobody is being asked. Unattended signing is what scoped
   * `delegated-auto` authorizes, and it is refused here rather than at the trigger
   * for two reasons: the owner finds out at the prompt instead of hours later, and
   * accepting it would make the delegated scope evadable by wrapping any order in
   * a strategy whose trigger is already met.
   */
  | 'POLICY_REQUIRES_DELEGATION'
  /** A policy mode this build does not recognize. An unknown authority is none. */
  | 'POLICY_MODE_UNRECOGNIZED';

export class StrategyError extends Error {
  override readonly name = 'StrategyError';

  constructor(
    readonly code: StrategyErrorCode,
    message: string,
    readonly detail?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}

export const isStrategyError = (value: unknown): value is StrategyError =>
  value instanceof StrategyError;
