/**
 * Resolving a recurring market by the one thing that tells its rounds apart.
 *
 * `searchMarkets` resolves free text against the server's own aliases and
 * refuses to pick when more than one market matches. That refusal is correct
 * and this module does not weaken it. What it addresses is the case where the
 * refusal is unresolvable by any amount of better text: twelve rounds of "BTC
 * 5m Up or Down" share a title, share an alias set, and differ ONLY by when
 * they close. No phrasing narrows them. `resolution.matchCount` comes back
 * twelve every time.
 *
 * The caller then does what the search endpoint exists to stop them doing —
 * fetches the candidates and picks an id out of band. In the recording this
 * work came from, that cost a purpose-written script and a second interruption
 * of the person, one question after the first.
 *
 * WHERE THE LINE IS, because it is a fine one. This module narrows ONLY by a
 * discriminator THE CALLER SUPPLIED — a `closesAt`, or a window around it.
 * Supplying an expiry is not this SDK guessing an identity; it is the caller
 * naming the round, which is the missing half of the question the server could
 * not answer. Given no such discriminator, an ambiguous answer passes through
 * exactly as `searchMarkets` returns it, and this module picks nothing.
 *
 * SERVER FIRST, THEN LOCALLY, AND IT SAYS WHICH. The window is sent as
 * `closesAfter` / `closesBefore` so a server that understands them does the
 * narrowing over the whole catalog. A server that does not simply ignores them,
 * and the same predicate is applied to the page that came back. Those are not
 * equivalent and the result says which happened (`narrowedBy`), because a local
 * narrowing carries a limitation a server-side one does not:
 *
 * A LOCAL NARROWING CANNOT CLAIM UNIQUENESS OFF A TRUNCATED PAGE. `matchCount`
 * counts the whole filtered catalog; `markets` is one page of it. If the page
 * holds fewer rows than the count, the row that would have contradicted a
 * "unique" answer may simply not be on it. So uniqueness is claimed only when
 * the page provably holds every match, and otherwise the result stays ambiguous
 * and says to raise the limit. Answering `RESOLVED` from a truncated page is
 * how an agent trades the 08:15 round believing it is the only one.
 */
import type {
  Iso8601,
  ListMarketsQuery,
  ListMarketsResponseBody,
  PredictAgentMarket,
  PredictMarketResolution,
  PredictMarketResolutionStatus,
} from './contract.ts';
import { describeSpread, type PriceSpread } from './quote-cost.ts';

/** The slice of the client this needs. Narrow, so it is testable without one. */
export interface MarketSearcher {
  searchMarkets(
    query: ListMarketsQuery & { search: string },
    signal?: AbortSignal,
  ): Promise<ListMarketsResponseBody & { resolution: PredictMarketResolution }>;
}

export interface ResolveMarketQuery extends Omit<ListMarketsQuery, 'search'> {
  /** The free text, resolved server-side against aliases. */
  search: string;
  /**
   * The exact round, when the caller knows it.
   *
   * Shorthand for a window of one instant: `closesAfter` one millisecond before
   * and `closesBefore` at it. Passing this with either bound is a `TypeError`
   * rather than a silent precedence rule — two ways of saying when, disagreeing,
   * is how an order lands on the wrong round.
   */
  closesAt?: Iso8601;
}

/** Where a narrowing happened, if one did. */
export type MarketNarrowing = 'NONE' | 'SERVER' | 'CLIENT';

export interface MarketCandidate {
  readonly market: PredictAgentMarket;
  readonly marketId: string;
  readonly title: string;
  readonly closesAt: Iso8601 | null;
  readonly tradeable: boolean;
  /**
   * Top of book per outcome, spread already computed.
   *
   * Present so a caller asking a person to choose a round can show them the
   * prices in the SAME question. Two questions — which market, then which
   * expiry — is one interruption more than the choice needs, and the second one
   * is unanswerable without exactly these numbers.
   */
  readonly outcomes: readonly {
    readonly outcomeId: string;
    readonly name: string;
    readonly spread: PriceSpread;
  }[];
  /** True when at least one outcome has both a bid and an ask. */
  readonly quoted: boolean;
}

export interface MarketResolution {
  readonly status: PredictMarketResolutionStatus;
  /** Set ONLY when `status` is `RESOLVED`. Never a best guess. */
  readonly market: PredictAgentMarket | undefined;
  /** Every candidate that survived narrowing, priced, in the server's order. */
  readonly candidates: readonly MarketCandidate[];
  /** The server's count over the whole filtered catalog, before this page. */
  readonly matchCount: number;
  readonly normalizedQuery: string;
  readonly narrowedBy: MarketNarrowing;
  /**
   * True when the page could not hold every match, so a local narrowing cannot
   * prove uniqueness. Raise `limit` and ask again.
   */
  readonly pageTruncated: boolean;
  /**
   * What would settle an ambiguity, when something would.
   *
   * `CLOSES_AT` means the candidates differ only by their round — supply one
   * and this resolves without asking anyone anything else. `NONE` means they
   * are genuinely different markets and a person has to choose.
   */
  readonly discriminator: 'CLOSES_AT' | 'NONE' | undefined;
  /** One line a caller can show a user. Never a decision, always a description. */
  readonly summary: string;
}

const priceCandidate = (market: PredictAgentMarket): MarketCandidate => {
  const outcomes = market.outcomes.map((outcome) => ({
    outcomeId: outcome.outcomeId,
    name: outcome.name,
    spread: describeSpread(outcome),
  }));
  return {
    market,
    marketId: market.marketId,
    title: market.title,
    closesAt: market.closesAt,
    tradeable: market.tradeable,
    outcomes,
    quoted: outcomes.some((outcome) => outcome.spread.bid !== null && outcome.spread.ask !== null),
  };
};

/**
 * The window, half-open: `closesAfter` exclusive, `closesBefore` inclusive.
 *
 * A market with no scheduled end is excluded by either bound. It cannot satisfy
 * a claim about when it closes, and treating "unscheduled" as "matches
 * anything" would put a market that never ends in the results for a five-minute
 * round.
 */
function withinWindow(
  closesAt: Iso8601 | null,
  after: Iso8601 | undefined,
  before: Iso8601 | undefined,
): boolean {
  if (after === undefined && before === undefined) return true;
  if (closesAt === null) return false;
  const at = Date.parse(closesAt);
  if (Number.isNaN(at)) return false;
  if (after !== undefined && !(at > Date.parse(after))) return false;
  if (before !== undefined && !(at <= Date.parse(before))) return false;
  return true;
}

function summarize(
  status: PredictMarketResolutionStatus,
  candidates: readonly MarketCandidate[],
  discriminator: 'CLOSES_AT' | 'NONE' | undefined,
  pageTruncated: boolean,
): string {
  if (status === 'RESOLVED') {
    const only = candidates[0];
    return `Resolved to ${only?.title ?? 'one market'} (${only?.marketId ?? ''}), closing ${only?.closesAt ?? 'on no schedule'}.`;
  }
  if (status === 'NOT_FOUND') return 'Nothing in the catalog matched that text.';
  if (pageTruncated) {
    return `${String(candidates.length)} candidates on this page, and the catalog holds more than the page could carry. Raise \`limit\` before narrowing — a unique answer off a truncated page is not one.`;
  }
  if (discriminator === 'CLOSES_AT') {
    return `${String(candidates.length)} rounds of the same market, differing only by when they close. Supply \`closesAt\` for the one you mean and this resolves without asking anything else.`;
  }
  return `${String(candidates.length)} different markets matched. Choosing between them is not this SDK's to do.`;
}

/**
 * Free text plus an optional round, to one market or to a priced shortlist.
 *
 * The shortlist is the point as much as the resolution is: when a person does
 * have to choose, they are shown candidates with prices attached, in one
 * question, rather than a list of ids followed by a second round trip to find
 * out what any of them cost.
 */
export async function resolveMarket(
  client: MarketSearcher,
  query: ResolveMarketQuery,
  signal?: AbortSignal,
): Promise<MarketResolution> {
  const { closesAt, closesAfter, closesBefore, ...rest } = query;
  if (closesAt !== undefined && (closesAfter !== undefined || closesBefore !== undefined)) {
    throw new TypeError(
      'Pass `closesAt` or a `closesAfter`/`closesBefore` window, not both: two ways of naming the round can disagree, and resolving that here would choose which one your order reaches.',
    );
  }
  if (closesAt !== undefined && Number.isNaN(Date.parse(closesAt))) {
    throw new TypeError(`\`closesAt\` is not an ISO-8601 instant: ${JSON.stringify(closesAt)}`);
  }

  // One instant, expressed as the half-open window this module already applies,
  // so there is a single predicate rather than a special case beside it.
  const after =
    closesAt === undefined
      ? closesAfter
      : new Date(Date.parse(closesAt) - 1).toISOString();
  const before = closesAt ?? closesBefore;
  const windowed = after !== undefined || before !== undefined;

  const response = await client.searchMarkets(
    {
      ...rest,
      ...(after !== undefined ? { closesAfter: after } : {}),
      ...(before !== undefined ? { closesBefore: before } : {}),
    },
    signal,
  );
  const { resolution } = response;
  const returned = response.markets;

  // Did the server honour the window? It did if nothing it returned falls
  // outside — which is also true when the window excluded nothing, and that is
  // fine: in that case there is no narrowing to attribute either way.
  const serverNarrowed =
    windowed && returned.every((market) => withinWindow(market.closesAt, after, before));
  const kept = serverNarrowed
    ? returned
    : returned.filter((market) => withinWindow(market.closesAt, after, before));

  const narrowedBy: MarketNarrowing = !windowed
    ? 'NONE'
    : serverNarrowed
      ? 'SERVER'
      : 'CLIENT';

  // The page held every match only if it carried at least as many rows as the
  // server counted. See the header: uniqueness off a truncated page is a claim
  // about rows nobody looked at.
  const pageTruncated = returned.length < resolution.matchCount;

  const candidates = kept.map(priceCandidate);

  // Rounds of one series, or genuinely different markets? The candidates differ
  // only by their clock when they all carry the same title.
  const titles = new Set(candidates.map((candidate) => candidate.title));
  const discriminator: 'CLOSES_AT' | 'NONE' | undefined =
    candidates.length > 1 ? (titles.size === 1 ? 'CLOSES_AT' : 'NONE') : undefined;

  let status: PredictMarketResolutionStatus;
  if (resolution.status === 'RESOLVED' && !windowed) {
    // The server already answered, and nothing here narrowed anything.
    status = 'RESOLVED';
  } else if (candidates.length === 0) {
    status = 'NOT_FOUND';
  } else if (candidates.length === 1 && (narrowedBy !== 'CLIENT' || !pageTruncated)) {
    status = 'RESOLVED';
  } else {
    status = 'AMBIGUOUS';
  }

  const market = status === 'RESOLVED' ? candidates[0]?.market : undefined;

  return {
    status,
    market,
    candidates,
    matchCount: resolution.matchCount,
    normalizedQuery: resolution.normalizedQuery,
    narrowedBy,
    pageTruncated,
    discriminator,
    summary: summarize(status, candidates, discriminator, pageTruncated && status === 'AMBIGUOUS'),
  };
}
