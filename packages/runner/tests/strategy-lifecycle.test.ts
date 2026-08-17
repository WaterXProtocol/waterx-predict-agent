/**
 * The ADR-0004 decision table, exhaustively.
 *
 * Every case is written out rather than derived, because the interesting part is
 * the asymmetry — a market that stopped quoting pauses, a market that will never
 * quote again ends — and a loop that computed the expected answer would just
 * restate the implementation.
 */
import type { PredictMarketStatus } from '@waterx/predict-agent-sdk';

import { classifyMarket, type MarketVerdict } from '../src/strategy/lifecycle.ts';

const TABLE: ReadonlyArray<readonly [PredictMarketStatus, boolean, MarketVerdict]> = [
  ['PREGAME', true, { disposition: 'RUNNABLE', reason: 'TRADEABLE' }],
  ['PREGAME', false, { disposition: 'PAUSE', reason: 'NOT_TRADEABLE' }],
  ['IN_PLAY', true, { disposition: 'RUNNABLE', reason: 'TRADEABLE' }],
  ['IN_PLAY', false, { disposition: 'PAUSE', reason: 'NOT_TRADEABLE' }],
  // Terminal regardless of `tradeable`: a closed or resolved market that still
  // reports itself tradeable is a server bug, and waiting on it is worse.
  ['CLOSED', true, { disposition: 'TERMINAL', reason: 'MARKET_CLOSED' }],
  ['CLOSED', false, { disposition: 'TERMINAL', reason: 'MARKET_CLOSED' }],
  ['RESOLVED', true, { disposition: 'TERMINAL', reason: 'MARKET_RESOLVED' }],
  ['RESOLVED', false, { disposition: 'TERMINAL', reason: 'MARKET_RESOLVED' }],
];

describe('classifyMarket', () => {
  it.each(TABLE)('%s tradeable=%s', (status, tradeable, expected) => {
    expect(classifyMarket({ status, tradeable })).toEqual(expected);
  });

  it('pauses on a status this build has never heard of, rather than ending the job', () => {
    // A server that adds a status must not silently kill live strategies on
    // Runners that predate it. Pausing costs time the job already had a bound on.
    const future = 'SUSPENDED' as PredictMarketStatus;
    expect(classifyMarket({ status: future, tradeable: false })).toEqual({
      disposition: 'PAUSE',
      reason: 'UNKNOWN_STATUS',
    });
    expect(classifyMarket({ status: future, tradeable: true })).toEqual({
      disposition: 'PAUSE',
      reason: 'UNKNOWN_STATUS',
    });
  });

  it('never reads the free-text reason', () => {
    // ADR-0004: `tradeabilityReason` is an open set written for people. Two
    // markets that differ only in that string must classify identically, or a
    // copy edit on the server becomes a control-flow change on every Runner.
    const halted = {
      status: 'IN_PLAY' as const,
      tradeable: false,
      tradeabilityReason: 'halted for review',
    };
    const unavailable = { ...halted, tradeabilityReason: 'Market temporarily unavailable.' };
    expect(classifyMarket(halted)).toEqual(classifyMarket(unavailable));
  });
});
