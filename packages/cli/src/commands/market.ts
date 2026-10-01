/**
 * The market read plane.
 *
 * Each handler is a thin pass-through onto one SDK call. The server's response
 * is returned as it came, with only the caveats this API version is known to
 * carry attached alongside it — never rewritten, re-sorted or re-priced. A CLI
 * that "helpfully" post-processed a catalog would be a second source of truth
 * for market identity, which is the one thing it must never be.
 *
 * `market search` is the sharpest case of that rule. It sends the text and
 * reports the server's `resolution` verbatim; it does not match, score or
 * tie-break locally, and it never fills in a `marketId` the server left null.
 */
import type { CreateQuoteRequestBody, ListMarketsQuery } from '@waterx/predict-agent-sdk';

import type { CommandContext } from '../context.ts';
import { EXIT_CODES } from '../exit-codes.ts';

/** Strips absent keys so an optional filter is never sent as `undefined`. */
function toMarketQuery(input: Readonly<Record<string, unknown>>): ListMarketsQuery {
  const query: Record<string, unknown> = {};
  for (const key of ['limit', 'category', 'status', 'tradeable', 'updatedAfter', 'search']) {
    if (input[key] !== undefined) query[key] = input[key];
  }
  return query as ListMarketsQuery;
}

const LIST_CAVEATS: readonly string[] = [
  'Outcome prices here are INDICATIVE top-of-book and are not executable. Use `market quote` before acting on one.',
  '`status` and `tradeable` are applied after the page is assembled, so a filtered page can be shorter than `limit` without the catalog being exhausted.',
  'The catalog has NO cursor, unlike the account history reads: this page is projected in memory and ordered partly by round-clock facts, so no stable key exists to anchor one. Narrow with category, status, updatedAfter or search rather than paging deeper — `?cursor=` here is refused, not ignored.',
];

export async function marketList(context: CommandContext): Promise<unknown> {
  const client = await context.client();
  const response = await client.getMarkets(toMarketQuery(context.input), context.signal());
  return {
    markets: response.markets,
    count: response.markets.length,
    ...(response.resolution !== undefined ? { resolution: response.resolution } : {}),
    caveats: LIST_CAVEATS,
  };
}

/**
 * Free text → one market id, decided by the server.
 *
 * This is `market list` with the answer put first, and it is deliberately NOT a
 * local filter over a fetched page: `resolution` is computed server-side over the
 * whole filtered catalog, so `matchCount` is the true total and a page of one is
 * never mistaken for a unique answer. This command reads `resolution` and reports
 * it; it never derives one.
 *
 * Anything but RESOLVED exits AMBIGUOUS. The read succeeded — `ok` stays true —
 * but a caller that pipes this into an order must not read "two markets match"
 * or "nothing matches" as a resolved identity, and an exit code is the one
 * signal a shell script cannot miss.
 */
export async function marketSearch(context: CommandContext): Promise<unknown> {
  const client = await context.client();
  const response = await client.searchMarkets(
    { ...toMarketQuery(context.input), search: String(context.input.search) },
    context.signal(),
  );
  const { resolution } = response;

  if (resolution.status !== 'RESOLVED') context.exitAs(EXIT_CODES.AMBIGUOUS);

  return {
    resolution,
    marketId: resolution.marketId,
    candidates: response.markets,
    count: response.markets.length,
    nextStep:
      resolution.status === 'RESOLVED'
        ? {
            command: 'market quote',
            marketId: resolution.marketId,
            detail: 'The id is server-resolved. Price it before acting on any catalog price.',
          }
        : {
            command: 'market search',
            detail:
              resolution.status !== 'AMBIGUOUS'
                ? 'No market answers to this text. Check the spelling against `aliases` on a `market list` page, or widen the filters.'
                : // Three different situations arrive as AMBIGUOUS and they send
                  // a caller to three different places. The one that reads as a
                  // contradiction — "ambiguous" over a page showing fewer
                  // candidates than matched — is the one worth naming: those
                  // markets exist and answer to this text, and they are not
                  // shown because no round of theirs is running for this
                  // runtime to price. Telling that caller to "narrow the
                  // search" sends them to refine a query that was already right.
                  resolution.matchCount > response.markets.length
                  ? `${String(resolution.matchCount)} markets answer to this text and ${String(response.markets.length)} can be shown: the rest are between rounds, so there is nothing to price on them yet. Ask again when one opens, or name a different market.`
                  : 'More than one market answers to this text. Add words from a candidate’s `aliases`, or narrow with `--category` / `--tradeable`, and ask again.',
          },
    caveats: [
      ...OUTCOME_CAVEATS,
      '`marketId` is non-null only when exactly one market matched. AMBIGUOUS and NOT_FOUND never carry a best guess.',
      '`matchCount` counts what the catalog MATCHED; `candidates` is the subset this runtime can show, which excludes a market whose round has not opened. They differ, and `matchCount` is the one that decides whether an answer is unique.',
      'Candidate order is match specificity, then the round clock, then the id. It is a reproducible tie-break, NOT a ranking of which market is worth trading.',
      ...LIST_CAVEATS.slice(0, 1),
    ],
  };
}

/**
 * What an order names, and what a person reads. They are not the same string.
 *
 * `outcomeId` is `YES` or `NO` and is the only thing an order may carry.
 * `name` is the venue's own label for that side — `up`, `down`, a team, a
 * candidate — and on a market whose title is a slug (`btc-dip-45000-y-2026`)
 * those two can be read as opposites by anyone skimming: "dip" and "up" invert
 * each other, and nothing on the page says which one the YES leg is.
 *
 * So it is said wherever outcomes are returned, rather than left to be worked
 * out from a slug. Getting this backwards is not a formatting mistake; it is an
 * order on the other side of the market.
 */
const OUTCOME_CAVEATS: readonly string[] = [
  'Trade `outcomeId` (`YES` / `NO`), never `name`. `name` is the venue\u2019s label for the same side — `up`, `down`, a team — and on a market titled by slug the two can read as opposites. The YES leg is the one this market\u2019s title asserts.',
  'A title that looks like a slug is one the catalog has not published a question for. `market search` resolves the readable title; `market get` alone may show the slug.',
];

export async function marketGet(context: CommandContext): Promise<unknown> {
  const marketId = String(context.input.marketId);
  const response = await (await context.client()).getMarket(marketId, context.signal());
  return { market: response.market, caveats: [...OUTCOME_CAVEATS, ...LIST_CAVEATS.slice(0, 1)] };
}

export async function marketQuote(context: CommandContext): Promise<unknown> {
  const request = context.input as unknown as CreateQuoteRequestBody;
  const quote = await (await context.client()).getQuote(request, context.signal());
  return {
    quote,
    caveats: [
      'A quote lives seconds and is never extended. Fetch it immediately before an order rather than caching it.',
      'Quotes are size-blind on this API version: `availableSize` and `expectedFillSize` are null and `qualityFlags` carries TOP_OF_BOOK_ONLY, so a large order can be correctly priced and still fail to fill (backlog B5).',
      'null is not zero. A null size means depth is unknown, not that nothing is available.',
    ],
  };
}
