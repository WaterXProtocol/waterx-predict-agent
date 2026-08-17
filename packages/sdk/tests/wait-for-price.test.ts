/**
 * Tests the synthetic limit order.
 *
 * Three things here are the difference between a working strategy and an
 * expensive one: the BUY/SELL direction, the re-verify against a FRESH quote
 * before firing, and exactly one submission ever.
 */
import { describe, expect, it, vi } from 'vitest';

import { PredictAgentClient, type PriceWatcher } from '../src/client.ts';
import { compareDecimal, fromScaled, targetReached, toScaled } from '../src/decimal.ts';
import type { AgentSigner } from '../src/signer.ts';

const signer: AgentSigner = {
  signTransaction: () => Promise.resolve({ signature: 'sig', bytes: 'b' }),
  signPersonalMessage: () => Promise.resolve({ signature: 'personal', bytes: 'b' }),
  toSuiAddress: () => '0xagent',
};

const CREATED = {
  executionId: 'exec-1',
  status: 'AWAITING_SIGNATURE',
  sponsoredTransactionBytes: Buffer.from('tx').toString('base64'),
  sponsoredDigest: 'd',
  signatureExpiresAt: '2026-07-30T00:01:00.000Z',
  referenceQuoteId: 'q',
  submissionQuoteId: 'q2',
  enforcedWorstPrice: '0.5',
};

const SUBMITTED = { executionId: 'exec-1', status: 'SUBMITTED', transactionDigest: 'x' };

/**
 * A client whose quote endpoint returns a scripted sequence of prices and whose
 * price watcher reads the same script, so a test controls exactly what the
 * trigger and the re-verify each see.
 */
function makeClient(quotePrices: string[], watcherPrices?: string[]) {
  let quoteIndex = 0;
  let watchIndex = 0;
  const calls: { url: string; headers: Record<string, string> }[] = [];

  const fetch = ((url: URL | string, init?: RequestInit) => {
    const target = String(url);
    calls.push({ url: target, headers: (init?.headers ?? {}) as Record<string, string> });
    if (target.endsWith('/quotes')) {
      const price = quotePrices[Math.min(quoteIndex, quotePrices.length - 1)]!;
      quoteIndex += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({ quoteId: `q-${String(quoteIndex)}`, expectedPrice: price }),
          { status: 200 },
        ),
      );
    }
    if (target.endsWith('/submit')) {
      return Promise.resolve(new Response(JSON.stringify(SUBMITTED), { status: 202 }));
    }
    return Promise.resolve(new Response(JSON.stringify(CREATED), { status: 201 }));
  }) as unknown as typeof globalThis.fetch;

  const priceWatcher: PriceWatcher | undefined =
    watcherPrices === undefined
      ? undefined
      : {
          currentPrice: () => {
            const price = watcherPrices[Math.min(watchIndex, watcherPrices.length - 1)]!;
            watchIndex += 1;
            return Promise.resolve(price);
          },
        };

  const client = new PredictAgentClient({
    baseUrl: 'https://api.test',
    fetch,
    signer,
    token: 'tok',
    retry: { maxAttempts: 1 },
    ...(priceWatcher !== undefined ? { priceWatcher } : {}),
  });
  return { client, calls, quoteCount: () => quoteIndex };
}

const intent = {
  accountId: '0xacct',
  marketId: '0xmarket',
  outcomeId: 'YES' as const,
  side: 'BUY' as const,
  size: { buyAmount: '50' },
  targetPrice: '0.50',
  maxSlippageBps: 100,
};

describe('direction', () => {
  it('treats a BUY target as a ceiling', () => {
    expect(targetReached('BUY', '0.49', '0.50')).toBe(true);
    expect(targetReached('BUY', '0.50', '0.50')).toBe(true);
    expect(targetReached('BUY', '0.51', '0.50')).toBe(false);
  });

  it('treats a SELL target as a floor', () => {
    // Inverted, and getting this backwards sells at the worst possible moment.
    expect(targetReached('SELL', '0.51', '0.50')).toBe(true);
    expect(targetReached('SELL', '0.50', '0.50')).toBe(true);
    expect(targetReached('SELL', '0.49', '0.50')).toBe(false);
  });

  it('compares exactly, without float rounding', () => {
    expect(compareDecimal('0.1', '0.10')).toBe(0);
    expect(compareDecimal('0.000001', '0.000002')).toBe(-1);
    // 0.1 + 0.2 !== 0.3 in floats; scaled integers do not care.
    expect(toScaled('0.3')).toBe(toScaled('0.1') + toScaled('0.2'));
  });

  it('refuses a malformed price rather than silently never firing', () => {
    expect(() => toScaled('abc')).toThrow(RangeError);
    expect(() => toScaled('0.1234567')).toThrow(RangeError);
  });

  it('renders a scaled integer back as a decimal string, never a number', () => {
    // Always six fractional digits, so '0.5' and '0.500000' cannot disagree once
    // a size has been computed. The wire carries strings; a float round-trip here
    // is how a share count acquires a rounding error.
    expect(fromScaled(toScaled('0.5'))).toBe('0.500000');
    expect(fromScaled(0n)).toBe('0.000000');
    expect(fromScaled(1n)).toBe('0.000001');
    expect(fromScaled(toScaled('12.345678'))).toBe('12.345678');
    expect(fromScaled(9_007_199_254_740_993_000_000n)).toBe('9007199254740993.000000');
  });

  it('round-trips every decimal it accepts', () => {
    for (const value of ['0.000001', '0.999999', '1.000000', '25.000000', '1234.567890']) {
      expect(fromScaled(toScaled(value))).toBe(value);
    }
  });

  it('refuses a negative scaled value, because the contract has no signed decimals', () => {
    expect(() => fromScaled(-1n)).toThrow(RangeError);
  });
});

describe('waitForPriceAndExecute', () => {
  it('fires as soon as the target is met', async () => {
    const { client } = makeClient(['0.49'], ['0.49']);

    const result = await client.waitForPriceAndExecute(intent, { pollIntervalMs: 0 });

    expect(result.executionId).toBe('exec-1');
    expect(result.status).toBe('SUBMITTED');
  });

  it('keeps waiting while the price is above a BUY ceiling', async () => {
    const { client } = makeClient(['0.49'], ['0.60', '0.55', '0.49']);

    const result = await client.waitForPriceAndExecute(intent, { pollIntervalMs: 0 });

    expect(result.executionId).toBe('exec-1');
  });

  it('takes a FRESH quote rather than ordering off the sampled price', async () => {
    const { client, calls } = makeClient(['0.49'], ['0.49']);

    await client.waitForPriceAndExecute(intent, { pollIntervalMs: 0 });

    // The sample is a trigger; the order is priced off a quote taken after it.
    expect(calls.filter((call) => call.url.endsWith('/quotes'))).toHaveLength(1);
  });

  it('does NOT fire when the fresh quote no longer qualifies', async () => {
    // Sample says 0.49 (target met), but the fresh quote has moved back to 0.60.
    // Firing here would trade at a price that does not qualify.
    const { client, calls } = makeClient(['0.60'], ['0.49']);

    await expect(
      client.waitForPriceAndExecute(intent, { pollIntervalMs: 0, waitTimeoutMs: -1 }),
    ).rejects.toThrow(expect.objectContaining({ code: 'EXECUTION_TIMEOUT' }));
    expect(calls.some((call) => call.url.endsWith('/executions'))).toBe(false);
  });

  it('submits nothing when the wait expires', async () => {
    const { client, calls } = makeClient(['0.60'], ['0.60']);

    await expect(
      client.waitForPriceAndExecute(intent, { pollIntervalMs: 0, waitTimeoutMs: -1 }),
    ).rejects.toThrow(expect.objectContaining({ code: 'EXECUTION_TIMEOUT' }));
    expect(calls.some((call) => call.url.endsWith('/executions'))).toBe(false);
  });

  it('carries the caller-supplied key so a restart cannot double-order', async () => {
    const { client, calls } = makeClient(['0.49'], ['0.49']);

    await client.waitForPriceAndExecute(
      { ...intent, idempotencyKey: 'resumable-1' },
      { pollIntervalMs: 0 },
    );

    const create = calls.find((call) => call.url.endsWith('/executions'));
    expect(create?.headers['Idempotency-Key']).toBe('resumable-1');
  });

  it('submits exactly one execution even across several polls', async () => {
    const { client, calls } = makeClient(['0.49'], ['0.60', '0.49']);

    await client.waitForPriceAndExecute(intent, { pollIntervalMs: 0 });

    expect(calls.filter((call) => call.url.endsWith('/executions'))).toHaveLength(1);
  });

  it('honours an abort signal', async () => {
    const { client } = makeClient(['0.60'], ['0.60']);
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.waitForPriceAndExecute(intent, { pollIntervalMs: 0, signal: controller.signal }),
    ).rejects.toThrow();
  });

  it('polls the quote endpoint by default, with no watcher supplied', async () => {
    const { client, quoteCount } = makeClient(['0.49']);

    await client.waitForPriceAndExecute(intent, { pollIntervalMs: 0 });

    // One sample + one fresh quote: the default watcher IS the quote endpoint.
    expect(quoteCount()).toBe(2);
  });

  it('waits through a watcher that reports no price', async () => {
    const noPriceThenReady: PriceWatcher = {
      currentPrice: (() => {
        let call = 0;
        return () => {
          call += 1;
          return Promise.resolve(call === 1 ? null : '0.49');
        };
      })(),
    };
    let quoteIndex = 0;
    const fetch = ((url: URL | string) => {
      const target = String(url);
      if (target.endsWith('/quotes')) {
        quoteIndex += 1;
        return Promise.resolve(
          new Response(JSON.stringify({ quoteId: 'q', expectedPrice: '0.49' }), { status: 200 }),
        );
      }
      if (target.endsWith('/submit')) {
        return Promise.resolve(new Response(JSON.stringify(SUBMITTED), { status: 202 }));
      }
      return Promise.resolve(new Response(JSON.stringify(CREATED), { status: 201 }));
    }) as unknown as typeof globalThis.fetch;

    const client = new PredictAgentClient({
      baseUrl: 'https://api.test',
      fetch,
      signer,
      token: 'tok',
      priceWatcher: noPriceThenReady,
      retry: { maxAttempts: 1 },
    });

    const result = await client.waitForPriceAndExecute(intent, { pollIntervalMs: 0 });

    // A null price is "unknown", never "target met".
    expect(result.executionId).toBe('exec-1');
    expect(quoteIndex).toBe(1);
  });
});

describe('SELL waits', () => {
  it('fires when the bid rises to the floor', async () => {
    const { client } = makeClient(['0.71'], ['0.65', '0.71']);

    const result = await client.waitForPriceAndExecute(
      {
        ...intent,
        side: 'SELL',
        size: { sellShares: '100' },
        positionId: 'pos-1',
        targetPrice: '0.70',
      },
      { pollIntervalMs: 0 },
    );

    expect(result.executionId).toBe('exec-1');
  });

  it('passes positionId through to the order', async () => {
    const bodies: unknown[] = [];
    const fetch = ((url: URL | string, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith('/quotes')) {
        return Promise.resolve(
          new Response(JSON.stringify({ quoteId: 'q', expectedPrice: '0.71' }), { status: 200 }),
        );
      }
      if (target.endsWith('/submit')) {
        return Promise.resolve(new Response(JSON.stringify(SUBMITTED), { status: 202 }));
      }
      bodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(new Response(JSON.stringify(CREATED), { status: 201 }));
    }) as unknown as typeof globalThis.fetch;

    const client = new PredictAgentClient({
      baseUrl: 'https://api.test',
      fetch,
      signer,
      token: 'tok',
      retry: { maxAttempts: 1 },
    });

    await client.waitForPriceAndExecute(
      {
        ...intent,
        side: 'SELL',
        size: { sellShares: '100' },
        positionId: 'pos-1',
        targetPrice: '0.70',
      },
      { pollIntervalMs: 0 },
    );

    expect(bodies[0]).toMatchObject({ positionId: 'pos-1', side: 'SELL' });
  });
});
