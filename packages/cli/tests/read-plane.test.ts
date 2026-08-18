/**
 * The read plane: market list/get/quote, account status/allowance/positions/
 * executions/fills.
 *
 * These handlers are deliberately thin, so what is tested is mostly what they
 * refuse to do. They do not re-sort, re-price or re-derive anything the server
 * said; they do not turn a decimal string into a number; they do not turn a null
 * into a zero. Every one of those "helpful" transformations would make this CLI
 * a second source of truth about money or identity, which it must never be.
 */
import { describe, expect, it } from 'vitest';

import { EXIT_CODES } from '../src/index.ts';
import {
  ACCOUNT_ID,
  ALLOWANCE_OK,
  AUTH_OK,
  CONFIGURED_ENV,
  EFFECTIVE_LIMITS_OK,
  invoke,
} from './harness.ts';

const MARKET_ID = `0x${'d'.repeat(63)}3`;
const ACCOUNT_PATH = `/agent-api/v1/predict/accounts/${ACCOUNT_ID}`;

/** A position whose facts are partly unknown. The nulls are the point. */
const POSITIONS_OK = {
  status: 200,
  body: {
    positions: [
      {
        marketId: MARKET_ID,
        outcomeId: 'YES',
        shares: '10.5',
        avgEntryPrice: '0.4321',
        unrealizedPnl: null,
      },
    ],
  },
} as const;

const withAuth = (routes: Record<string, { status: number; body: unknown }>) => ({
  env: CONFIGURED_ENV,
  routes: { 'POST /agent-api/v1/auth': AUTH_OK, ...routes },
});

describe('market reads', () => {
  it('returns the catalog as the server sent it, and says the prices are indicative', async () => {
    const markets = [
      { marketId: MARKET_ID, title: 'B', outcomes: [{ outcomeId: 'YES', price: '0.62' }] },
      { marketId: `0x${'e'.repeat(63)}4`, title: 'A', outcomes: [] },
    ];
    const result = await invoke(
      ['market', 'list', '--limit', '2'],
      withAuth({ 'GET /agent-api/v1/predict/markets': { status: 200, body: { markets } } }),
    );
    const data = result.envelope.data as { markets: unknown[]; count: number; caveats: string[] };

    expect(result.exit).toBe(EXIT_CODES.OK);
    // Same objects, same order. Re-sorting would be this CLI having an opinion.
    expect(data.markets).toEqual(markets);
    expect(data.count).toBe(2);
    expect(data.caveats.join(' ')).toMatch(/INDICATIVE/u);
  });

  it('counts what came back rather than what was asked for', async () => {
    const result = await invoke(
      ['market', 'list', '--limit', '50'],
      withAuth({
        'GET /agent-api/v1/predict/markets': { status: 200, body: { markets: [{ marketId: 'm' }] } },
      }),
    );

    expect((result.envelope.data as { count: number }).count).toBe(1);
  });

  it('sends the search text to the server and reports its resolution verbatim', async () => {
    const result = await invoke(
      ['market', 'search', '--search', 'arsenal chelsea'],
      withAuth({
        'GET /agent-api/v1/predict/markets': {
          status: 200,
          body: {
            markets: [{ marketId: MARKET_ID, title: 'Arsenal vs Chelsea' }],
            resolution: {
              status: 'RESOLVED',
              normalizedQuery: 'arsenal chelsea',
              marketId: MARKET_ID,
              matchCount: 1,
            },
          },
        },
      }),
    );
    const data = result.envelope.data as {
      resolution: { status: string; matchCount: number };
      marketId: string | null;
      nextStep: { command: string };
    };

    expect(result.exit).toBe(EXIT_CODES.OK);
    expect(data.resolution.status).toBe('RESOLVED');
    expect(data.marketId).toBe(MARKET_ID);
    expect(data.nextStep.command).toBe('market quote');
    // The text went to the server. Matching it locally would resolve an identity
    // the server never resolved.
    const call = result.fetches.find((entry) => entry.url.includes('/markets'));
    expect(new URL(call!.url).searchParams.get('search')).toBe('arsenal chelsea');
  });

  it('exits AMBIGUOUS and withholds an id when the text names more than one market', async () => {
    const other = `0x${'e'.repeat(63)}4`;
    const result = await invoke(
      ['market', 'search', '--search', 'arsenal'],
      withAuth({
        'GET /agent-api/v1/predict/markets': {
          status: 200,
          body: {
            markets: [{ marketId: MARKET_ID }, { marketId: other }],
            resolution: {
              status: 'AMBIGUOUS',
              normalizedQuery: 'arsenal',
              marketId: null,
              matchCount: 2,
            },
          },
        },
      }),
    );
    const data = result.envelope.data as { marketId: string | null; candidates: unknown[] };

    // The read succeeded, so `ok` stays true — but a script must not read two
    // matches as a resolved identity, and the exit code is what it cannot miss.
    expect(result.envelope.ok).toBe(true);
    expect(result.exit).toBe(EXIT_CODES.AMBIGUOUS);
    expect(data.marketId).toBeNull();
    expect(data.candidates).toHaveLength(2);
  });

  it('never treats a truncated page as a unique match', async () => {
    const result = await invoke(
      ['market', 'search', '--search', 'arsenal', '--limit', '1'],
      withAuth({
        'GET /agent-api/v1/predict/markets': {
          status: 200,
          body: {
            markets: [{ marketId: MARKET_ID }],
            // One row on the page, three in the catalog. `matchCount` is the
            // server's count before `limit`, and it is what decides.
            resolution: {
              status: 'AMBIGUOUS',
              normalizedQuery: 'arsenal',
              marketId: null,
              matchCount: 3,
            },
          },
        },
      }),
    );
    const data = result.envelope.data as {
      marketId: string | null;
      count: number;
      resolution: { matchCount: number };
    };

    expect(data.count).toBe(1);
    expect(data.resolution.matchCount).toBe(3);
    expect(data.marketId).toBeNull();
    expect(result.exit).toBe(EXIT_CODES.AMBIGUOUS);
  });

  it('withholds an id when a server answers a search without resolving it', async () => {
    // An older server, or one this build does not understand. Inferring the id
    // from a one-row page is exactly the local resolution that is forbidden.
    const result = await invoke(
      ['market', 'search', '--search', 'arsenal'],
      withAuth({
        'GET /agent-api/v1/predict/markets': {
          status: 200,
          body: { markets: [{ marketId: MARKET_ID }] },
        },
      }),
    );
    const data = result.envelope.data as { marketId: string | null; resolution: { status: string } };

    expect(data.resolution.status).toBe('NOT_FOUND');
    expect(data.marketId).toBeNull();
    expect(result.exit).toBe(EXIT_CODES.AMBIGUOUS);
  });

  it('passes a search through `market list` without putting the answer first', async () => {
    const result = await invoke(
      ['market', 'list', '--search', 'arsenal'],
      withAuth({
        'GET /agent-api/v1/predict/markets': {
          status: 200,
          body: {
            markets: [{ marketId: MARKET_ID }],
            resolution: {
              status: 'RESOLVED',
              normalizedQuery: 'arsenal',
              marketId: MARKET_ID,
              matchCount: 1,
            },
          },
        },
      }),
    );
    const data = result.envelope.data as { resolution?: { marketId: string } };

    // `market list` reports the block when it is there and exits OK either way:
    // it is a catalog read, not a resolution.
    expect(data.resolution?.marketId).toBe(MARKET_ID);
    expect(result.exit).toBe(EXIT_CODES.OK);
  });

  it('fetches a market by the id it was given, without consulting the catalog', async () => {
    const result = await invoke(
      ['market', 'get', '--marketId', MARKET_ID],
      withAuth({
        [`GET /agent-api/v1/predict/markets/${MARKET_ID}`]: {
          status: 200,
          body: { market: { marketId: MARKET_ID, status: 'IN_PLAY' } },
        },
      }),
    );

    expect(result.envelope.ok).toBe(true);
    expect((result.envelope.data as { market: { marketId: string } }).market.marketId).toBe(
      MARKET_ID,
    );
    // No list call: the id was resolved by the server, not matched locally.
    expect(result.fetches.filter((call) => call.url.endsWith('/markets'))).toHaveLength(0);
  });

  it('reports a missing market as NOT_FOUND rather than as an empty success', async () => {
    const result = await invoke(
      ['market', 'get', '--marketId', MARKET_ID],
      withAuth({
        [`GET /agent-api/v1/predict/markets/${MARKET_ID}`]: {
          status: 404,
          body: {
            error: { code: 'POSITION_NOT_FOUND', message: 'no such market', retryable: false },
          },
        },
      }),
    );

    expect(result.envelope.ok).toBe(false);
    expect(result.exit).toBe(EXIT_CODES.NOT_FOUND);
  });

  it('carries a quote’s nulls and its expiry through untouched', async () => {
    const quote = {
      quoteId: 'q1',
      marketId: MARKET_ID,
      outcomeId: 'YES',
      side: 'BUY',
      price: '0.615000',
      availableSize: null,
      expectedFillSize: null,
      qualityFlags: ['TOP_OF_BOOK_ONLY'],
      expiresAt: '2026-08-12T00:00:03.000Z',
    };
    const result = await invoke(
      [
        'market',
        'quote',
        '--input',
        JSON.stringify({
          marketId: MARKET_ID,
          outcomeId: 'YES',
          side: 'BUY',
          size: { buyAmount: '25.00' },
        }),
      ],
      withAuth({ 'POST /agent-api/v1/predict/quotes': { status: 200, body: quote } }),
    );
    const data = result.envelope.data as { quote: typeof quote; caveats: string[] };

    expect(data.quote).toEqual(quote);
    // null means "depth unknown". Rendering it as 0 would read as "none available".
    expect(data.quote.availableSize).toBeNull();
    expect(data.caveats.join(' ')).toMatch(/null is not zero/u);
  });

  it('reports an unquotable market as UNAVAILABLE, not as a transport problem', async () => {
    const result = await invoke(
      [
        'market',
        'quote',
        '--input',
        JSON.stringify({
          marketId: MARKET_ID,
          outcomeId: 'NO',
          side: 'SELL',
          size: { sellShares: '5' },
        }),
      ],
      withAuth({
        'POST /agent-api/v1/predict/quotes': {
          status: 409,
          body: { error: { code: 'MARKET_CLOSED', message: 'market closed', retryable: false } },
        },
      }),
    );

    expect(result.envelope.error?.code).toBe('MARKET_CLOSED');
    expect(result.envelope.error?.source).toBe('SERVER');
    expect(result.exit).toBe(EXIT_CODES.UNAVAILABLE);
  });
});

describe('account reads', () => {
  const STATUS_ROUTES = {
    [`GET ${ACCOUNT_PATH}/effective-limits`]: EFFECTIVE_LIMITS_OK,
    [`GET ${ACCOUNT_PATH}/positions`]: POSITIONS_OK,
  };

  it('composes status from capacity and exposure in one pass', async () => {
    const result = await invoke(
      ['account', 'status', '--accountId', ACCOUNT_ID],
      withAuth(STATUS_ROUTES),
    );
    const data = result.envelope.data as {
      capacity: { effectiveBuyCapacity: string };
      exposure: { openPositions: number };
      asOf: string;
    };

    expect(result.exit).toBe(EXIT_CODES.OK);
    expect(data.capacity.effectiveBuyCapacity).toBe('480.00');
    expect(data.exposure.openPositions).toBe(1);
    expect(data.asOf).toBe('2026-08-12T00:00:00.000Z');
  });

  it('signs one challenge for the two reads status makes, not one each', async () => {
    const result = await invoke(
      ['account', 'status', '--accountId', ACCOUNT_ID],
      withAuth(STATUS_ROUTES),
    );

    expect(result.signerRuns).toHaveLength(1);
    expect(result.fetches.filter((call) => call.url.endsWith('/auth'))).toHaveLength(1);
  });

  it('reports the mandate the server stated, and what would refuse a write', async () => {
    const result = await invoke(
      ['account', 'risk-limits', '--accountId', ACCOUNT_ID],
      withAuth({ [`GET ${ACCOUNT_PATH}/effective-limits`]: EFFECTIVE_LIMITS_OK }),
    );
    const data = result.envelope.data as {
      limits: Record<string, unknown>;
      usage: { windowSeconds: number; ordersInWindow: number };
      delegation: { mayPlaceOrder: boolean | null };
      blockers: string[];
      tradingBlocked: boolean;
      caveats: string[];
    };

    expect(result.exit).toBe(EXIT_CODES.OK);
    // Passed through as the server stated it, including the policy version that
    // produced it — a decision has to be traceable to the exact mandate.
    expect(data.limits).toMatchObject({
      available: true,
      maxOrdersPerHour: 20,
      maxNotionalPerHour: '2000.00',
      policyVersion: 4,
    });
    expect(data.usage.windowSeconds).toBe(3600);
    expect(data.usage.ordersInWindow).toBe(2);
    expect(data.delegation.mayPlaceOrder).toBe(true);
    expect(data.blockers).toEqual([]);
    expect(data.tradingBlocked).toBe(false);
    // An empty blocker list must never read as a guaranteed fill.
    expect(data.caveats.join(' ')).toMatch(/not a promise of a fill/u);
  });

  it('says no mandate exists instead of reading absence as unlimited', async () => {
    const result = await invoke(
      ['account', 'risk-limits', '--accountId', ACCOUNT_ID],
      withAuth({
        [`GET ${ACCOUNT_PATH}/effective-limits`]: {
          status: 200,
          body: {
            ...EFFECTIVE_LIMITS_OK.body,
            limits: null,
            allowance: null,
            blockers: ['NO_RISK_PROFILE'],
          },
        },
      }),
    );
    const data = result.envelope.data as {
      limits: Record<string, unknown>;
      capacity: unknown;
      blockers: string[];
      tradingBlocked: boolean;
    };

    // Absence is denial. An agent that read this as "no limits apply" would size
    // against a mandate nobody granted.
    expect(data.limits).toMatchObject({ available: false, reason: 'NO_RISK_PROFILE' });
    expect(data.capacity).toBeNull();
    expect(data.blockers).toEqual(['NO_RISK_PROFILE']);
    expect(data.tradingBlocked).toBe(true);
    expect(JSON.stringify(data.limits)).not.toMatch(/"allowanceLimit":/u);
  });

  it('keeps a failed delegation read distinct from a denial', async () => {
    const result = await invoke(
      ['account', 'risk-limits', '--accountId', ACCOUNT_ID],
      withAuth({
        [`GET ${ACCOUNT_PATH}/effective-limits`]: {
          status: 200,
          body: {
            ...EFFECTIVE_LIMITS_OK.body,
            delegation: {
              mayPlaceOrder: null,
              mayRequestClose: false,
              checkedAt: '2026-08-12T00:00:00.000Z',
            },
          },
        },
      }),
    );
    const data = result.envelope.data as {
      delegation: { mayPlaceOrder: boolean | null; mayRequestClose: boolean | null };
      blockers: string[];
      caveats: string[];
    };

    // null is "the chain read failed", false is "revoked". Collapsing the two
    // would make a healthy strategy tear itself down over an RPC blip.
    expect(data.delegation.mayPlaceOrder).toBeNull();
    expect(data.delegation.mayRequestClose).toBe(false);
    // Unknown delegation is not a WaterX policy blocker, and is not reported as one.
    expect(data.blockers).toEqual([]);
    expect(data.caveats.join(' ')).toMatch(/chain read FAILED/u);
  });

  it('keeps every money figure a string', async () => {
    const result = await invoke(
      ['account', 'allowance', '--accountId', ACCOUNT_ID],
      withAuth({ [`GET ${ACCOUNT_PATH}/allowance`]: ALLOWANCE_OK }),
    );
    const data = result.envelope.data as {
      apiAllowance: Record<string, unknown>;
      effectiveBuyCapacity: unknown;
      caveats: string[];
    };

    for (const value of Object.values(data.apiAllowance)) expect(typeof value).toBe('string');
    expect(data.effectiveBuyCapacity).toBe('480.00');
    // The allowance is policy, not an on-chain guarantee, and says so.
    expect(data.caveats.join(' ')).toMatch(/not an on-chain guarantee/u);
  });

  it('passes an unknown position fact through as null rather than as zero', async () => {
    const result = await invoke(
      ['account', 'positions', '--accountId', ACCOUNT_ID],
      withAuth({ [`GET ${ACCOUNT_PATH}/positions`]: POSITIONS_OK }),
    );
    const data = result.envelope.data as {
      positions: { unrealizedPnl: unknown; shares: unknown }[];
      count: number;
    };

    expect(data.count).toBe(1);
    expect(data.positions[0]?.unrealizedPnl).toBeNull();
    expect(data.positions[0]?.shares).toBe('10.5');
  });

  it('warns that a non-terminal execution is not a fill', async () => {
    const result = await invoke(
      ['account', 'executions', '--accountId', ACCOUNT_ID, '--limit', '10'],
      withAuth({
        [`GET ${ACCOUNT_PATH}/executions`]: {
          status: 200,
          body: { executions: [{ executionId: 'e1', status: 'PENDING_FILL' }] },
        },
      }),
    );
    const data = result.envelope.data as { executions: unknown[]; caveats: string[] };

    expect(data.executions).toHaveLength(1);
    expect(result.fetches.at(-1)?.url).toContain('limit=10');
    expect(data.caveats.join(' ')).toMatch(/are not fills/u);
  });

  it('says whose transaction a fill’s digest is, and why the fee is null', async () => {
    const result = await invoke(
      ['account', 'fills', '--accountId', ACCOUNT_ID],
      withAuth({
        [`GET ${ACCOUNT_PATH}/fills`]: {
          status: 200,
          body: { fills: [{ fillId: 'f1', txDigest: '0xdead', actualFee: null }] },
        },
      }),
    );
    const data = result.envelope.data as { fills: unknown[]; caveats: string[]; count: number };

    expect(data.count).toBe(1);
    expect(data.caveats.join(' ')).toMatch(/keeper transaction/u);
    expect(data.caveats.join(' ')).toMatch(/null rather than zero/u);
  });

  it('reports performance with its scope, and leaves an undefined rate null', async () => {
    const result = await invoke(
      ['account', 'performance', '--accountId', ACCOUNT_ID],
      withAuth({
        [`GET ${ACCOUNT_PATH}/performance`]: {
          status: 200,
          body: {
            accountId: ACCOUNT_ID,
            agentWallet: '0xagent',
            strategyId: null,
            attributionScope: 'API_ATTRIBUTED_ONLY',
            orders: { created: 2, terminal: 0, filled: 0, rejected: 0, cancelled: 0, expired: 0, inFlight: 2, successRate: null, terminalRate: '0.0000' },
            rejections: [],
            realized: { closedExits: 0, wins: 0, losses: 0, breakEven: 0, winRate: null, grossProceeds: '0', costBasis: '0', realizedPnl: '0' },
            excluded: { exitsWithoutAttributedBasis: 0, claimedPositions: 3, openPositions: 1 },
            asOf: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
    );
    const data = result.envelope.data as {
      attributionScope: string;
      orders: { successRate: string | null };
      realized: { winRate: string | null };
      caveats: string[];
    };

    expect(result.exit).toBe(EXIT_CODES.OK);
    expect(data.attributionScope).toBe('API_ATTRIBUTED_ONLY');
    // Null, not "0". A success rate over nothing terminal is undefined, and a
    // zero here would read as two failed orders.
    expect(data.orders.successRate).toBeNull();
    expect(data.realized.winRate).toBeNull();
    expect(data.caveats.join(' ')).toMatch(/API_ATTRIBUTED_ONLY/u);
    expect(data.caveats.join(' ')).toMatch(/claimedPositions.*DOWNWARD/u);
    // No filter asked for, so none sent: an empty `strategyId=` would narrow to
    // a strategy label that is the empty string.
    expect(new URL(result.fetches.at(-1)!.url).searchParams.has('strategyId')).toBe(false);
  });

  it('narrows performance to one strategy by sending the label to the server', async () => {
    const result = await invoke(
      ['account', 'performance', '--accountId', ACCOUNT_ID, '--strategyId', 'take-profit'],
      withAuth({
        [`GET ${ACCOUNT_PATH}/performance`]: {
          status: 200,
          body: {
            accountId: ACCOUNT_ID,
            agentWallet: '0xagent',
            strategyId: 'take-profit',
            attributionScope: 'API_ATTRIBUTED_ONLY',
            orders: { created: 0, terminal: 0, filled: 0, rejected: 0, cancelled: 0, expired: 0, inFlight: 0, successRate: null, terminalRate: null },
            rejections: [],
            realized: { closedExits: 0, wins: 0, losses: 0, breakEven: 0, winRate: null, grossProceeds: '0', costBasis: '0', realizedPnl: '0' },
            excluded: { exitsWithoutAttributedBasis: 0, claimedPositions: 0, openPositions: 0 },
            asOf: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
    );

    expect(result.exit).toBe(EXIT_CODES.OK);
    // Filtered server-side. Filtering here would mean re-deriving totals the
    // server computed, from rows this CLI never saw.
    expect(new URL(result.fetches.at(-1)!.url).searchParams.get('strategyId')).toBe('take-profit');
  });

  it('refuses an account read with no account, before authenticating', async () => {
    const result = await invoke(['account', 'positions'], { env: CONFIGURED_ENV });

    expect(result.envelope.error?.code).toBe('INVALID_INPUT');
    expect(result.exit).toBe(EXIT_CODES.INVALID_INPUT);
    expect(result.fetches).toHaveLength(0);
    expect(result.signerRuns).toHaveLength(0);
  });

  it('refuses a malformed account id rather than sending it', async () => {
    const result = await invoke(['account', 'positions', '--accountId', '0xnope'], {
      env: CONFIGURED_ENV,
    });

    expect(result.envelope.error?.code).toBe('INVALID_INPUT');
    expect(result.fetches).toHaveLength(0);
  });
});

/**
 * Paging, from the caller's side. What matters is not that a cursor round-trips
 * — it is that the three answers stay three: "here is the next page", "there is
 * provably nothing older", and "this server did not say".
 */
describe('account history paging', () => {
  const EXECUTIONS = `GET ${ACCOUNT_PATH}/executions`;

  it('sends --cursor to the server untouched and reports the next one', async () => {
    const cursor = 'djE6RVhFQ1VUSU9OUzozZjFiOWMyZQ';
    const result = await invoke(
      ['account', 'executions', '--accountId', ACCOUNT_ID, '--limit', '1', '--cursor', cursor],
      withAuth({
        [EXECUTIONS]: { status: 200, body: { executions: [{ executionId: 'e1' }], nextCursor: 'next-1' } },
      }),
    );
    const data = result.envelope.data as { nextCursor: string | null; hasMore: boolean | null };

    expect(result.exit).toBe(EXIT_CODES.OK);
    expect(result.fetches[1]?.url).toContain(`cursor=${cursor}`);
    expect(data.nextCursor).toBe('next-1');
    expect(data.hasMore).toBe(true);
  });

  it('reports hasMore: false only when the server proved the history is exhausted', async () => {
    const result = await invoke(
      ['account', 'fills', '--accountId', ACCOUNT_ID, '--limit', '50'],
      withAuth({ [`GET ${ACCOUNT_PATH}/fills`]: { status: 200, body: { fills: [], nextCursor: null } } }),
    );
    const data = result.envelope.data as { nextCursor: string | null; hasMore: boolean | null };

    expect(data.nextCursor).toBeNull();
    expect(data.hasMore).toBe(false);
  });

  it('reports hasMore: null — with a reason — when the server never answered', async () => {
    // An older deployment with no keyset paging. Reporting `false` here would
    // tell a caller its reconstruction was complete when it may not be.
    const result = await invoke(
      ['account', 'positions', '--accountId', ACCOUNT_ID, '--limit', '1'],
      withAuth({ [`GET ${ACCOUNT_PATH}/positions`]: { status: 200, body: { positions: [] } } }),
    );
    const data = result.envelope.data as {
      hasMore: boolean | null;
      hasMoreReason?: string;
    };

    expect(data.hasMore).toBeNull();
    expect(data.hasMoreReason).toMatch(/UNKNOWN/u);
  });

  it('sends no cursor parameter at all when none was given', async () => {
    const result = await invoke(
      ['account', 'executions', '--accountId', ACCOUNT_ID, '--limit', '1'],
      withAuth({ [EXECUTIONS]: { status: 200, body: { executions: [], nextCursor: null } } }),
    );

    // `?cursor=` is a malformed cursor, not an absent one, and the server
    // refuses it — so an empty flag must never be synthesised here.
    expect(result.fetches[1]?.url).not.toContain('cursor');
  });

  it('refuses a cursor on the market catalog, which has none', async () => {
    const result = await invoke(['market', 'list', '--cursor', 'anything'], withAuth({}));

    // Rejected locally rather than sent and silently ignored: `market list`
    // pages by limit only, on purpose, so there is no such flag to accept.
    expect(result.exit).toBe(EXIT_CODES.USAGE);
    expect(result.fetches).toHaveLength(0);
  });
});
