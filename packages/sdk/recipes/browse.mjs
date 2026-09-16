#!/usr/bin/env node
/**
 * What is there to trade right now.
 *
 * The gap this closes was measured rather than guessed. `markets.mjs` resolves
 * a name you already have; the prompt an agent actually gets is "place a bet",
 * which names nothing — so the first thing needed is a look at the catalog, and
 * there was no recipe for it. Across five recorded sessions the same script was
 * hand-written every time, under a different name each time: `candidates.mjs`,
 * `catalog.mjs`, `list.mjs`, `list2.mjs`, `list3.mjs`. One of them cost 77
 * seconds of a cold start that was otherwise down to about a minute.
 *
 * Most of the catalog cannot be traded at any price. A market with no bid or no
 * ask has nothing to buy from or sell to, and the majority of any page looks
 * like that — so the default is to show only what has a two-sided quote, and to
 * say how many were dropped rather than quietly shrinking the list.
 *
 * Sorted by SPREAD, tightest first, because that is the cost that dominates
 * here and it is the one thing a chooser can act on before knowing anything
 * about the subject.
 *
 *   node recipes/browse.mjs [--category crypto] [--limit 200] [--max-spread 500]
 *                           [--all] [--json]
 */
import { describeSpread } from '@waterx/predict-agent-sdk';

import { connect, emit, emitError, out, parseArgv } from './_client.mjs';

const { options } = parseArgv({
  '--category': 'value',
  '--limit': 'value',
  '--max-spread': 'value',
  '--all': 'boolean',
});

const limit = Number(options['--limit'] ?? 200);
const maxSpreadBps = options['--max-spread'] === undefined ? null : Number(options['--max-spread']);
const showAll = options['--all'] === true;

const client = await connect();
const { markets } = await client.getMarkets({
  limit,
  tradeable: true,
  ...(options['--category'] === undefined ? {} : { category: options['--category'] }),
});

/** One row per (market, outcome) pair that can actually be bought. */
const rows = [];
let unquoted = 0;
for (const market of markets) {
  let quoted = false;
  for (const outcome of market.outcomes ?? []) {
    const spread = describeSpread(outcome);
    if (spread.spreadBps === null || spread.crossed) continue;
    quoted = true;
    rows.push({
      marketId: market.marketId,
      title: market.title,
      category: market.category,
      closesAt: market.closesAt,
      status: market.status,
      outcomeId: outcome.outcomeId,
      name: outcome.name,
      bid: spread.bid,
      ask: spread.ask,
      spreadBps: spread.spreadBps,
    });
  }
  if (!quoted) unquoted += 1;
}

rows.sort((a, b) => a.spreadBps - b.spreadBps);
const shown = maxSpreadBps === null ? rows : rows.filter((r) => r.spreadBps <= maxSpreadBps);

out(`scanned    : ${markets.length} tradeable markets (limit ${limit})`);
out(`quoted     : ${rows.length} outcomes with a two-sided price`);
out(`no quote   : ${unquoted} markets had no side to trade against — nothing can be bought there`);
if (maxSpreadBps !== null) out(`filtered   : ${shown.length} within ${maxSpreadBps} bps`);
out('');

if (shown.length === 0) {
  out('Nothing matched. Raise --limit, drop --max-spread, or try another --category.');
  emitError('NOTHING_QUOTED', { scanned: markets.length, quoted: rows.length, unquoted });
  process.exit(3);
}

// Ten is what fits on a screen and what a person can choose between. `--all`
// for the rest, because a truncated list that does not say it is truncated is
// the reason somebody re-runs this by hand.
const visible = showAll ? shown : shown.slice(0, 10);
for (const row of visible) {
  out(`${String(row.spreadBps).padStart(5)} bps  ${row.bid} / ${row.ask}   ${row.outcomeId} — ${row.title}`);
  out(`            ${row.marketId}`);
  out(`            ${row.category} | ${row.status} | closes ${row.closesAt ?? '(no schedule)'}`);
  // The line to run, ready to paste. The spread is on the row above it, so the
  // cost of the choice is visible at the moment the choice is made.
  out(`            node recipes/order.mjs '${row.marketId}' ${row.outcomeId} BUY <amount> <maxSlippageBps>`);
  out('');
}
if (!showAll && shown.length > visible.length) {
  out(`… and ${shown.length - visible.length} more. --all to see them.`);
}

out('');
out('Spread is the cost of entering and leaving, and it is paid before the');
out('outcome resolves either way. `maxSlippageBps` does not protect against it.');

emit({ scanned: markets.length, quoted: rows.length, unquoted, rows: shown });
