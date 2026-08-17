/**
 * The durable job state machine (plan §6.4, backlog 0.5).
 *
 * The shape comes from the plan:
 *
 *   DRAFT → WATCHING → TRIGGERED → QUOTING → CREATING → AWAITING_SIGNATURE
 *         → SUBMITTING → SUBMITTED → RECONCILING → FILLED | FAILED | CANCELLED | EXPIRED
 *
 * plus `PAUSED` (ADR-0004) and `UNKNOWN_PENDING`. Three properties in here are
 * load-bearing and none of them is obvious from that line:
 *
 * 1. **A job cannot be cancelled or expired out from under an in-flight write.**
 *    Once `CREATING` is entered an order may exist on the server, and declaring
 *    the job CANCELLED would report a stop that did not happen (ADR-0001 §15).
 *    From `CREATING` through `SUBMITTED` the only exits are forward, to a
 *    failure the server itself reported, or to `UNKNOWN_PENDING`.
 * 2. **`UNKNOWN_PENDING` has exactly one exit: `RECONCILING`.** It means the
 *    Runner lost the ability to confirm, not that nothing happened. Re-entering
 *    `QUOTING` from there would mint a second intent for one logical order.
 * 3. **Entering a state that can produce a side effect requires a persisted
 *    leg.** The idempotency key is written before the request that uses it, so a
 *    crash in between is recoverable by replay rather than by guessing.
 */

export type JobState =
  | 'DRAFT'
  | 'WATCHING'
  | 'PAUSED'
  | 'TRIGGERED'
  | 'QUOTING'
  | 'CREATING'
  | 'AWAITING_SIGNATURE'
  | 'SUBMITTING'
  | 'SUBMITTED'
  | 'RECONCILING'
  | 'UNKNOWN_PENDING'
  | 'FILLED'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED';

/**
 * What leaving this state may do to the outside world.
 *
 * `WRITE` is the funds-moving class: entering one of those states means the very
 * next thing that happens may create or submit an order.
 */
export type JobStateEffect = 'NONE' | 'READ' | 'SIGN' | 'WRITE';

export interface JobStateSpec {
  readonly terminal: boolean;
  readonly effect: JobStateEffect;
  /**
   * True when the state may not be entered until a leg — and therefore an
   * idempotency key — is durably persisted. This is the store-enforced half of
   * "persist before any external side effect" (plan §6.4).
   */
  readonly requiresLeg: boolean;
  /**
   * True when an order may already exist on the server. A job in one of these
   * states can never be declared CANCELLED or EXPIRED by a local decision.
   */
  readonly inFlight: boolean;
}

export const JOB_STATES: Readonly<Record<JobState, JobStateSpec>> = {
  DRAFT: { terminal: false, effect: 'NONE', requiresLeg: false, inFlight: false },
  WATCHING: { terminal: false, effect: 'READ', requiresLeg: false, inFlight: false },
  PAUSED: { terminal: false, effect: 'NONE', requiresLeg: false, inFlight: false },
  TRIGGERED: { terminal: false, effect: 'NONE', requiresLeg: false, inFlight: false },
  QUOTING: { terminal: false, effect: 'READ', requiresLeg: false, inFlight: false },
  CREATING: { terminal: false, effect: 'WRITE', requiresLeg: true, inFlight: true },
  AWAITING_SIGNATURE: { terminal: false, effect: 'SIGN', requiresLeg: true, inFlight: true },
  SUBMITTING: { terminal: false, effect: 'WRITE', requiresLeg: true, inFlight: true },
  SUBMITTED: { terminal: false, effect: 'READ', requiresLeg: true, inFlight: true },
  RECONCILING: { terminal: false, effect: 'READ', requiresLeg: true, inFlight: true },
  UNKNOWN_PENDING: { terminal: false, effect: 'NONE', requiresLeg: true, inFlight: true },
  FILLED: { terminal: true, effect: 'NONE', requiresLeg: true, inFlight: false },
  FAILED: { terminal: true, effect: 'NONE', requiresLeg: false, inFlight: false },
  CANCELLED: { terminal: true, effect: 'NONE', requiresLeg: false, inFlight: false },
  EXPIRED: { terminal: true, effect: 'NONE', requiresLeg: false, inFlight: false },
};

/**
 * The complete edge set. Anything absent is refused — the machine is a closed
 * allowlist, because a state chart that quietly permits an unlisted edge is a
 * state chart nobody can reason about after a crash.
 */
export const JOB_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  DRAFT: ['WATCHING', 'CANCELLED', 'EXPIRED', 'FAILED'],
  WATCHING: ['TRIGGERED', 'PAUSED', 'CANCELLED', 'EXPIRED', 'FAILED'],
  // ADR-0004: temporary unavailability pauses; closed/settled/cancelled is
  // terminal. Resuming means going back to WATCHING, never skipping ahead.
  PAUSED: ['WATCHING', 'CANCELLED', 'EXPIRED', 'FAILED'],
  // A re-check that no longer holds returns to WATCHING. Nothing has been sent.
  TRIGGERED: ['QUOTING', 'WATCHING', 'PAUSED', 'CANCELLED', 'EXPIRED', 'FAILED'],
  // The target is re-verified against the fresh quote; failing that is a return
  // to WATCHING, not an order at a worse price (ADR-0001 §14).
  QUOTING: ['CREATING', 'WATCHING', 'PAUSED', 'CANCELLED', 'EXPIRED', 'FAILED'],
  // From here on: no CANCELLED, no EXPIRED. An order may exist.
  // RECONCILING is reachable from CREATING because a crash can land between the
  // create succeeding and the state that says so: the execution exists, and the
  // only safe next act is to read it back.
  CREATING: ['AWAITING_SIGNATURE', 'RECONCILING', 'FAILED', 'UNKNOWN_PENDING'],
  AWAITING_SIGNATURE: ['SUBMITTING', 'RECONCILING', 'FAILED', 'UNKNOWN_PENDING'],
  SUBMITTING: ['SUBMITTED', 'RECONCILING', 'FAILED', 'UNKNOWN_PENDING'],
  SUBMITTED: ['RECONCILING', 'UNKNOWN_PENDING'],
  // RECONCILING is the only place a terminal fact is admitted, because it is the
  // only place that read one from the server. CREATING is reachable again only
  // to replay the SAME key after a reconcile proved no execution exists; WATCHING
  // only when the reconcile proved nothing was ever sent.
  RECONCILING: [
    'FILLED',
    'FAILED',
    'CANCELLED',
    'EXPIRED',
    'UNKNOWN_PENDING',
    'CREATING',
    'SUBMITTING',
    'WATCHING',
  ],
  UNKNOWN_PENDING: ['RECONCILING'],
  FILLED: [],
  FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export const isTerminalJobState = (state: JobState): boolean => JOB_STATES[state].terminal;

export const isInFlightJobState = (state: JobState): boolean => JOB_STATES[state].inFlight;

export const canTransition = (from: JobState, to: JobState): boolean =>
  JOB_TRANSITIONS[from].includes(to);

/**
 * States from which a local decision — a user cancel, or the clock passing
 * `expiresAt` — may still end the job. Deliberately derived from `inFlight`
 * rather than listed twice: the two must never drift apart.
 */
export const canEndLocally = (state: JobState): boolean =>
  !JOB_STATES[state].terminal && !JOB_STATES[state].inFlight;
