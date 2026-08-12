/**
 * The market read plane.
 *
 * Each handler is a thin pass-through onto one SDK call. The server's response
 * is returned as it came, with only the caveats this API version is known to
 * carry attached alongside it — never rewritten, re-sorted or re-priced. A CLI
 * that "helpfully" post-processed a catalog would be a second source of truth
 * for market identity, which is the one thing it must never be.
 */
import type { CreateQuoteRequestBody, ListMarketsQuery } from '@waterx/predict-agent-sdk';

import type { CommandContext } from '../context.ts';

/** Strips absent keys so an optional filter is never sent as `undefined`. */
function toMarketQuery(input: Readonly<Record<string, unknown>>): ListMarketsQuery {
  const query: Record<string, unknown> = {};
  for (const key of ['limit', 'category', 'status', 'tradeable', 'updatedAfter']) {
    if (input[key] !== undefined) query[key] = input[key];
  }
  return query as ListMarketsQuery;
}

export async function marketList(context: CommandContext): Promise<unknown> {
  const client = await context.client();
  const response = await client.getMarkets(toMarketQuery(context.input), context.signal());
  return {
    markets: response.markets,
    count: response.markets.length,
    caveats: [
      'Outcome prices here are INDICATIVE top-of-book and are not executable. Use `market quote` before acting on one.',
      '`status` and `tradeable` are applied after the page is assembled, so a filtered page can be shorter than `limit` without the catalog being exhausted.',
      'Paging is limit-only on this API version; there is no cursor (backlog B6).',
    ],
  };
}

export async function marketGet(context: CommandContext): Promise<unknown> {
  const marketId = String(context.input.marketId);
  const response = await (await context.client()).getMarket(marketId, context.signal());
  return { market: response.market };
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
