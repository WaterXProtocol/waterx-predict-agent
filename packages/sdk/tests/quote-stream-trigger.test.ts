/**
 * Tests the quote stream where it meets the money: the synthetic limit order.
 *
 * The stream is an ACCELERATOR. It decides when to look, and it decides nothing
 * else — every order is still priced off a fresh executable quote and still
 * re-checked against the target before it is submitted. These tests exist to make
 * that impossible to regress quietly, because the failure mode is silent: an
 * order priced off an indicative number is a worse fill, not an exception.
 *
 * `quote-stream.test.ts` covers the socket protocol. Nothing here opens one.
 */
import { describe, expect, it, vi } from 'vitest';

import { PredictAgentClient } from '../src/client.ts';
import type { PredictQuoteStreamFrame, PredictQuoteTopic } from '../src/contract.ts';
import {
  type QuoteListener,
  type QuoteStream,
  QuoteStreamPriceWatcher,
  type QuoteUnavailableReason,
} from '../src/quote-stream.ts';
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
  signatureExpiresAt: '2026-08-17T00:01:00.000Z',
  referenceQuoteId: 'q',
  submissionQuoteId: 'q2',
  enforcedWorstPrice: '0.5',
};

const SUBMITTED = { executionId: 'exec-1', status: 'SUBMITTED', transactionDigest: 'x' };

const intent = {
  accountId: '0xacct',
  marketId: '0xmarket',
  outcomeId: 'YES' as const,
  side: 'BUY' as const,
  size: { buyAmount: '50' },
  targetPrice: '0.50',
  maxSlippageBps: 100,
};

function frame(
  overrides: {
    bid?: string | null;
    ask?: string | null;
    stale?: boolean;
    seq?: string;
  } = {},
): PredictQuoteStreamFrame {
  return {
    stream: 'predict.quotes.v1',
    marketId: intent.marketId,
    outcomeId: 'YES',
    kind: 'UPDATE',
    seq: overrides.seq ?? '1',
    gap: false,
    indicativeBid: overrides.bid ?? '0.480000',
    indicativeAsk: overrides.ask ?? '0.490000',
    impliedProbability: '0.485000',
    qualityFlags: ['INDICATIVE_ONLY'],
    freshness: {
      observedAt: '2026-08-17T00:00:00.000Z',
      sourceTimestamp: '2026-08-17T00:00:00.000Z',
      sourceAgeMs: 500,
      emittedAt: '2026-08-17T00:00:00.500Z',
      pollIntervalMs: 2_000,
      staleAfterMs: 15_000,
      stale: overrides.stale ?? false,
    },
  };
}

/** A push source this test drives by hand. Records its own lifetime. */
class FakeQuoteStream implements QuoteStream {
  readonly subscribed: PredictQuoteTopic[] = [];
  releases = 0;
  private readonly listeners = new Set<QuoteListener>();
  /** Emitted to every listener the moment it subscribes. */
  onSubscribe: ((emit: QuoteListener) => void) | undefined;

  onQuote(topic: PredictQuoteTopic, listener: QuoteListener): () => void {
    this.subscribed.push(topic);
    this.listeners.add(listener);
    this.onSubscribe?.(listener);
    return () => {
      this.releases += 1;
      this.listeners.delete(listener);
    };
  }

  push(next: PredictQuoteStreamFrame): void {
    for (const listener of [...this.listeners]) listener({ type: 'FRAME', frame: next });
  }

  drop(reason: QuoteUnavailableReason): void {
    for (const listener of [...this.listeners]) listener({ type: 'UNAVAILABLE', reason });
  }
}

/**
 * A client whose `POST /quotes` returns a scripted sequence, so a test controls
 * exactly what the fallback and the re-verify each see.
 */
function makeClient(
  quotePrices: string[],
  stream: QuoteStream,
  onQuoteCall?: (index: number) => void,
) {
  let quoteIndex = 0;
  const paths: string[] = [];
  const bodies: Record<string, unknown>[] = [];

  const fetch = ((url: URL | string, init?: RequestInit) => {
    const target = String(url);
    paths.push(target);
    if (typeof init?.body === 'string') bodies.push(JSON.parse(init.body) as Record<string, unknown>);
    if (target.endsWith('/quotes')) {
      const price = quotePrices[Math.min(quoteIndex, quotePrices.length - 1)]!;
      quoteIndex += 1;
      onQuoteCall?.(quoteIndex);
      return Promise.resolve(
        new Response(JSON.stringify({ quoteId: `q-${String(quoteIndex)}`, expectedPrice: price }), {
          status: 200,
        }),
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
    retry: { maxAttempts: 1 },
    quoteStream: stream,
  });
  return {
    client,
    paths,
    bodies,
    quoteCount: () => quoteIndex,
    executions: () => paths.filter((path) => path.endsWith('/executions')).length,
  };
}

describe('a stream-triggered price wait', () => {
  it('prices the order off a fresh quote, not off the frame that woke it', async () => {
    const stream = new FakeQuoteStream();
    // The fallback says 0.60 — no trigger. The frame says 0.49, which reaches the
    // 0.50 ceiling. The order must still be built on the quote that follows it.
    const harness = makeClient(['0.60', '0.49'], stream, (index) => {
      if (index === 1) stream.push(frame({ ask: '0.490000' }));
    });

    const result = await harness.client.waitForPriceAndExecute(intent, {
      pollIntervalMs: 10_000,
      waitTimeoutMs: 5_000,
    });

    expect(result.executionId).toBe('exec-1');
    // Two quotes: one fallback before the stream had anything, one executable
    // quote minted at the trigger. Not one per poll tick — that is what the
    // stream buys.
    expect(harness.quoteCount()).toBe(2);
    const created = harness.bodies.find((body) => 'referenceQuoteId' in body);
    // `q-2`, the FRESH quote. An indicative frame is not an executable price and
    // has no quote id to reference at all.
    expect(created?.referenceQuoteId).toBe('q-2');
    // The subscription lasted exactly as long as the wait.
    expect(stream.subscribed).toEqual([{ marketId: intent.marketId, outcomeId: 'YES' }]);
    expect(stream.releases).toBe(1);
  });

  it('submits nothing when the fresh quote no longer reaches the target', async () => {
    // The market moved back between the frame and the quote. This is the check
    // people leave out, and leaving it out trades at a price that never qualified.
    const stream = new FakeQuoteStream();
    const harness = makeClient(['0.60'], stream, (index) => {
      if (index === 1) stream.push(frame({ ask: '0.490000' }));
    });

    await expect(
      harness.client.waitForPriceAndExecute(intent, {
        pollIntervalMs: 5,
        waitTimeoutMs: 60,
      }),
    ).rejects.toMatchObject({ httpStatus: 504, code: 'EXECUTION_TIMEOUT' });

    expect(harness.executions()).toBe(0);
    expect(stream.releases).toBe(1);
  });

  it('polls REST when the stream never produces a price', async () => {
    // The bounded fallback. A stream that is dead, degraded, or simply not
    // connected yet must cost requests, never a hang.
    const stream = new FakeQuoteStream();
    stream.onSubscribe = (emit) => emit({ type: 'UNAVAILABLE', reason: 'DEGRADED' });
    const harness = makeClient(['0.49', '0.49'], stream);

    const result = await harness.client.waitForPriceAndExecute(intent, {
      pollIntervalMs: 5,
      waitTimeoutMs: 1_000,
    });

    expect(result.executionId).toBe('exec-1');
    expect(harness.quoteCount()).toBe(2);
    expect(stream.releases).toBe(1);
  });

  it('ignores a stale frame and asks REST instead', async () => {
    // A stale value publishes null prices by protocol. Remembering the last one
    // would be trading on a price the server explicitly withdrew.
    const stream = new FakeQuoteStream();
    stream.onSubscribe = (emit) =>
      emit({ type: 'FRAME', frame: frame({ ask: null, bid: null, stale: true }) });
    const harness = makeClient(['0.49', '0.49'], stream);

    await harness.client.waitForPriceAndExecute(intent, {
      pollIntervalMs: 5,
      waitTimeoutMs: 1_000,
    });

    expect(harness.quoteCount()).toBe(2);
  });

  it('releases the subscription when the wait is aborted', async () => {
    const stream = new FakeQuoteStream();
    const harness = makeClient(['0.60'], stream);
    const controller = new AbortController();

    const pending = harness.client.waitForPriceAndExecute(intent, {
      pollIntervalMs: 5,
      waitTimeoutMs: 60_000,
      signal: controller.signal,
    });
    await vi.waitFor(() => {
      expect(stream.subscribed).toHaveLength(1);
    });
    controller.abort();

    await expect(pending).rejects.toThrow();
    expect(stream.releases).toBe(1);
  });
});

describe('QuoteStreamPriceWatcher', () => {
  const request = {
    marketId: intent.marketId,
    outcomeId: 'YES' as const,
    side: 'BUY' as const,
    size: { buyAmount: '50' },
  };

  function watcher(): { watcher: QuoteStreamPriceWatcher; stream: FakeQuoteStream; rest: number } {
    const stream = new FakeQuoteStream();
    const state = { rest: 0 };
    const instance = new QuoteStreamPriceWatcher({
      stream,
      fallback: async () => {
        state.rest += 1;
        return await Promise.resolve('0.600000');
      },
    });
    return {
      watcher: instance,
      stream,
      get rest() {
        return state.rest;
      },
    };
  }

  it('shares one subscription between overlapping waits', async () => {
    const h = watcher();
    const first = h.watcher.watch(request);
    const second = h.watcher.watch(request);
    expect(h.stream.subscribed).toHaveLength(1);

    // Idempotent, and reference counted: the release that ends the subscription
    // is the last one, not the first.
    first();
    first();
    expect(h.stream.releases).toBe(0);
    second();
    expect(h.stream.releases).toBe(1);
  });

  it('reads the ask for a BUY and falls back once the feed can no longer be trusted', async () => {
    const h = watcher();
    const release = h.watcher.watch(request);

    h.stream.push(frame({ ask: '0.490000', bid: '0.480000' }));
    expect(await h.watcher.currentPrice(request)).toBe('0.490000');
    expect(h.rest).toBe(0);

    // A gap, a disconnect or a rejection all mean the same thing: the cached
    // price is no longer backed by a live feed. It is dropped, not aged.
    h.stream.drop('DISCONNECTED');
    expect(await h.watcher.currentPrice(request)).toBe('0.600000');
    expect(h.rest).toBe(1);
    release();
  });

  it('wakes a wait as soon as a frame lands, and sleeps out its ceiling otherwise', async () => {
    const h = watcher();
    const release = h.watcher.watch(request);

    const woken = h.watcher.waitForChange(request, 60_000);
    h.stream.push(frame({ seq: '2' }));
    await expect(woken).resolves.toBeUndefined();

    // A frame that lands while the caller is mid-request must not be slept
    // through: it is the move the wait exists to catch.
    h.stream.push(frame({ seq: '3' }));
    await expect(h.watcher.waitForChange(request, 60_000)).resolves.toBeUndefined();

    // Nothing pending, so this one is bounded by its ceiling rather than a frame.
    const start = Date.now();
    await h.watcher.waitForChange(request, 20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
    release();
  });

  it('falls back to a plain sleep for a topic nobody is watching', async () => {
    const h = watcher();
    const start = Date.now();
    await h.watcher.waitForChange(request, 20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
    expect(await h.watcher.currentPrice(request)).toBe('0.600000');
  });
});
