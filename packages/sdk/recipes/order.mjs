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
 *                          [--dry-run] [--json]
 *
 * BUY sizes in wxUSD. SELL sizes in SHARES and needs the positionId. They are
 * not interchangeable and the API will not guess which you meant.
 *
 * An option this does not recognise is REFUSED, not ignored. `--dry-run` that
 * fell through a filter and left the order to go out anyway is the reason.
 */
import { isPredictAgentApiError, isUnresolvedWrite, describeQuoteCost } from '@waterx/predict-agent-sdk';

import { connect, emit, emitError, out, parseArgv } from './_client.mjs';

const { positionals, options } = parseArgv({ '--dry-run': 'boolean' });
const [marketId, outcomeId, side, amount, bps, positionId] = positionals;
const dryRun = options['--dry-run'] === true;

if (!marketId || !outcomeId || !side || !amount || !bps) {
  out('usage: node recipes/order.mjs <marketId> <YES|NO> <BUY|SELL> <amount|shares> <maxSlippageBps> [positionId] [--dry-run] [--json]');
  emitError('USAGE');
  process.exit(2);
}
if (side !== 'BUY' && side !== 'SELL') {
  out(`Side must be BUY or SELL, not ${JSON.stringify(side)}.`);
  emitError('USAGE', { field: 'side' });
  process.exit(2);
}
if (side === 'SELL' && positionId === undefined) {
  out('A SELL names the position it is closing. Run `node recipes/positions.mjs` for the id.');
  emitError('USAGE', { field: 'positionId' });
  process.exit(2);
}

// Decimal STRINGS, never numbers — a JSON number here is a rounding decision
// nobody made deliberately.
const size = side === 'BUY' ? { buyAmount: String(amount) } : { sellShares: String(amount) };

const client = await connect();
const diagnosis = await client.diagnose();
if (!diagnosis.ready) {
  out(`Not placing anything: ${diagnosis.writes.status} — ${diagnosis.writes.detail}`);
  emitError('NOT_READY', { writes: diagnosis.writes, authorizationUrl: diagnosis.authorizationUrl });
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

if (dryRun) {
  out('');
  out('--- --dry-run: nothing was sent ---');
  emit({ dryRun: true, cost, market: { marketId, title: market.title, status: market.status } });
  process.exit(0);
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

  out(`executionId : ${result.executionId}`);
  out(`status      : ${result.status}  (terminal: ${result.terminal}, timedOut: ${result.timedOut})`);
  out(`key         : ${result.idempotencyKey}${result.idempotencyKeyReplayed ? '  (REPLAYED — this intent had been attempted before)' : ''}`);
  out(`enforced    : ${result.enforcedWorstPrice}`);
  if (result.fill !== undefined) out(`fill        : ${JSON.stringify(result.fill)}`);
  if (result.remainingAllowance !== undefined) out(`allowance   : ${result.remainingAllowance}`);
  if (!result.fee.available) {
    out(`fee         : none reportable — ${result.fee.reason}. Do not compute one.`);
  }
  // Classified BEFORE anything reaches stdout. Emitting the result first and
  // the failure afterwards left a caller holding `{ ok: true }` next to exit 4
  // — the suppressor kept stdout parseable and the document still said the
  // wrong thing.
  if (result.timedOut) {
    out('');
    out('The wait expired. The order is LIVE, not failed. Run `node recipes/reconcile.mjs`.');
    emitError('WAIT_EXPIRED', { result, cost });
    process.exitCode = 4;
  } else {
    emit({ result, cost });
  }
} catch (error) {
  if (isUnresolvedWrite(error)) {
    // The one case that must never be retried under a new key.
    out('');
    out('UNRESOLVED — the outcome is unknown, which is not the same as failed.');
    out(`  executionId: ${error.executionId ?? '(none recorded)'}`);
    out(`  key        : ${error.idempotencyKey}`);
    out('  Run `node recipes/reconcile.mjs`. Read it back; never resend under a new key.');
    emitError('UNRESOLVED_WRITE', {
      executionId: error.executionId ?? null,
      idempotencyKey: error.idempotencyKey,
    });
    process.exitCode = 5;
  } else if (isPredictAgentApiError(error)) {
    out('');
    out(`REFUSED ${error.code}: ${error.message}`);
    out(`  retryable: ${error.retryable}`);
    if (error.details !== undefined) out(`  details  : ${JSON.stringify(error.details)}`);
    emitError(error.code, {
      message: error.message,
      retryable: error.retryable,
      httpStatus: error.httpStatus,
      details: error.details ?? null,
    });
    process.exitCode = 6;
  } else {
    throw error;
  }
}
