/**
 * Input typing, and the refusal to guess.
 *
 * A CLI that coerces is a CLI that eventually trades a size nobody typed:
 * `--limit abc` becoming `NaN` becoming `0`, or a decimal amount round-tripping
 * through a JS number and losing its last digit. Every test here is a case where
 * the tempting behaviour is to be helpful, and the correct behaviour is to stop.
 */
import { describe, expect, it } from 'vitest';

import { EXIT_CODES } from '../src/index.ts';
import { ACCOUNT_ID, AUTH_OK, BASE_URL, CONFIGURED_ENV, invoke } from './harness.ts';

const MARKET_ID = `0x${'d'.repeat(63)}3`;
const MARKETS_OK = { status: 200, body: { markets: [] } } as const;

describe('typed flags', () => {
  it('converts an integer flag using the schema’s declared type', async () => {
    const result = await invoke(['market', 'list', '--limit', '5'], {
      env: CONFIGURED_ENV,
      routes: { 'POST /agent-api/v1/auth': AUTH_OK, 'GET /agent-api/v1/predict/markets': MARKETS_OK },
    });

    expect(result.envelope.ok).toBe(true);
    expect(result.fetches.at(-1)?.url).toContain('limit=5');
  });

  it('refuses a non-integer rather than rounding or NaN-ing it', async () => {
    const result = await invoke(['market', 'list', '--limit', 'abc'], { env: CONFIGURED_ENV });

    expect(result.envelope.error?.code).toBe('USAGE');
    expect(result.envelope.error?.message).toMatch(/whole number/u);
    expect(result.exit).toBe(EXIT_CODES.USAGE);
    expect(result.fetches).toHaveLength(0);
  });

  it('refuses a fractional value for an integer field', async () => {
    const result = await invoke(['market', 'list', '--limit', '2.5'], { env: CONFIGURED_ENV });

    expect(result.envelope.error?.code).toBe('USAGE');
    expect(result.envelope.error?.message).toMatch(/not rounded or truncated/u);
  });

  it('accepts a bare boolean flag and an explicit false', async () => {
    const bare = await invoke(['market', 'list', '--tradeable'], {
      env: CONFIGURED_ENV,
      routes: { 'POST /agent-api/v1/auth': AUTH_OK, 'GET /agent-api/v1/predict/markets': MARKETS_OK },
    });
    expect(bare.fetches.at(-1)?.url).toContain('tradeable=true');

    const explicit = await invoke(['market', 'list', '--tradeable', 'false'], {
      env: CONFIGURED_ENV,
      routes: { 'POST /agent-api/v1/auth': AUTH_OK, 'GET /agent-api/v1/predict/markets': MARKETS_OK },
    });
    expect(explicit.fetches.at(-1)?.url).toContain('tradeable=false');
  });

  it('refuses a boolean flag given something that is not a boolean', async () => {
    const result = await invoke(['market', 'list', '--tradeable', 'yes'], { env: CONFIGURED_ENV });
    expect(result.envelope.error?.code).toBe('USAGE');
  });

  it('rejects an unknown flag and names the fields the command does have', async () => {
    const result = await invoke(['market', 'list', '--categorie', 'sports'], {
      env: CONFIGURED_ENV,
    });

    expect(result.envelope.error?.code).toBe('USAGE');
    expect(result.envelope.error?.message).toContain('--category');
    expect(result.fetches).toHaveLength(0);
  });

  it('passes a decimal string through untouched, so no precision is lost', async () => {
    // Six decimal places is the schema's cap; the point is that it stays a
    // JSON string. As a JSON number it would be at the mercy of float parsing,
    // and the whole decimal discipline is that money never becomes one.
    const buyAmount = '12.345678';
    const result = await invoke(
      [
        'market',
        'quote',
        '--input',
        JSON.stringify({
          marketId: MARKET_ID,
          outcomeId: 'YES',
          side: 'BUY',
          size: { buyAmount },
        }),
      ],
      {
        env: CONFIGURED_ENV,
        routes: {
          'POST /agent-api/v1/auth': AUTH_OK,
          'POST /agent-api/v1/predict/quotes': {
            status: 200,
            body: { quoteId: 'q1', price: '0.51', expiresAt: '2026-08-12T00:00:03.000Z' },
          },
        },
      },
    );

    expect(result.envelope.ok).toBe(true);
    const quote = result.fetches.find((call) => call.url.endsWith('/quotes'));
    const sent = (quote?.body as { size?: { buyAmount?: unknown } }).size?.buyAmount;
    expect(typeof sent).toBe('string');
    expect(sent).toBe(buyAmount);
  });

  it('refuses to type a structured field as a flag and says how to pass it', async () => {
    const result = await invoke(['market', 'quote', '--size', '{"buyAmount":"1"}'], {
      env: CONFIGURED_ENV,
    });

    expect(result.envelope.error?.code).toBe('USAGE');
    expect(result.envelope.error?.message).toMatch(/--input/u);
    expect(result.fetches).toHaveLength(0);
  });

  it('stops a BUY that names shares instead of an amount, before it is priced', async () => {
    const result = await invoke(
      [
        'market',
        'quote',
        '--input',
        JSON.stringify({
          marketId: MARKET_ID,
          outcomeId: 'YES',
          side: 'BUY',
          size: { sellShares: '10' },
        }),
      ],
      { env: CONFIGURED_ENV },
    );

    expect(result.envelope.error?.code).toBe('INVALID_INPUT');
    expect(result.exit).toBe(EXIT_CODES.INVALID_INPUT);
    expect(result.fetches).toHaveLength(0);
  });
});

describe('document input', () => {
  it('reads a JSON document from --input and lets flags override it', async () => {
    const result = await invoke(
      ['market', 'list', '--input', '{"limit":3,"category":"politics"}', '--limit', '7'],
      {
        env: CONFIGURED_ENV,
        routes: {
          'POST /agent-api/v1/auth': AUTH_OK,
          'GET /agent-api/v1/predict/markets': MARKETS_OK,
        },
      },
    );

    const url = result.fetches.at(-1)?.url ?? '';
    expect(url).toContain('limit=7');
    expect(url).toContain('category=politics');
  });

  it('reads from stdin when asked, and only when asked', async () => {
    const result = await invoke(['market', 'list', '--stdin'], {
      env: CONFIGURED_ENV,
      stdin: '{"limit":2}',
      routes: { 'POST /agent-api/v1/auth': AUTH_OK, 'GET /agent-api/v1/predict/markets': MARKETS_OK },
    });

    expect(result.fetches.at(-1)?.url).toContain('limit=2');
  });

  it('refuses two input sources at once instead of silently preferring one', async () => {
    const result = await invoke(['market', 'list', '--input', '{}', '--stdin'], {
      env: CONFIGURED_ENV,
      stdin: '{"limit":2}',
    });

    expect(result.envelope.error?.code).toBe('USAGE');
    expect(result.envelope.error?.message).toMatch(/only one input source/iu);
  });

  it('reports malformed JSON as a usage error, not an internal one', async () => {
    const result = await invoke(['market', 'list', '--input', '{limit:2}'], {
      env: CONFIGURED_ENV,
    });

    expect(result.envelope.error?.code).toBe('USAGE');
    expect(result.exit).toBe(EXIT_CODES.USAGE);
  });
});

describe('configuration', () => {
  it('takes the account id from the config file when none is typed', async () => {
    const path = '/tmp/waterx-cli-config.json';
    const result = await invoke(['account', 'positions'], {
      env: { WATERX_PREDICT_CONFIG: path },
      files: {
        [path]: JSON.stringify({
          baseUrl: BASE_URL,
          agentWallet: `0x${'a'.repeat(63)}1`,
          signerCommand: '/opt/waterx/sign',
          defaultAccountId: ACCOUNT_ID,
        }),
      },
      routes: {
        'POST /agent-api/v1/auth': AUTH_OK,
        [`GET /agent-api/v1/predict/accounts/${ACCOUNT_ID}/positions`]: {
          status: 200,
          body: { positions: [] },
        },
      },
    });

    expect(result.envelope.ok).toBe(true);
    expect(result.envelope.meta?.defaultsApplied).toEqual({ accountId: ACCOUNT_ID });
  });

  it('rejects an unknown config key rather than ignoring it', async () => {
    const path = '/tmp/waterx-cli-config.json';
    const result = await invoke(['describe'], {
      env: { WATERX_PREDICT_CONFIG: path },
      files: { [path]: JSON.stringify({ baseUrl: BASE_URL, autoTrade: true }) },
    });

    expect(result.envelope.error?.code).toBe('CONFIG_INVALID');
    expect(result.envelope.error?.message).toContain('autoTrade');
  });

  it('rejects a timeout that is not a number, before any deadline is armed', async () => {
    const result = await invoke(['market', 'list', '--timeout-ms', 'soon'], {
      env: CONFIGURED_ENV,
    });

    expect(result.envelope.error?.code).toBe('USAGE');
    expect(result.fetches).toHaveLength(0);
  });
});
