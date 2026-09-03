#!/usr/bin/env node
/**
 * What this agent holds, and what it has left to spend.
 *
 *   node recipes/positions.mjs [--json]
 *
 * Entry took the ask and the mark takes the bid, so an open position shows an
 * unrealized loss of roughly one spread the moment it exists. That is the cost
 * of crossing, not a move against you — `markets.mjs` prints the spread that
 * caused it.
 */
import { connect, emit, emitError, out, parseArgv } from './_client.mjs';

parseArgv();

const client = await connect();
const diagnosis = await client.diagnose({ includeLimits: true });

if (!diagnosis.ready) {
  out(`Not trading yet: ${diagnosis.writes.status}. Run \`node recipes/diagnose.mjs\`.`);
  emitError('NOT_READY', { writes: diagnosis.writes.status });
  process.exit(3);
}

const accountId = diagnosis.onboarding.account.accountId;
const [positions, allowance] = await Promise.all([
  client.getPositions(accountId, { limit: 100 }),
  client.getAllowance(accountId),
]);

emit({ accountId, positions, allowance, limits: diagnosis.limits });

out(`account   : ${accountId}`);
out('');
if (positions.positions.length === 0) {
  out('No open positions.');
} else {
  for (const position of positions.positions) {
    out(`- ${position.marketId}  ${position.outcomeId}`);
    out(`  positionId ${position.positionId} | opened ${position.openedAt}`);
    out(`  shares ${position.shares ?? 'unknown'} | entry ${position.avgEntryPrice ?? 'unknown'} | mark(bid) ${position.currentPrice ?? 'unknown'}`);
    // Null is not zero. A null P&L means the share count or the sell quote is
    // unknown; printing 0 there would read as break-even.
    out(`  cost ${position.remainingCost} of ${position.originalCost} | unrealized ${position.unrealizedPnl ?? 'unknown'}`);
  }
}
out('');
out(`allowance : ${JSON.stringify(allowance)}`);
out(`mandate   : ${JSON.stringify(diagnosis.limits)}`);
