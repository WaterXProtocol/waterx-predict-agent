/**
 * The checks that run at the trigger, before anything is quoted or sent.
 *
 * ADR-0001 §14: a strategy armed hours ago may not act on what was true when it
 * was armed. Delegation, the owner's risk profile, the market's lifecycle and the
 * position a percentage SELL is a percentage *of* are all re-read here, fresh,
 * every time — the `JobPolicySnapshot` on the record is an audit trail of what was
 * authorized then, never an authorization now.
 *
 * The hard part is not the reading, it is what each answer means. Everything in
 * this module sorts into three verdicts, and the difference between them is
 * whether the job can come back:
 *
 *   - **PAUSE** — not now, possibly later. Under the ORIGINAL `expiresAt`, which
 *     is never extended, and against the ORIGINAL market, which is never swapped
 *     (ADR-0004, ADR-0005). Every transient condition lands here: an unreadable
 *     chain, an exhausted hourly budget, a suspended profile, a halted market.
 *   - **STOP** — this strategy will not act again, so it ends rather than sitting
 *     in a state its owner would read as live. Reserved for facts that do not
 *     reverse themselves: an explicit revocation, a closed or resolved market, a
 *     local mandate that has run out, and an approval mode no unattended process
 *     can ever satisfy.
 *   - **PROCEED** — with a per-leg plan, in which a leg may be individually
 *     skipped. Legs are independent (ADR-0001 §15), so one leg's position having
 *     vanished must not cancel the leg beside it.
 *
 * `null` is never read as "no". The contract is explicit that a null delegation
 * permission means THE CHAIN READ FAILED, and collapsing that into denial would
 * tear down a healthy strategy over an RPC blip. It pauses.
 */
import { compareDecimal, type PredictEffectiveLimitsResponseBody } from '@waterx/predict-agent-sdk';

import type { JobLegIntent, JobRecord } from '../job.ts';
import type { StrategyGateway } from './gateway.ts';
import { sharesForFraction } from './intent.ts';
import { classifyMarket } from './lifecycle.ts';
import { findPosition } from './positions.ts';

/** Why a job pauses. Closed set: each one is a condition that can reverse. */
export type PreflightPauseReason =
  /** A delegation permission read as `null` — the chain read failed, not a denial. */
  | 'DELEGATION_UNREADABLE'
  /** No owner has granted this agent a mandate yet. One may be granted. */
  | 'NO_MANDATE'
  /** The owner's kill switch. Lifting it is a write the owner can make. */
  | 'SUSPENDED'
  /** The server's own list of reasons it would refuse a write right now. */
  | 'BLOCKED'
  /** The market is not tradeable but has not ended. */
  | 'MARKET_NOT_TRADEABLE'
  /** A market status this build does not recognize. Pause, never end (ADR-0004). */
  | 'MARKET_STATUS_UNKNOWN'
  /**
   * A policy mode this build does not recognize, from a store a newer build
   * wrote. Paused rather than ended, for ADR-0004's reason: the build that
   * understands the mode may be the next one to start, and a job ended here
   * cannot be brought back by installing it.
   */
  | 'POLICY_MODE_UNRECOGNIZED'
  /** A position read that the server never proved complete. Not "you hold none". */
  | 'POSITION_UNVERIFIED';

/** Why a job ends. Closed set: each one is a fact that does not reverse. */
export type PreflightStopReason =
  /** The owner revoked the permission this job needs. */
  | 'DELEGATION_REVOKED'
  /** The local delegated-auto mandate ran out while the job was armed. */
  | 'POLICY_EXPIRED'
  /**
   * The job was admitted under `read-only`. Creation refuses this, so reaching
   * it means a record written by an older build or by something that skipped
   * normalization — and a read-only job will not become signable by waiting.
   */
  | 'POLICY_READ_ONLY'
  /**
   * The job was admitted under `interactive`, the default approval mode. An
   * unattended Runner has nobody to ask, and it will not have anyone to ask
   * tomorrow either, so the job ends rather than watching a price for seven days
   * and refusing at the signer when the target is finally met.
   */
  | 'POLICY_REQUIRES_APPROVAL'
  | 'MARKET_CLOSED'
  | 'MARKET_RESOLVED';

/** Why one leg is passed over while its siblings go ahead. */
export type LegSkipReason =
  /** The position a dynamic fraction is a fraction of is gone. Proven, not assumed. */
  | 'POSITION_GONE'
  /** The position exists but names a different market or outcome than the leg. */
  | 'POSITION_MISMATCH'
  /** The fraction of what is held truncates to nothing. */
  | 'FRACTION_RESOLVES_TO_ZERO'
  /** The order is larger than the local policy that admitted the job allows. */
  | 'EXCEEDS_POLICY_ORDER_LIMIT'
  /** The fresh quote is worse than this leg's own absolute bound. */
  | 'PRICE_WORSE_THAN_BOUND'
  /** The executable quote does not meet the target the indicative price did. */
  | 'TARGET_NO_LONGER_MET'
  /** The quote was already past its own `expiresAt` when it arrived. */
  | 'QUOTE_EXPIRED'
  /**
   * The job's own `expiresAt` passed while this leg sat unsent after a crash. The
   * expiry cannot end the job — a sibling's order is on the server and only the
   * server may end that — but it does end this leg's chance to be part of the run.
   */
  | 'EXPIRED_BEFORE_SENT'
  /**
   * A fresh check refused the whole job on the pass that would have sent this
   * leg — a revoked delegation, a closed market, a mandate that ran out. The
   * `detail` carries which. Its siblings had already traded, so the job cannot
   * simply stop; this leg is the part of the run that does not happen.
   */
  | 'REFUSED_ON_RESUME';

export interface LegSkip {
  readonly reason: LegSkipReason;
  /**
   * Whether this same leg could qualify on a later pass.
   *
   * The distinction decides what the JOB does when every leg is skipped: a job
   * whose legs were all skipped for a retryable reason goes back to watching,
   * and one whose legs can never qualify ends instead of watching a price it
   * would refuse to act on for the next seven days.
   */
  readonly retryable: boolean;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface PreparedLeg {
  readonly legIndex: number;
  /** Resolved: a dynamic fraction has become an absolute share count by now. */
  readonly intent: JobLegIntent;
  readonly skip?: LegSkip;
}

export type PreflightVerdict =
  | { readonly kind: 'PROCEED'; readonly legs: readonly PreparedLeg[] }
  | {
      readonly kind: 'PAUSE';
      readonly reason: PreflightPauseReason;
      readonly detail: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: 'STOP';
      readonly reason: PreflightStopReason;
      readonly detail: Readonly<Record<string, unknown>>;
    };

export interface PreflightInput {
  readonly job: JobRecord;
  readonly gateway: StrategyGateway;
  /** The instant the pass is running at, for the policy's `notAfter`. */
  readonly at: string;
  readonly signal?: AbortSignal;
}

/**
 * Run every fresh check, in the order that costs the least to fail.
 *
 * Authorization first, then the market, then positions: an agent whose mandate
 * was revoked should discover that before it reads a market it may not trade,
 * and a market that closed should be found before an account is paged for a
 * position nobody can sell into it.
 */
export const preflight = async (input: PreflightInput): Promise<PreflightVerdict> => {
  const { job } = input;

  const local = checkLocalPolicy(job, input.at);
  if (local !== undefined) return local;

  const limits = await input.gateway.getEffectiveLimits(job.accountId, input.signal);
  const authorization = classifyAuthorization(limits, permissionsNeeded(job.intent));
  if (authorization !== undefined) return authorization;

  const markets = await checkMarkets(input);
  if (markets !== undefined) return markets;

  return await resolveLegs(input);
};

/* ── The local mandate ─────────────────────────────────────────────────────── */

/**
 * The policy snapshot, re-read against the clock.
 *
 * This is the only part of the snapshot that is an authorization rather than an
 * audit record, and only in one direction: `notAfter` can pass, and a scope that
 * has run out is a scope the owner declined to extend. It cannot widen anything —
 * the server's effective limits are checked separately and always win.
 *
 * The MODE is checked here too, and first, because it is the cheapest question in
 * the whole pass and the only one whose answer is knowable without a network
 * call. `createExternalCommandSigner` refuses the same three cases independently
 * (`src/signer.ts`), and that is the check that cannot be skipped — but a job
 * refused only there would already have quoted, created executions and reserved
 * allowance for orders it could never authorize. This is where it costs nothing.
 *
 * Exported because the driver calls it once more, ahead of the watch pass, so a
 * job that can never authorize a write is not even watched. Both callers share
 * this one function rather than each spelling the rule out: two copies of an
 * authority check are two chances to disagree about who may move money.
 */
export const checkLocalPolicy = (job: JobRecord, at: string): PreflightVerdict | undefined => {
  const mode: string = job.policy.mode;
  const modeDetail = { mode, source: job.policy.source };
  if (mode === 'read-only') {
    return { kind: 'STOP', reason: 'POLICY_READ_ONLY', detail: modeDetail };
  }
  if (mode === 'interactive') {
    return { kind: 'STOP', reason: 'POLICY_REQUIRES_APPROVAL', detail: modeDetail };
  }
  if (mode !== 'delegated-auto') {
    return { kind: 'PAUSE', reason: 'POLICY_MODE_UNRECOGNIZED', detail: modeDetail };
  }

  const notAfter = job.policy.notAfter;
  if (notAfter === undefined) return undefined;
  if (Date.parse(notAfter) > Date.parse(at)) return undefined;
  return {
    kind: 'STOP',
    reason: 'POLICY_EXPIRED',
    detail: { notAfter, at, source: job.policy.source, mode: job.policy.mode },
  };
};

/* ── Authorization ─────────────────────────────────────────────────────────── */

export interface PermissionsNeeded {
  /** Some leg BUYs, so `mayPlaceOrder` is required. */
  readonly place: boolean;
  /** Some leg SELLs, so `mayRequestClose` is required. */
  readonly close: boolean;
}

export const permissionsNeeded = (legs: readonly JobLegIntent[]): PermissionsNeeded => ({
  place: legs.some((leg) => leg.side === 'BUY'),
  close: legs.some((leg) => leg.side === 'SELL'),
});

/**
 * The server's answer about this agent, turned into a verdict.
 *
 * Only the permissions the job's legs actually need are consulted. A SELL-only
 * strategy is not stopped because the owner never granted an open-position
 * mandate it was never going to use.
 *
 * Revocation is the one STOP here, and it is deliberate. Pausing on a revoke
 * would leave a job that fires the instant a permission is granted back for some
 * unrelated reason, hours after the owner acted to stop it — the owner's act is
 * the fact, and this job is not the thing to reinterpret it.
 */
export const classifyAuthorization = (
  limits: PredictEffectiveLimitsResponseBody,
  needs: PermissionsNeeded,
): PreflightVerdict | undefined => {
  const { delegation } = limits;
  const required = [
    ...(needs.place ? ([['mayPlaceOrder', delegation.mayPlaceOrder]] as const) : []),
    ...(needs.close ? ([['mayRequestClose', delegation.mayRequestClose]] as const) : []),
  ];

  const revoked = required.filter(([, granted]) => granted === false).map(([name]) => name);
  if (revoked.length > 0) {
    return {
      kind: 'STOP',
      reason: 'DELEGATION_REVOKED',
      detail: { revoked, checkedAt: delegation.checkedAt },
    };
  }
  const unreadable = required.filter(([, granted]) => granted === null).map(([name]) => name);
  if (unreadable.length > 0) {
    return {
      kind: 'PAUSE',
      reason: 'DELEGATION_UNREADABLE',
      detail: { unreadable, checkedAt: delegation.checkedAt },
    };
  }

  if (limits.limits === null) {
    // Absence is denial for the purpose of writing, and recoverable for the
    // purpose of waiting: an owner who has not granted a mandate yet may.
    return { kind: 'PAUSE', reason: 'NO_MANDATE', detail: { asOf: limits.asOf } };
  }
  if (limits.limits.isSuspended) {
    return {
      kind: 'PAUSE',
      reason: 'SUSPENDED',
      detail: { policyVersion: limits.limits.policyVersion, asOf: limits.asOf },
    };
  }
  if (limits.blockers.length > 0) {
    // The server's own closed set, forwarded verbatim. Re-deriving these from the
    // limits and the usage window would produce a second opinion that disagrees
    // with the one the write path will actually apply.
    return {
      kind: 'PAUSE',
      reason: 'BLOCKED',
      detail: { blockers: limits.blockers, asOf: limits.asOf },
    };
  }
  return undefined;
};

/* ── Market lifecycle ──────────────────────────────────────────────────────── */

/** Every market this job touches: the one it watches and the ones it trades. */
export const marketsInvolved = (job: JobRecord): readonly string[] => [
  ...new Set([
    ...(job.trigger.marketId === undefined ? [] : [job.trigger.marketId]),
    ...job.intent.map((leg) => leg.marketId),
  ]),
];

/**
 * ADR-0004 applied to every market the job touches.
 *
 * A terminal market ends the WHOLE job, even when other legs could still trade.
 * A chain of orders is one thing the owner armed, and executing the half of it
 * that survives is a different strategy from the one they described — while
 * quietly waiting on a market that will never quote again is a strategy they
 * believe is live. Ending, and saying which market ended it, is the only option
 * that reports what happened.
 */
export const checkMarkets = async (
  input: PreflightInput,
): Promise<PreflightVerdict | undefined> => {
  for (const marketId of marketsInvolved(input.job)) {
    const { market } = await input.gateway.getMarket(marketId, input.signal);
    const verdict = classifyMarket(market);
    if (verdict.disposition === 'RUNNABLE') continue;
    const detail = {
      marketId,
      status: market.status,
      tradeable: market.tradeable,
      // Free text, carried for a human to read and never branched on.
      ...(market.tradeabilityReason === undefined
        ? {}
        : { tradeabilityReason: market.tradeabilityReason }),
    };
    if (verdict.disposition === 'TERMINAL') {
      return {
        kind: 'STOP',
        reason: verdict.reason === 'MARKET_RESOLVED' ? 'MARKET_RESOLVED' : 'MARKET_CLOSED',
        detail,
      };
    }
    return {
      kind: 'PAUSE',
      reason: verdict.reason === 'UNKNOWN_STATUS' ? 'MARKET_STATUS_UNKNOWN' : 'MARKET_NOT_TRADEABLE',
      detail,
    };
  }
  return undefined;
};

/* ── Sizes ─────────────────────────────────────────────────────────────────── */

/**
 * Turn every leg into something with an absolute size, or a reason it is skipped.
 *
 * This is the resolution point the dynamic mode has been waiting for. A
 * `FROZEN_FRACTION` leg is deliberately untouched: its share count was decided at
 * creation against the position as it stood then, and re-reading it here would
 * quietly convert every percentage SELL into the dynamic mode D-15 exists to keep
 * separate.
 */
const resolveLegs = async (input: PreflightInput): Promise<PreflightVerdict> => {
  const prepared: PreparedLeg[] = [];

  for (const [legIndex, intent] of input.job.intent.entries()) {
    if (intent.sizing?.kind !== 'DYNAMIC_FRACTION') {
      prepared.push(withPolicyCheck({ legIndex, intent }, input.job));
      continue;
    }

    const positionId = intent.positionId;
    if (positionId === undefined) {
      // Normalization refuses a SELL without one, so this is a record written by
      // something that bypassed it. Skipped rather than guessed.
      prepared.push({
        legIndex,
        intent,
        skip: { reason: 'POSITION_GONE', retryable: false, detail: { missing: 'positionId' } },
      });
      continue;
    }

    const lookup = await findPosition(input.gateway, input.job.accountId, positionId, {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });

    if (!lookup.found) {
      if (!lookup.proven) {
        // The whole job pauses rather than this leg being skipped: an unproven
        // absence is not evidence about this leg, and skipping on it would drop
        // an order the owner armed because a page boundary moved.
        return {
          kind: 'PAUSE',
          reason: 'POSITION_UNVERIFIED',
          detail: { legIndex, positionId, pagesRead: lookup.pagesRead },
        };
      }
      prepared.push({
        legIndex,
        intent,
        skip: {
          reason: 'POSITION_GONE',
          retryable: false,
          detail: { positionId, pagesRead: lookup.pagesRead },
        },
      });
      continue;
    }

    const position = lookup.position;
    if (position.marketId !== intent.marketId || position.outcomeId !== intent.outcomeId) {
      prepared.push({
        legIndex,
        intent,
        skip: {
          reason: 'POSITION_MISMATCH',
          retryable: false,
          detail: {
            positionId,
            positionMarketId: position.marketId,
            positionOutcomeId: position.outcomeId,
          },
        },
      });
      continue;
    }
    if (position.shares === null) {
      // Null is not zero. The server said it does not know, which may change.
      return {
        kind: 'PAUSE',
        reason: 'POSITION_UNVERIFIED',
        detail: { legIndex, positionId, shares: null },
      };
    }

    const sellShares = sharesForFraction(position.shares, intent.sizing.fraction);
    if (sellShares === null) {
      prepared.push({
        legIndex,
        intent,
        skip: {
          reason: 'FRACTION_RESOLVES_TO_ZERO',
          retryable: false,
          detail: { positionId, fraction: intent.sizing.fraction, held: position.shares },
        },
      });
      continue;
    }

    prepared.push(withPolicyCheck({ legIndex, intent: { ...intent, sellShares } }, input.job));
  }

  return { kind: 'PROCEED', legs: prepared };
};

/**
 * The local per-order ceiling, applied to the size that will actually be sent.
 *
 * BUY only, and by design: `maxOrderNotional` bounds the money committed, and a
 * SELL commits none — it returns some. Bounding a SELL by it would refuse to let
 * a strategy close a position it is already exposed to.
 */
const withPolicyCheck = (leg: PreparedLeg, job: JobRecord): PreparedLeg => {
  const ceiling = job.policy.maxOrderNotional;
  const amount = leg.intent.buyAmount;
  if (ceiling === undefined || amount === undefined) return leg;
  if (compareDecimal(amount, ceiling) <= 0) return leg;
  return {
    ...leg,
    skip: {
      reason: 'EXCEEDS_POLICY_ORDER_LIMIT',
      // The ceiling is a local file the owner wrote; it will not raise itself
      // while the job watches, so waiting for it to would be waiting forever.
      retryable: false,
      detail: { buyAmount: amount, maxOrderNotional: ceiling, source: job.policy.source },
    },
  };
};
