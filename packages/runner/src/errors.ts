/**
 * Every way the durable store refuses a write.
 *
 * These are not diagnostics. Each one names a rule that exists because breaking
 * it can place a duplicate or unintended order, so a caller must be able to
 * branch on the code rather than parse a message.
 */
export type JobStoreErrorCode =
  /** No such job in this store. */
  | 'UNKNOWN_JOB'
  /** No such leg on this job. */
  | 'UNKNOWN_LEG'
  /** The state machine has no edge from the current state to the requested one. */
  | 'ILLEGAL_TRANSITION'
  /**
   * The caller's lease is stale: another Runner instance claimed this job, or the
   * lease was reclaimed after this instance stopped heartbeating. A write under a
   * lost lease is exactly the duplicate-Runner case, so it fails loudly.
   */
  | 'LEASE_LOST'
  /**
   * A state that can produce an external side effect was entered before the
   * idempotency key for the leg was durably written.
   */
  | 'NO_IDEMPOTENCY_KEY'
  /** Two legs may never share one key, and one leg may never mint a second. */
  | 'DUPLICATE_IDEMPOTENCY_KEY'
  /** One execution can back only one leg. */
  | 'DUPLICATE_EXECUTION'
  /** A replay must reuse the exact key and the exact bytes of the first attempt. */
  | 'REPLAY_MISMATCH'
  /** A second attempt was begun while an earlier one is still unresolved. */
  | 'OPEN_SIDE_EFFECT'
  /** No such attempt, or it is already resolved. */
  | 'UNKNOWN_SIDE_EFFECT'
  /** A stream cursor may only move forward. */
  | 'CURSOR_REWIND'
  /** The database was written by a newer runtime; writing it would corrupt it. */
  | 'SCHEMA_TOO_NEW'
  /** Secret-shaped material was about to be written to the job store. */
  | 'SECRET_REJECTED'
  /** A required field is missing or malformed. */
  | 'INVALID_INPUT';

export class JobStoreError extends Error {
  override readonly name = 'JobStoreError';

  constructor(
    readonly code: JobStoreErrorCode,
    message: string,
    readonly detail?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}

export const isJobStoreError = (value: unknown): value is JobStoreError =>
  value instanceof JobStoreError;
