/**
 * ADR-0004, as a decision table: may a job still act on this market?
 *
 * The rule the ADR insists on is that the answer comes from `status` and
 * `tradeable` and from nothing else. `tradeabilityReason` is free text — it exists
 * to be shown to a person, and pattern-matching English to decide whether a
 * strategy pauses or dies would make a copy edit on the server a control-flow
 * change on every Runner. When the backlog's B4 adds a closed set of codes, that
 * set can refine PAUSE; it cannot become the thing that detects it.
 *
 * The asymmetry between the two non-runnable answers is the whole point:
 *
 *   - PAUSE is recoverable. A halted or suspended market may quote again, so the
 *     job waits — still under its original `expiresAt`, which is never extended,
 *     and still bound to its original market, which is never swapped.
 *   - TERMINAL is not. A closed or resolved market will not quote again, and a
 *     job that keeps waiting on one is a strategy the owner believes is live.
 *
 * A status this build does not recognize is PAUSE, never TERMINAL. Pausing a job
 * that should have ended costs it time it already had a bound on; ending one that
 * could still have fired cannot be undone.
 *
 * NOTE: nothing calls this yet. The price watcher and executor that would act on
 * the verdict are not implemented (`docs/IMPLEMENTATION_BACKLOG.md` 2.6).
 */
import type { PredictMarketStatus } from '@waterx/predict-agent-sdk';

export type MarketDisposition =
  /** Quotable now; the job may go on watching or fire. */
  | 'RUNNABLE'
  /** Not quotable now, but it may be again. The job pauses and keeps its expiry. */
  | 'PAUSE'
  /** It will not quote again. The job ends. */
  | 'TERMINAL';

export type MarketDispositionReason =
  | 'TRADEABLE'
  | 'NOT_TRADEABLE'
  | 'MARKET_CLOSED'
  | 'MARKET_RESOLVED'
  | 'UNKNOWN_STATUS';

export interface MarketVerdict {
  readonly disposition: MarketDisposition;
  /** A closed set, unlike the server's free-text `tradeabilityReason`. */
  readonly reason: MarketDispositionReason;
}

/** The shape this reads, so a full market object is not required to ask. */
export interface MarketLifecycleFacts {
  readonly status: PredictMarketStatus;
  readonly tradeable: boolean;
}

export const classifyMarket = (market: MarketLifecycleFacts): MarketVerdict => {
  switch (market.status) {
    case 'CLOSED':
      return { disposition: 'TERMINAL', reason: 'MARKET_CLOSED' };
    case 'RESOLVED':
      return { disposition: 'TERMINAL', reason: 'MARKET_RESOLVED' };
    case 'PREGAME':
    case 'IN_PLAY':
      return market.tradeable
        ? { disposition: 'RUNNABLE', reason: 'TRADEABLE' }
        : { disposition: 'PAUSE', reason: 'NOT_TRADEABLE' };
    default:
      return { disposition: 'PAUSE', reason: 'UNKNOWN_STATUS' };
  }
};
