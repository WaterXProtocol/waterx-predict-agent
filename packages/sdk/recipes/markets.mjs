#!/usr/bin/env node
/**
 * Free text — plus, when you have it, the round — to one market or to a priced
 * shortlist.
 *
 * A recurring series is the case worth having a recipe for. Twelve rounds of
 * "BTC 5m Up or Down" share a title and an alias set and differ only by when
 * they close, so a search for one answers AMBIGUOUS every time and no better
 * phrasing narrows it. Pass `--closes-at` and it resolves; pass nothing and you
 * get the candidates WITH their prices, which is what a person needs in order to
 * answer in one question rather than two.
 *
 *   node recipes/markets.mjs "BTC 5m Up or Down"
 *   node recipes/markets.mjs "BTC 5m Up or Down" --closes-at 2026-09-02T08:15:00Z
 *   node recipes/markets.mjs "Fed September" --json
 */
import { connect, emit, emitError, out, parseArgv } from './_client.mjs';

const { positionals, options } = parseArgv({ '--closes-at': 'value', '--limit': 'value' });
const [search] = positionals;
if (search === undefined) {
  out('usage: node recipes/markets.mjs "<market name>" [--closes-at <iso>] [--limit 50] [--json]');
  emitError('USAGE');
  process.exit(2);
}

const client = await connect();
const resolution = await client.resolveMarket({
  search,
  limit: Number(options['--limit'] ?? 50),
  tradeable: true,
  ...(options['--closes-at'] === undefined ? {} : { closesAt: options['--closes-at'] }),
});

out(`query        : ${search}`);
out(`normalized   : ${resolution.normalizedQuery}`);
out(`status       : ${resolution.status}   (server counted ${resolution.matchCount})`);
out(`narrowed by  : ${resolution.narrowedBy}`);
out('');
out(resolution.summary);

if (resolution.candidates.length > 0) {
  out('');
  for (const candidate of resolution.candidates) {
    out(`- ${candidate.title}`);
    out(`  ${candidate.marketId}`);
    out(`  closes ${candidate.closesAt ?? '(no schedule)'} | tradeable: ${candidate.tradeable}`);
    for (const outcome of candidate.outcomes) {
      const { bid, ask, spreadBps, crossed } = outcome.spread;
      const book = bid === null || ask === null ? 'no two-sided quote' : `${bid} / ${ask}`;
      const cost =
        spreadBps === null ? '' : `  spread ${spreadBps} bps`;
      out(`    ${outcome.outcomeId} (${outcome.name}): ${book}${cost}${crossed ? '  ** CROSSED **' : ''}`);
    }
  }
}

if (resolution.status === 'RESOLVED') {
  out('');
  out(`node recipes/order.mjs ${resolution.market.marketId} YES BUY <amount> <maxSlippageBps>`);
} else if (resolution.pageTruncated) {
  out('');
  out('The page did not hold every match, so nothing here can claim to be the only');
  out('one. Raise --limit and ask again before narrowing.');
}

if (resolution.status === 'RESOLVED') {
  emit(resolution);
} else {
  // Still the whole resolution — an AMBIGUOUS answer with its priced candidates
  // is exactly what a caller needs in order to ask the next question.
  emitError(resolution.status, resolution);
  process.exitCode = 3;
}
