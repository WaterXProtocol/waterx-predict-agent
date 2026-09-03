/**
 * Narrowing a recurring series without becoming the thing `searchMarkets`
 * refuses to be.
 *
 * The server declines to pick between markets, and that refusal is correct. What
 * is asserted here is the line this module holds beside it: it narrows ONLY by a
 * discriminator the caller supplied, it never claims uniqueness off a page that
 * could not hold every match, and it says whether the narrowing happened at the
 * server or here.
 */
import { describe, expect, it, vi } from 'vitest';

import type {
  ListMarketsQuery,
  ListMarketsResponseBody,
  PredictAgentMarket,
  PredictMarketResolution,
} from '../src/contract.ts';
import { PredictAgentApiError } from '../src/errors.ts';
import { resolveMarket, type MarketSearcher } from '../src/market-resolution.ts';

function market(closesAt: string, overrides: Partial<PredictAgentMarket> = {}): PredictAgentMarket {
  return {
    marketId: `0x${closesAt.replace(/\D/gu, '')}`,
    title: 'BTC 5m Up or Down',
    category: 'crypto',
    status: 'PREGAME',
    tradeable: true,
    event: { eventId: null },
    outcomes: [
      { outcomeId: 'YES', name: 'Up', impliedProbability: '0.505', indicativeBid: '0.4825', indicativeAsk: '0.5275' },
      { outcomeId: 'NO', name: 'Down', impliedProbability: '0.495', indicativeBid: '0.4725', indicativeAsk: '0.5175' },
    ],
    aliases: ['btc 5m up or down'],
    closesAt,
    updatedAt: '2026-09-02T08:00:00.000Z',
    ...overrides,
  };
}

/** Twelve rounds, five minutes apart, exactly as the catalog serves them. */
const ROUNDS = Array.from({ length: 12 }, (_unused, index) =>
  market(new Date(Date.parse('2026-09-02T08:05:00.000Z') + index * 5 * 60_000).toISOString()),
);

function searcher(
  markets: PredictAgentMarket[],
  resolution: Partial<PredictMarketResolution> = {},
  options: { honoursWindow?: boolean } = {},
): MarketSearcher & { queries: (ListMarketsQuery & { search: string })[] } {
  const queries: (ListMarketsQuery & { search: string })[] = [];
  return {
    queries,
    searchMarkets: async (query) => {
      queries.push(query);
      const narrowed =
        options.honoursWindow === true
          ? markets.filter((entry) => {
              const at = Date.parse(entry.closesAt ?? '');
              if (query.closesAfter !== undefined && !(at > Date.parse(query.closesAfter))) return false;
              if (query.closesBefore !== undefined && !(at <= Date.parse(query.closesBefore))) return false;
              return true;
            })
          : markets;
      const body: ListMarketsResponseBody & { resolution: PredictMarketResolution } = {
        markets: narrowed,
        resolution: {
          status: narrowed.length === 1 ? 'RESOLVED' : narrowed.length === 0 ? 'NOT_FOUND' : 'AMBIGUOUS',
          normalizedQuery: query.search.toLowerCase(),
          marketId: narrowed.length === 1 ? (narrowed[0]?.marketId ?? null) : null,
          matchCount: narrowed.length,
          ...resolution,
        },
      };
      return await Promise.resolve(body);
    },
  };
}

describe('without a discriminator', () => {
  it('passes an ambiguous answer straight through and picks nothing', async () => {
    const result = await resolveMarket(searcher(ROUNDS), { search: 'BTC 5m Up or Down' });

    expect(result.status).toBe('AMBIGUOUS');
    expect(result.market).toBeUndefined();
    expect(result.narrowedBy).toBe('NONE');
    expect(result.candidates).toHaveLength(12);
  });

  it('names the expiry as what would settle it, when that is what differs', async () => {
    const result = await resolveMarket(searcher(ROUNDS), { search: 'BTC 5m Up or Down' });

    expect(result.discriminator).toBe('CLOSES_AT');
    expect(result.summary).toMatch(/closesAt/u);
  });

  it('says a person must choose when the candidates are different markets', async () => {
    const result = await resolveMarket(
      searcher([market('2026-11-03T00:00:00.000Z', { title: 'Senate: D' }), market('2026-11-03T00:00:00.000Z', { title: 'Senate: R', marketId: '0xr' })]),
      { search: 'senate' },
    );

    expect(result.discriminator).toBe('NONE');
    expect(result.status).toBe('AMBIGUOUS');
  });

  it('prices every candidate, so the choice is one question rather than two', async () => {
    // The second interruption in the session this was written after existed
    // because the ids came back without the numbers anyone needed to choose.
    const result = await resolveMarket(searcher(ROUNDS), { search: 'BTC 5m Up or Down' });

    const yes = result.candidates[0]?.outcomes.find((entry) => entry.outcomeId === 'YES');
    expect(yes?.spread.bid).toBe('0.4825');
    expect(yes?.spread.ask).toBe('0.5275');
    expect(yes?.spread.spreadBps).toBe(892);
    expect(result.candidates[0]?.quoted).toBe(true);
  });
});

describe('with an expiry the caller supplied', () => {
  it('resolves through a server that honours the window', async () => {
    const client = searcher(ROUNDS, {}, { honoursWindow: true });

    const result = await resolveMarket(client, {
      search: 'BTC 5m Up or Down',
      closesAt: '2026-09-02T08:15:00.000Z',
    });

    expect(result.status).toBe('RESOLVED');
    expect(result.market?.closesAt).toBe('2026-09-02T08:15:00.000Z');
    expect(result.narrowedBy).toBe('SERVER');
    // Sent as a half-open window so two adjacent rounds cannot both match it.
    expect(client.queries[0]?.closesBefore).toBe('2026-09-02T08:15:00.000Z');
    expect(client.queries[0]?.closesAfter).toBe('2026-09-02T08:14:59.999Z');
  });

  it('resolves against a server that ignores the window, and says it did so locally', async () => {
    // A server that narrows on neither and answers as it did before. Reporting
    // that as a server-side narrowing would hide the one limitation a local one
    // carries.
    const result = await resolveMarket(searcher(ROUNDS), {
      search: 'BTC 5m Up or Down',
      closesAt: '2026-09-02T08:15:00.000Z',
    });

    expect(result.status).toBe('RESOLVED');
    expect(result.narrowedBy).toBe('CLIENT');
    expect(result.market?.closesAt).toBe('2026-09-02T08:15:00.000Z');
  });

  it('resolves against a server that REFUSES the window, which is what the API does today', async () => {
    // The deployed API validates its query strictly: an unknown filter is a 400,
    // not something it shrugs off. A client that only handled the shrug would
    // simply fail here, which is what the first local run of this did.
    const client = strict(ROUNDS);

    const result = await resolveMarket(client, {
      search: 'BTC 5m Up or Down',
      closesAt: '2026-09-02T08:15:00.000Z',
    });

    expect(result.status).toBe('RESOLVED');
    expect(result.narrowedBy).toBe('CLIENT');
    expect(client.queries).toHaveLength(2);
    expect(client.queries[0]?.closesBefore).toBeDefined();
    expect(client.queries[1]?.closesBefore).toBeUndefined();
  });

  it('probes a refusing server once per client, not once per call', async () => {
    const client = strict(ROUNDS);
    const query = { search: 'BTC 5m Up or Down', closesAt: '2026-09-02T08:15:00.000Z' };

    await resolveMarket(client, query);
    await resolveMarket(client, query);

    // Two calls, three requests: the probe, its fallback, then straight to the
    // bare query.
    expect(client.queries).toHaveLength(3);
    expect(client.queries[2]?.closesBefore).toBeUndefined();
  });

  it('surfaces an INVALID_REQUEST that was NOT about the window', async () => {
    // The fallback is a retry, not a rescue. A refusal with another cause fails
    // the second call the same way, and the caller sees the real error instead
    // of a page this narrowed behind their back.
    const client = strict(ROUNDS, { always: true });

    await expect(
      resolveMarket(client, { search: 'x', closesAt: '2026-09-02T08:15:00.000Z' }),
    ).rejects.toThrow(PredictAgentApiError);
  });

  it('refuses to claim uniqueness off a page that could not hold every match', async () => {
    // `matchCount` counts the catalog; `markets` is one page of it. The row that
    // would have contradicted a unique answer may simply not be on the page.
    const result = await resolveMarket(
      searcher(ROUNDS, { matchCount: 40 }),
      { search: 'BTC 5m Up or Down', closesAt: '2026-09-02T08:15:00.000Z' },
    );

    expect(result.pageTruncated).toBe(true);
    expect(result.status).toBe('AMBIGUOUS');
    expect(result.market).toBeUndefined();
    expect(result.summary).toMatch(/limit/u);
  });

  it('answers NOT_FOUND for a round nothing closes on', async () => {
    const result = await resolveMarket(searcher(ROUNDS), {
      search: 'BTC 5m Up or Down',
      closesAt: '2027-01-01T00:00:00.000Z',
    });

    expect(result.status).toBe('NOT_FOUND');
    expect(result.candidates).toEqual([]);
  });

  it('excludes a market with no scheduled end from any window', async () => {
    // "Unscheduled" is not "matches anything" — treating it that way puts a
    // market that never ends into the results for a five-minute round.
    const result = await resolveMarket(
      searcher([market('2026-09-02T08:15:00.000Z'), market('2026-09-02T08:20:00.000Z', { marketId: '0xopen', closesAt: null })]),
      { search: 'BTC 5m Up or Down', closesAfter: '2026-09-02T08:00:00.000Z' },
    );

    expect(result.candidates.map((entry) => entry.marketId)).toEqual(['0x20260902081500000']);
  });
});

/**
 * A server that REFUSES an unknown filter rather than ignoring one — which is
 * what the deployed API actually does.
 *
 * `always` keeps refusing even without the window, standing in for an
 * INVALID_REQUEST whose cause was something else entirely.
 */
function strict(
  markets: PredictAgentMarket[],
  options: { always?: boolean } = {},
): MarketSearcher & { queries: (ListMarketsQuery & { search: string })[] } {
  const inner = searcher(markets);
  return {
    queries: inner.queries,
    searchMarkets: async (query, signal) => {
      const carriesWindow =
        query.closesAfter !== undefined || query.closesBefore !== undefined;
      if (carriesWindow || options.always === true) {
        inner.queries.push(query);
        throw new PredictAgentApiError(400, {
          code: 'INVALID_REQUEST',
          message: 'property closesAfter should not exist, property closesBefore should not exist',
          retryable: false,
        });
      }
      return await inner.searchMarkets(query, signal);
    },
  };
}

describe('refusals', () => {
  it('will not take two ways of naming the round at once', async () => {
    await expect(
      resolveMarket(searcher(ROUNDS), {
        search: 'x',
        closesAt: '2026-09-02T08:15:00.000Z',
        closesBefore: '2026-09-02T09:00:00.000Z',
      }),
    ).rejects.toThrow(TypeError);
  });

  it('will not take an expiry it cannot parse', async () => {
    await expect(
      resolveMarket(searcher(ROUNDS), { search: 'x', closesAt: 'next tuesday' }),
    ).rejects.toThrow(/ISO-8601/u);
  });
});
