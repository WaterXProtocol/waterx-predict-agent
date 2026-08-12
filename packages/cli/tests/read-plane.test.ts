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
import { ACCOUNT_ID, ALLOWANCE_OK, AUTH_OK, CONFIGURED_ENV, invoke } from './harness.ts';

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
  it('composes status from capacity and exposure in one pass', async () => {
    const result = await invoke(
      ['account', 'status', '--accountId', ACCOUNT_ID],
      withAuth({
        [`GET ${ACCOUNT_PATH}/allowance`]: ALLOWANCE_OK,
        [`GET ${ACCOUNT_PATH}/positions`]: POSITIONS_OK,
      }),
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
      withAuth({
        [`GET ${ACCOUNT_PATH}/allowance`]: ALLOWANCE_OK,
        [`GET ${ACCOUNT_PATH}/positions`]: POSITIONS_OK,
      }),
    );

    expect(result.signerRuns).toHaveLength(1);
    expect(result.fetches.filter((call) => call.url.endsWith('/auth'))).toHaveLength(1);
  });

  it('says the risk limits are unreadable instead of inventing one', async () => {
    const result = await invoke(
      ['account', 'status', '--accountId', ACCOUNT_ID],
      withAuth({
        [`GET ${ACCOUNT_PATH}/allowance`]: ALLOWANCE_OK,
        [`GET ${ACCOUNT_PATH}/positions`]: POSITIONS_OK,
      }),
    );
    const risk = (result.envelope.data as { riskLimits: Record<string, unknown> }).riskLimits;

    // An agent that reads a fabricated limit will size against it.
    expect(risk).toMatchObject({
      available: false,
      reason: 'OWNER_AUTHENTICATED',
      tracking: 'B1',
    });
    expect(JSON.stringify(risk)).not.toMatch(/"limit":/u);
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
