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
 *                          [--account <id>] [--dry-run] [--json]
 *
 * `--account` PINS the account. Without it this trades whichever single account
 * is authorized right now, which is the convenient default and the wrong one
 * for a resumed intent: an idempotency key covers the account too, so if the
 * owner has since authorized a different one, the same arguments become a
 * different intent and a different key. `reconcile.mjs` always passes it.
 *
 * BUY sizes in wxUSD. SELL sizes in SHARES and needs the positionId. They are
 * not interchangeable and the API will not guess which you meant.
 *
 * An option this does not recognise is REFUSED, not ignored. `--dry-run` that
 * fell through a filter and left the order to go out anyway is the reason.
 *
 * WHAT THE EXIT CODE MEANS, because it used to mean less than it looked like.
 * `0` is a FILL and nothing else. A `CANCELLED`, `REJECTED` or `EXPIRED` order
 * is terminal and traded nothing, and this exited zero on all of them — four
 * times out of five orders in one re-test, with `status : CANCELLED` sitting
 * three lines into an otherwise ordinary-looking result. It now exits 7 and
 * says so in the first line a person reads.
 */
import {
  describeQuoteCost,
  dispositionOf,
  isPredictAgentApiError,
  isUnresolvedWrite,
} from '@waterx/predict-agent-sdk';

import { connect, emit, emitError, out, parseArgv } from './_client.mjs';

const { positionals, options } = parseArgv({
  '--dry-run': 'boolean',
  '--account': 'value',
  '--retry': 'boolean',
});
const [marketId, outcomeId, side, amount, bps, positionId] = positionals;
const dryRun = options['--dry-run'] === true;
/**
 * State a genuinely new attempt at an intent that already has an outcome.
 *
 * The key is content-addressed, so re-running the same arguments replays the
 * same key and returns the RECORDED result — for a filled order that is the
 * guarantee working, and for one that did not fill it means those arguments can
 * never do anything else. `--retry` mints a `clientOrderId`, which the digest
 * counts, so the intent is a different one and says so rather than pretending
 * the last one might go differently.
 */
const retry = options['--retry'] === true;
const clientOrderId = retry ? `retry-${Date.now().toString(36)}` : undefined;

if (!marketId || !outcomeId || !side || !amount || !bps) {
  out('usage: node recipes/order.mjs <marketId> <YES|NO> <BUY|SELL> <amount|shares> <maxSlippageBps> [positionId] [--account <id>] [--dry-run] [--retry] [--json]');
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
// Narrowed when pinned, so `ready` means THAT account is ready rather than some
// other one being the only candidate.
const pinned = options['--account'];
const diagnosis = await client.diagnose(pinned === undefined ? {} : { accountId: pinned });
if (!diagnosis.ready) {
  out(`Not placing anything: ${diagnosis.writes.status} — ${diagnosis.writes.detail}`);
  if (pinned !== undefined) {
    out(`(asked for account ${pinned}; it is not one this agent may trade on right now)`);
  }
  emitError('NOT_READY', {
    writes: diagnosis.writes,
    requestedAccount: pinned ?? null,
    authorizationUrl: diagnosis.authorizationUrl,
  });
  process.exit(3);
}
const accountId = diagnosis.onboarding.account.accountId;

const { market } = await client.getMarket(marketId);
out(`market   : ${market.title}`);
out(`           ${market.marketId}`);
out(`status   : ${market.status} | tradeable: ${market.tradeable} | closes ${market.closesAt ?? '(no schedule)'}`);
out(`account  : ${accountId}${pinned === undefined ? '  (whichever is authorized; pin it with --account)' : '  (pinned)'}`);
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
      ...(clientOrderId === undefined ? {} : { clientOrderId }),
    },
    { waitFor: 'TERMINAL', timeoutMs: 90_000 },
  );

  // Decided before anything is printed, because it decides what to print. The
  // SDK owns the question — `status` alone does not answer "did the money
  // move", and working it out per caller is how four cancelled orders came to
  // look exactly like the one that traded.
  const disposition = dispositionOf(result);

  out('');
  out(
    disposition === 'FILLED'
      ? '*** FILLED ***'
      : disposition === 'NOT_FILLED'
        ? `*** NOT FILLED — ${result.status}. Nothing traded. ***`
        : `*** NOT OBSERVED — ${result.status}. The order may still be live. ***`,
  );
  out('');
  out(`executionId : ${result.executionId}`);
  out(`status      : ${result.status}  (terminal: ${result.terminal}, timedOut: ${result.timedOut})`);
  out(`key         : ${result.idempotencyKey}${result.idempotencyKeyReplayed ? '  (REPLAYED)' : ''}`);
  out(`enforced    : ${result.enforcedWorstPrice}`);
  if (result.fill !== undefined) out(`fill        : ${JSON.stringify(result.fill)}`);
  if (result.remainingAllowance !== undefined) out(`allowance   : ${result.remainingAllowance}`);
  if (!result.fee.available) {
    out(`fee         : none reportable — ${result.fee.reason}. Do not compute one.`);
  }

  if (disposition === 'NOT_FILLED') {
    out('');
    out('This order is over. It traded nothing and the allowance above is unchanged.');
    // Whole sentences. Trimming at the first period cut them mid-decimal —
    // "fills at 0." — which is worse than not echoing them at all.
    if (cost.concerns.length > 0) {
      out('The disclosure above already said why this was likely:');
      for (const concern of cost.concerns) out(`  ! ${concern}`);
    }
    if (result.idempotencyKeyReplayed) {
      // The half a caller works out by trial otherwise, five minutes at a time.
      out('');
      out('And this was a REPLAY: the key is content-addressed, so these exact');
      out('arguments will keep returning this same recorded result and will never');
      out('send anything. To attempt it again as a NEW intent, add --retry (which');
      out('mints a clientOrderId), or change what you are asking for.');
    }
    emitError(result.status, { result, cost, disposition });
    process.exitCode = 7;
  } else if (disposition === 'FILLED') {
    emit({ result, cost, disposition });
  } else {
    out('');
    out('The wait expired. The order is LIVE, not failed. Run `node recipes/reconcile.mjs`.');
    emitError('WAIT_EXPIRED', { result, cost, disposition });
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
