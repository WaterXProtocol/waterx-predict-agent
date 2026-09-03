#!/usr/bin/env node
/**
 * One protected market order, with the cost stated before it is placed and the
 * idempotency key kept on disk.
 *
 * Everything load-bearing here is the SDK's, not this script's. The key is
 * reserved by the intent store the client was built with, so re-running this
 * with the SAME arguments replays the same key and cannot open a second order;
 * change any argument and it is a different intent and gets its own. That is
 * the part a caller used to have to invent, at the worst possible moment, and
 * the part where inventing it wrong costs money.
 *
 *   node recipes/order.mjs <marketId> <YES|NO> <BUY|SELL> <amount> <maxSlippageBps> [positionId]
 *
 * BUY sizes in wxUSD. SELL sizes in SHARES and needs the positionId. They are
 * not interchangeable and the API will not guess which you meant.
 */
import { isPredictAgentApiError, isUnresolvedWrite, describeQuoteCost } from '@waterx/predict-agent-sdk';

import { connect, emit, out } from './_client.mjs';

const [marketId, outcomeId, side, amount, bps, positionId] = process.argv
  .slice(2)
  .filter((value) => !value.startsWith('--'));

if (!marketId || !outcomeId || !side || !amount || !bps) {
  out('usage: node recipes/order.mjs <marketId> <YES|NO> <BUY|SELL> <amount|shares> <maxSlippageBps> [positionId]');
  process.exit(2);
}
if (side === 'SELL' && positionId === undefined) {
  out('A SELL names the position it is closing. Run `node recipes/positions.mjs` for the id.');
  process.exit(2);
}

// Decimal STRINGS, never numbers — a JSON number here is a rounding decision
// nobody made deliberately.
const size = side === 'BUY' ? { buyAmount: String(amount) } : { sellShares: String(amount) };

const client = await connect();
const diagnosis = await client.diagnose();
if (!diagnosis.ready) {
  out(`Not placing anything: ${diagnosis.writes.status} — ${diagnosis.writes.detail}`);
  process.exit(3);
}
const accountId = diagnosis.onboarding.account.accountId;

const { market } = await client.getMarket(marketId);
out(`market   : ${market.title}`);
out(`           ${market.marketId}`);
out(`status   : ${market.status} | tradeable: ${market.tradeable} | closes ${market.closesAt ?? '(no schedule)'}`);
out(`account  : ${accountId}`);
out(`intent   : ${side} ${outcomeId} ${amount} ${side === 'BUY' ? 'wxUSD' : 'shares'} | maxSlippageBps ${bps}`);

// A quote to price the disclosure. The ORDER mints its own, immediately before
// the create — a quote lives about three seconds and this one will be stale by
// the time anybody has read the output below.
const quote = await client.getQuote({ marketId, outcomeId, side, size });
const cost = describeQuoteCost(quote, {
  outcome: market.outcomes.find((entry) => entry.outcomeId === outcomeId),
  requestedSize: side === 'BUY' ? undefined : String(amount),
});

out('');
out(`price    : ${cost.expectedPrice}  (tier ${cost.liquidityTier}, ${quote.qualityFlags.join(', ') || 'no flags'})`);
if (cost.spread?.spreadBps != null) {
  out(`spread   : ${cost.spread.bid} / ${cost.spread.ask}  =  ${cost.spread.spreadBps} bps`);
}
if (cost.immediateMarkToMarketBps !== null) {
  out(`on entry : about ${cost.immediateMarkToMarketBps} bps down the moment it fills`);
}
out(`size     : ${cost.sizeConfidence}${cost.vouchedSize === null ? '' : ` (vouched ${cost.vouchedSize})`}`);
out(`fee      : ${cost.fee.available ? cost.fee.amount : `not reportable — ${cost.fee.basis}`}`);
for (const concern of cost.concerns) {
  out('');
  out(`  ! ${concern}`);
}

out('');
out('--- sending (the order mints its own fresh quote) ---');

try {
  const result = await client.executeMarketOrder(
    {
      accountId,
      marketId,
      outcomeId,
      side,
      size,
      maxSlippageBps: Number(bps),
      ...(positionId === undefined ? {} : { positionId }),
    },
    { waitFor: 'TERMINAL', timeoutMs: 90_000 },
  );

  emit({ result, cost });

  out(`executionId : ${result.executionId}`);
  out(`status      : ${result.status}  (terminal: ${result.terminal}, timedOut: ${result.timedOut})`);
  out(`key         : ${result.idempotencyKey}${result.idempotencyKeyReplayed ? '  (REPLAYED — this intent had been attempted before)' : ''}`);
  out(`enforced    : ${result.enforcedWorstPrice}`);
  if (result.fill !== undefined) out(`fill        : ${JSON.stringify(result.fill)}`);
  if (result.remainingAllowance !== undefined) out(`allowance   : ${result.remainingAllowance}`);
  if (!result.fee.available) {
    out(`fee         : none reportable — ${result.fee.reason}. Do not compute one.`);
  }
  if (result.timedOut) {
    out('');
    out('The wait expired. The order is LIVE, not failed. Run `node recipes/reconcile.mjs`.');
    process.exitCode = 4;
  }
} catch (error) {
  if (isUnresolvedWrite(error)) {
    // The one case that must never be retried under a new key.
    out('');
    out('UNRESOLVED — the outcome is unknown, which is not the same as failed.');
    out(`  executionId: ${error.executionId ?? '(none recorded)'}`);
    out(`  key        : ${error.idempotencyKey}`);
    out('  Run `node recipes/reconcile.mjs`. Read it back; never resend under a new key.');
    process.exitCode = 5;
  } else if (isPredictAgentApiError(error)) {
    out('');
    out(`REFUSED ${error.code}: ${error.message}`);
    out(`  retryable: ${error.retryable}`);
    if (error.details !== undefined) out(`  details  : ${JSON.stringify(error.details)}`);
    process.exitCode = 6;
  } else {
    throw error;
  }
}
