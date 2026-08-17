/**
 * What a durable job is made of.
 *
 * Everything the plan requires to be persisted before an external side effect
 * (§6.4) has a field here: job/strategy identity, owner/account/agent wallet,
 * the normalized intent, the trigger, the policy snapshot, the idempotency key,
 * the quote IDs, the execution ID and both transaction digests, the stream
 * cursor, the last heartbeat, and the transition audit log.
 *
 * What is deliberately NOT here: the sponsored transaction bytes, the signature,
 * the auth token and any key material. A job store that held them would be a
 * second copy of the signer's secrets sitting on disk, and ADR-0001 §7 says the
 * job store must not contain one. A replay proves it is replaying identical
 * bytes with `requestFingerprint`, a digest, instead.
 */
import type {
  DecimalString,
  Iso8601,
  PredictOutcomeId,
  PredictSide,
  PriceString,
} from '@waterx/predict-agent-sdk';

import type { JobState } from './state-machine.ts';

/** A Runner process, as seen by everything sharing its store. */
export interface RunnerInstance {
  readonly instanceId: string;
  readonly pid: number;
  readonly host: string;
  readonly startedAt: Iso8601;
  /**
   * Product-visible state, not a diagnostic: with a self-hosted local Runner, a
   * stale heartbeat is the difference between "this strategy is monitored" and
   * "this strategy is not" (ADR-0001 §6).
   */
  readonly heartbeatAt: Iso8601;
  readonly stoppedAt: Iso8601 | null;
}

/**
 * How a leg's size was decided, and whether it is still open to change.
 *
 * ADR-0001 §13 makes the frozen share count the *default* reading of "sell half",
 * and this discriminant is what keeps that structural rather than conventional.
 * A stored leg either carries an absolute size or names, in a shape nothing else
 * has, the one mode that deliberately re-evaluates later:
 *
 *   - `ABSOLUTE` — the caller gave a share count or a budget. Nothing to resolve.
 *   - `FROZEN_FRACTION` — the caller said "half", and half of the position *as it
 *     was at creation* is already computed into `sellShares`. The fraction and the
 *     share count it was taken from are kept for the audit, not for arithmetic:
 *     a position that grows afterwards does not enlarge this order.
 *   - `DYNAMIC_FRACTION` — the caller explicitly asked for the fraction to be
 *     re-read at trigger time, so `sellShares` is ABSENT until then. This is the
 *     mode that sells more than the owner had in mind when the position moved, so
 *     it is never reachable by wording, only by a distinct field (D-15).
 */
export type JobLegSizing =
  | { readonly kind: 'ABSOLUTE' }
  | {
      readonly kind: 'FROZEN_FRACTION';
      readonly fraction: DecimalString;
      /** The position's share count at creation, from an authoritative read. */
      readonly positionSharesAtCreation: DecimalString;
      readonly frozenAt: Iso8601;
    }
  | { readonly kind: 'DYNAMIC_FRACTION'; readonly fraction: DecimalString };

/**
 * One leg's normalized intent, frozen at job creation.
 *
 * The size is absolute for every mode but `DYNAMIC_FRACTION`, which is the whole
 * point of the discriminant above: a reader that ignores `sizing` and finds
 * `sellShares` is looking at a number that will not change, and a leg whose share
 * count is still open cannot be mistaken for one, because it has none.
 */
export interface JobLegIntent {
  readonly marketId: string;
  readonly outcomeId: PredictOutcomeId;
  readonly side: PredictSide;
  /** BUY commits a budget; SELL closes shares. Never both (ADR-0001 §11). */
  readonly buyAmount?: DecimalString;
  /** Absent only for `DYNAMIC_FRACTION`, where it is resolved at trigger time. */
  readonly sellShares?: DecimalString;
  /** Required for SELL: which on-chain position is being closed. */
  readonly positionId?: string;
  readonly maxSlippageBps: number;
  readonly worstAcceptablePrice?: PriceString;
  /**
   * Absent on records written before sizing was explicit; read as `ABSOLUTE`,
   * which is what those legs are — they could only carry an absolute size.
   */
  readonly sizing?: JobLegSizing;
}

/**
 * When the job may act. A BUY target is a ceiling, a SELL target a floor.
 *
 * The watched market is part of the trigger rather than inferred from the legs at
 * trigger time. A multi-leg job may watch one market and trade another, and
 * re-deriving "the market" from a leg list would silently pick a different one as
 * soon as a job has more than one — ADR-0004 also requires the resolved market
 * identity to be persisted rather than re-resolved from a name.
 */
export interface JobTrigger {
  readonly kind: 'IMMEDIATE' | 'PRICE';
  readonly targetPrice?: PriceString;
  /** Which side of the book is watched: BUY watches ask, SELL watches bid. */
  readonly observe?: 'ASK' | 'BID';
  /** Absent for `IMMEDIATE`, and on records written before it was persisted. */
  readonly marketId?: string;
  readonly outcomeId?: PredictOutcomeId;
  /** The side the target is read as: a BUY ceiling or a SELL floor. */
  readonly side?: PredictSide;
}

/**
 * The policy in force when the job was created, captured so a later audit can
 * tell what was authorized. It is a record, never the authorization itself —
 * ADR-0001 §14 requires delegation, risk and position to be re-read at trigger
 * time rather than trusted from here.
 */
export interface JobPolicySnapshot {
  readonly mode: 'interactive' | 'delegated-auto' | 'read-only';
  readonly source: string;
  readonly maxOrderNotional?: DecimalString;
  readonly maxRunNotional?: DecimalString;
  readonly notAfter?: Iso8601;
}

export interface JobRecord {
  readonly jobId: string;
  readonly strategyId: string;
  readonly ownerAddress: string;
  readonly accountId: string;
  readonly agentWallet: string;
  readonly state: JobState;
  readonly intent: readonly JobLegIntent[];
  readonly trigger: JobTrigger;
  readonly policy: JobPolicySnapshot;
  readonly createdAt: Iso8601;
  readonly updatedAt: Iso8601;
  /** Mandatory, capped at seven days by ADR-0005. Never extended. */
  readonly expiresAt: Iso8601;
  readonly leaseInstanceId: string | null;
  readonly leaseExpiresAt: Iso8601 | null;
  /**
   * Incremented on every claim. A writer holding an older fence has been
   * superseded and its write is refused — the defence against two Runner
   * instances on one store.
   */
  readonly leaseFence: number;
  readonly cancelRequestedAt: Iso8601 | null;
  readonly cancelReason: string | null;
  readonly terminalAt: Iso8601 | null;
}

/** How a leg ended, independently of every other leg (ADR-0001 §15). */
export type JobLegStatus = 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED' | 'UNKNOWN';

export interface JobLeg {
  readonly jobId: string;
  readonly legIndex: number;
  /** Minted once, before the first side effect, and reused for every replay. */
  readonly idempotencyKey: string;
  readonly intent: JobLegIntent;
  readonly status: JobLegStatus;
  readonly referenceQuoteId: string | null;
  readonly submissionQuoteId: string | null;
  readonly quotedAt: Iso8601 | null;
  readonly executionId: string | null;
  /** The agent's submit transaction — not the keeper's fill. */
  readonly submissionDigest: string | null;
  /** The keeper's fill transaction — not the agent's submit. */
  readonly keeperDigest: string | null;
  readonly createdAt: Iso8601;
  readonly updatedAt: Iso8601;
}

/** The two external calls that can move funds, plus the read that confirms them. */
export type SideEffectKind = 'CREATE_EXECUTION' | 'SUBMIT_EXECUTION' | 'RECONCILE_EXECUTION';

/** How an attempt ended. `null` on the record means it never ended. */
export type SideEffectOutcome = 'SUCCEEDED' | 'FAILED' | 'ABANDONED';

/**
 * The ledger that makes "persist before the side effect" checkable after a
 * crash. A row with no outcome is the whole point: it says a request may have
 * left this process and nothing observed what came back.
 */
export interface SideEffectAttempt {
  readonly attemptId: string;
  readonly jobId: string;
  readonly legIndex: number;
  readonly kind: SideEffectKind;
  readonly idempotencyKey: string;
  /**
   * A digest of the exact request bytes, never the bytes. Enough to prove a
   * replay is byte-identical without storing sponsored transaction bytes.
   */
  readonly requestFingerprint: string;
  readonly instanceId: string;
  readonly startedAt: Iso8601;
  readonly outcome: SideEffectOutcome | null;
  readonly outcomeAt: Iso8601 | null;
  readonly detail: Readonly<Record<string, unknown>> | null;
}

export interface JobTransitionRecord {
  readonly jobId: string;
  readonly seq: number;
  readonly fromState: JobState | null;
  readonly toState: JobState;
  readonly reason: string;
  readonly instanceId: string | null;
  readonly at: Iso8601;
  readonly detail: Readonly<Record<string, unknown>> | null;
}

/** A held claim on a job. Every mutating call carries one. */
export interface JobLease {
  readonly jobId: string;
  readonly instanceId: string;
  readonly fence: number;
  readonly expiresAt: Iso8601;
}
