/**
 * What the account is carrying, said before anything else (ADR-0023).
 *
 * `next` knew all of this and said none of it. It read the positions and the
 * unsettled executions to decide a STATE, reported the state, and threw the
 * numbers away — so an agent could be told `READY` while the account held money
 * in a position nothing could price, or a BUY that had been sitting unfilled
 * for an hour with its escrow locked.
 *
 * Three rules, and they are the whole design:
 *
 * 1. **A pure function of what the caller already fetched.** No note costs a
 *    request. Anything that would need one belongs in a command a person can
 *    run, not in a line that rides on every answer.
 * 2. **They ride on EVERY state and change none of them.** A position nothing
 *    can price matters whether this runtime is `READY` or halfway through
 *    setup, and a note that could change the state would be a second state
 *    machine.
 * 3. **It refuses to measure what it cannot.** A portfolio value totalled over
 *    positions with no price is a guess wearing a currency sign, and `null` in
 *    a position's `currentPrice` or `unrealizedPnl` means "not known" — never
 *    zero, which would read as break-even (see `PredictPositionSummary`).
 */
import type { PredictExecutionSummary, PredictPositionSummary } from '@waterx/predict-agent-sdk';

import { formatDecimal, ONE, parseDecimal } from '../decimal.ts';

/** One thing worth knowing about the account, whatever state the runtime is in. */
export interface ExposureNote {
  /** Symbolic, so a host can branch without reading English. */
  readonly kind:
    | 'DEPLOYED'
    | 'UNPRICED_POSITION'
    | 'UNSETTLED_TOO_LONG'
    | 'BELOW_KEEPER_MINIMUM';
  readonly says: string;
  /** What to run to look closer. Runnable as printed, or absent. */
  readonly look?: string;
}

/**
 * The keeper cancels an open below this, and the order never fills (measured on
 * mainnet, order 38308: `below_min_fill`). A BUY sitting under it is not slow,
 * it is finished — and its escrow is held until it is cancelled.
 */
export const KEEPER_MIN_FILL_USD = 2;

/**
 * How long a submitted order may sit before it is worth saying so. The keeper's
 * fill grace is five minutes; past that, silence is a fact about the order
 * rather than about the clock.
 */
export const STALE_SUBMISSION_MS = 5 * 60_000;

const MINUTES = 60_000;

export function exposureNotes(
  positions: readonly PredictPositionSummary[],
  unsettled: readonly PredictExecutionSummary[],
  now: Date,
): ExposureNote[] {
  const notes: ExposureNote[] = [];

  if (positions.length > 0) {
    // Cost is always known; a live price is not. So the amount DEPLOYED is
    // reportable where a portfolio value is not, and they are different claims.
    let deployed = 0n;
    for (const position of positions) {
      deployed += parseDecimal(position.remainingCost) ?? 0n;
    }
    const unpriced = positions.filter((position) => position.currentPrice === null);
    notes.push({
      kind: 'DEPLOYED',
      says: `${String(positions.length)} position(s) hold ${formatDecimal(deployed)} wxUSD at cost.${
        unpriced.length === 0 ? '' : ` ${String(unpriced.length)} of them cannot be priced right now, so what they are worth is not a number this can give.`
      }`,
      look: 'waterx-predict account positions',
    });
    if (unpriced.length > 0) {
      notes.push({
        kind: 'UNPRICED_POSITION',
        says: `No live sell-side quote for ${String(unpriced.length)} position(s): their value and PnL are unknown, not zero. A market that stopped quoting is usually closed, resolved or paused — an exit may not be available at any price.`,
        look: 'waterx-predict market get',
      });
    }
  }

  for (const execution of unsettled) {
    const age = now.getTime() - Date.parse(execution.createdAt);
    if (Number.isNaN(age)) continue;
    const size = parseDecimal(execution.size);
    if (
      execution.side === 'BUY' &&
      size !== null &&
      size < BigInt(KEEPER_MIN_FILL_USD) * ONE
    ) {
      // Not slow — finished. Said as its own note because the remedy is
      // different: nothing will fill it, and the escrow comes back on cancel.
      notes.push({
        kind: 'BELOW_KEEPER_MINIMUM',
        says: `${execution.executionId} is a BUY of ${execution.size} wxUSD, below the keeper's ${String(KEEPER_MIN_FILL_USD)} wxUSD minimum fill. It will be cancelled rather than filled, and its escrow is held until it is.`,
        look: `waterx-predict order reconcile --executionId ${execution.executionId}`,
      });
      continue;
    }
    if (age > STALE_SUBMISSION_MS) {
      notes.push({
        kind: 'UNSETTLED_TOO_LONG',
        says: `${execution.executionId} was submitted ${String(Math.floor(age / MINUTES))} minutes ago and has not settled. Its escrow is held until it fills, is cancelled or expires — this is money that is neither a position nor a balance.`,
        look: `waterx-predict order reconcile --executionId ${execution.executionId}`,
      });
    }
  }

  return notes;
}
