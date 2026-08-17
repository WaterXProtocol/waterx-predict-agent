/**
 * The observer's contract, which is mostly a contract about silence.
 *
 * Two failures matter more than everything else here and each has its own test:
 * reporting a price the feed can no longer vouch for, and reporting nothing when
 * the feed is perfectly healthy. The first trades on a number from the past; the
 * second is a strategy that quietly never fires. Everything else — subscribing
 * once, letting a market go, closing — is bookkeeping in service of those two.
 *
 * No sockets. `QuoteStream` is a seam, so the fake below is a legitimate
 * implementation of it rather than a stand-in for one, and it lets a test say
 * "the connection dropped" without a connection.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type {
  PredictQuoteStreamFrame,
  PredictQuoteTopic,
  QuoteListener,
  QuoteStream,
  QuoteStreamEvent,
} from '@waterx/predict-agent-sdk';

import { QuoteStreamPriceObserver } from '../src/prices.ts';
import type { WatchKey } from '../src/strategy/gateway.ts';
import { later, T0 } from './harness.ts';

const MARKET = 'mkt_1';
const BUY: WatchKey = { marketId: MARKET, outcomeId: 'YES', side: 'BUY' };
const SELL: WatchKey = { marketId: MARKET, outcomeId: 'YES', side: 'SELL' };
const OTHER: WatchKey = { marketId: 'mkt_2', outcomeId: 'NO', side: 'BUY' };

const frame = (
  overrides: Partial<PredictQuoteStreamFrame> & Pick<PredictQuoteTopic, 'marketId' | 'outcomeId'>,
): PredictQuoteStreamFrame => ({
  stream: 'predict.quotes.v1',
  kind: 'SNAPSHOT',
  seq: '1',
  gap: false,
  indicativeBid: '0.8100',
  indicativeAsk: '0.8300',
  impliedProbability: '0.8200',
  qualityFlags: ['INDICATIVE_ONLY'],
  freshness: {
    observedAt: T0,
    sourceTimestamp: T0,
    sourceAgeMs: 0,
    emittedAt: T0,
    pollIntervalMs: 2_000,
    staleAfterMs: 30_000,
    stale: false,
  },
  ...overrides,
});

/** One live topic on the fake stream: who is listening, and whether it still is. */
interface Subscription {
  readonly topic: PredictQuoteTopic;
  readonly listener: QuoteListener;
  released: boolean;
}

class FakeStream implements QuoteStream {
  readonly subscriptions: Subscription[] = [];
  /** A frame handed to every subscriber the moment it subscribes. */
  snapshot: PredictQuoteStreamFrame | undefined;

  onQuote(topic: PredictQuoteTopic, listener: QuoteListener): () => void {
    const entry: Subscription = { topic, listener, released: false };
    this.subscriptions.push(entry);
    if (this.snapshot !== undefined) listener({ type: 'FRAME', frame: this.snapshot });
    return () => {
      entry.released = true;
    };
  }

  get live(): readonly Subscription[] {
    return this.subscriptions.filter((entry) => !entry.released);
  }

  /** Deliver to every live subscriber of a market/outcome. */
  push(topic: PredictQuoteTopic, event: QuoteStreamEvent): void {
    for (const entry of this.live) {
      if (entry.topic.marketId === topic.marketId && entry.topic.outcomeId === topic.outcomeId) {
        entry.listener(event);
      }
    }
  }
}

let stream: FakeStream;
let clock: string;
const now = (): string => clock;

const observerOf = (idleMs?: number): QuoteStreamPriceObserver =>
  new QuoteStreamPriceObserver({ stream, now, ...(idleMs === undefined ? {} : { idleMs }) });

beforeEach(() => {
  stream = new FakeStream();
  clock = T0;
});

describe('reading a price off the feed', () => {
  it('has nothing to say on the tick that subscribes', async () => {
    const observer = observerOf();

    // The first pass buys a subscription, not an answer: the snapshot has not
    // arrived. Answering anything here would mean inventing it.
    expect(await observer.observe(BUY)).toBeNull();
    expect(stream.live).toHaveLength(1);
    expect(stream.live[0]?.topic).toEqual({ marketId: MARKET, outcomeId: 'YES' });
  });

  it('reads the ask for a BUY and the bid for a SELL', async () => {
    stream.snapshot = frame({ marketId: MARKET, outcomeId: 'YES' });
    const observer = observerOf();

    // A BUY fires against what it would pay, a SELL against what it would
    // receive — the two sides `POST /quotes` prices, so trigger and quote read
    // the same book.
    expect(await observer.observe(BUY)).toBe('0.8300');
    expect(await observer.observe(SELL)).toBe('0.8100');
  });

  it('subscribes once per market and outcome, however many sides watch it', async () => {
    const observer = observerOf();

    await observer.observe(BUY);
    await observer.observe(SELL);
    await observer.observe(OTHER);

    expect(stream.live).toHaveLength(2);
    expect(stream.live.map((entry) => entry.topic.marketId)).toEqual([MARKET, 'mkt_2']);
  });

  it('follows the book as it moves', async () => {
    const observer = observerOf();
    await observer.observe(BUY);

    stream.push({ marketId: MARKET, outcomeId: 'YES' }, {
      type: 'FRAME',
      frame: frame({ marketId: MARKET, outcomeId: 'YES', kind: 'UPDATE', seq: '2' }),
    });
    expect(await observer.observe(BUY)).toBe('0.8300');

    stream.push({ marketId: MARKET, outcomeId: 'YES' }, {
      type: 'FRAME',
      frame: frame({ marketId: MARKET, outcomeId: 'YES', kind: 'UPDATE', seq: '3', indicativeAsk: '0.7900' }),
    });
    expect(await observer.observe(BUY)).toBe('0.7900');
  });

  it('answers a topic it holds without touching another market', async () => {
    stream.snapshot = frame({ marketId: MARKET, outcomeId: 'YES' });
    const observer = observerOf();
    await observer.observe(BUY);
    await observer.observe(OTHER);

    stream.push({ marketId: 'mkt_2', outcomeId: 'NO' }, { type: 'UNAVAILABLE', reason: 'GAP' });

    // The refusal belongs to one topic. The other's price is untouched by it.
    expect(await observer.observe(BUY)).toBe('0.8300');
    expect(await observer.observe(OTHER)).toBeNull();
  });
});

describe('the number it refuses to give back', () => {
  it('says nothing rather than the last price when a frame goes stale', async () => {
    const observer = observerOf();
    await observer.observe(BUY);
    stream.push({ marketId: MARKET, outcomeId: 'YES' }, {
      type: 'FRAME',
      frame: frame({ marketId: MARKET, outcomeId: 'YES' }),
    });
    expect(await observer.observe(BUY)).toBe('0.8300');

    // A stale frame carries null prices by protocol. Remembering `0.8300`
    // through it is exactly the bug the flag exists to prevent.
    stream.push({ marketId: MARKET, outcomeId: 'YES' }, {
      type: 'FRAME',
      frame: frame({
        marketId: MARKET,
        outcomeId: 'YES',
        kind: 'UPDATE',
        seq: '2',
        indicativeBid: null,
        indicativeAsk: null,
        qualityFlags: ['INDICATIVE_ONLY', 'STALE'],
        freshness: {
          observedAt: null,
          sourceTimestamp: null,
          sourceAgeMs: null,
          emittedAt: later(T0, 60_000),
          pollIntervalMs: 2_000,
          staleAfterMs: 30_000,
          stale: true,
        },
      }),
    });
    expect(await observer.observe(BUY)).toBeNull();
  });

  it.each([
    ['GAP', 'frames were dropped'],
    ['DISCONNECTED', 'the socket went away'],
    ['DEGRADED', 'the stream gave up'],
    ['MARKET_CLOSED', 'the server refused the topic'],
    ['NOT_QUOTABLE', 'the server refused the topic temporarily'],
  ] as const)('drops the cached price when %s (%s)', async (reason, _why) => {
    stream.snapshot = frame({ marketId: MARKET, outcomeId: 'YES' });
    const observer = observerOf();
    expect(await observer.observe(BUY)).toBe('0.8300');

    stream.push({ marketId: MARKET, outcomeId: 'YES' }, { type: 'UNAVAILABLE', reason });

    expect(await observer.observe(BUY)).toBeNull();
    expect(observer.topics()[0]?.unavailable).toBe(reason);
  });

  it('recovers on the next frame after an outage, without being re-subscribed', async () => {
    const observer = observerOf();
    await observer.observe(BUY);
    stream.push({ marketId: MARKET, outcomeId: 'YES' }, { type: 'UNAVAILABLE', reason: 'DISCONNECTED' });
    expect(await observer.observe(BUY)).toBeNull();

    stream.push({ marketId: MARKET, outcomeId: 'YES' }, {
      type: 'FRAME',
      frame: frame({ marketId: MARKET, outcomeId: 'YES', gap: true, seq: '1' }),
    });

    // A resumed snapshot admits it cannot account for what was missed, and is
    // still the current state. Every trigger here is a level test, so it is a
    // perfectly good answer to one — and the gap is recorded, not hidden.
    expect(await observer.observe(BUY)).toBe('0.8300');
    expect(observer.topics()[0]).toMatchObject({ gapped: true, unavailable: undefined });
    expect(stream.live).toHaveLength(1);
  });

  it('never mints a quote to fill a silence', async () => {
    // There is no size on a `WatchKey` and `POST /quotes` requires one, so the
    // only way to answer here would be to invent a probe size and mint a
    // priced, executable artifact to look at a number. The observer waits.
    const observer = observerOf();
    stream.push({ marketId: MARKET, outcomeId: 'YES' }, { type: 'UNAVAILABLE', reason: 'DEGRADED' });

    expect(await observer.observe(BUY)).toBeNull();
    expect(await observer.observe(BUY)).toBeNull();
    expect(stream.live).toHaveLength(1);
  });

  it('answers nothing for a pass that has already been fenced out', async () => {
    const observer = observerOf();
    const aborted = AbortSignal.abort(new Error('lease lost'));

    expect(await observer.observe(BUY, aborted)).toBeNull();
    // And it did not open a subscription for a job this Runner no longer holds.
    expect(stream.subscriptions).toHaveLength(0);
  });
});

describe('letting a market go', () => {
  it('releases a topic nobody has asked about', async () => {
    const observer = observerOf(60_000);
    await observer.observe(BUY);
    await observer.observe(OTHER);
    expect(stream.live).toHaveLength(2);

    clock = later(T0, 60_001);
    await observer.observe(OTHER);

    // The job watching mkt_1 is gone — cancelled, expired, or held by another
    // Runner. Nothing told the observer, and nothing had to.
    expect(stream.live.map((entry) => entry.topic.marketId)).toEqual(['mkt_2']);
    expect(observer.topics().map((topic) => topic.marketId)).toEqual(['mkt_2']);
  });

  it('keeps a topic that is still being watched, however long it has run', async () => {
    const observer = observerOf(60_000);
    await observer.observe(BUY);

    for (let tick = 1; tick <= 10; tick += 1) {
      clock = later(T0, tick * 59_000);
      await observer.observe(BUY);
    }

    expect(stream.live).toHaveLength(1);
    expect(stream.subscriptions).toHaveLength(1);
  });

  it('re-subscribes a market that comes back, and waits a tick for it', async () => {
    stream.snapshot = frame({ marketId: MARKET, outcomeId: 'YES' });
    const observer = observerOf(60_000);
    expect(await observer.observe(BUY)).toBe('0.8300');

    clock = later(T0, 60_001);
    await observer.observe(OTHER);
    expect(stream.live.map((entry) => entry.topic.marketId)).toEqual(['mkt_2']);

    // Back again: a fresh subscription, and this fake answers subscribes with a
    // snapshot, so the price is there. Against a real socket it would not be
    // until the snapshot lands, which costs one tick and never a wrong number.
    expect(await observer.observe(BUY)).toBe('0.8300');
    expect(stream.subscriptions).toHaveLength(3);
  });

  it('releases everything on close, and stays quiet afterwards', async () => {
    const observer = observerOf();
    await observer.observe(BUY);
    await observer.observe(OTHER);

    observer.close();
    observer.close();

    expect(stream.live).toHaveLength(0);
    expect(observer.topics()).toEqual([]);
    // Not a resurrection: a closed observer reports nothing rather than opening
    // a feed the caller has shut down.
    expect(await observer.observe(BUY)).toBeNull();
    expect(stream.subscriptions).toHaveLength(2);
  });
});

describe('what it is holding', () => {
  it('reports each topic without ever reporting a price', async () => {
    stream.snapshot = frame({ marketId: MARKET, outcomeId: 'YES' });
    const observer = observerOf();
    await observer.observe(BUY);
    clock = later(T0, 5_000);
    await observer.observe(OTHER);

    expect(observer.topics()).toEqual([
      {
        marketId: MARKET,
        outcomeId: 'YES',
        subscribedAt: T0,
        lastObservedAt: T0,
        lastAskedAt: T0,
        unavailable: undefined,
        gapped: false,
      },
      {
        marketId: 'mkt_2',
        outcomeId: 'NO',
        subscribedAt: later(T0, 5_000),
        lastObservedAt: later(T0, 5_000),
        lastAskedAt: later(T0, 5_000),
        unavailable: undefined,
        gapped: false,
      },
    ]);
    expect(JSON.stringify(observer.topics())).not.toContain('0.83');
  });

  it('shows a topic that has gone permanently quiet as DEGRADED rather than as absent', async () => {
    const observer = observerOf();
    await observer.observe(BUY);
    stream.push({ marketId: MARKET, outcomeId: 'YES' }, { type: 'UNAVAILABLE', reason: 'DEGRADED' });
    await observer.observe(BUY);

    // A strategy that will now wait forever without erroring is exactly the
    // thing an operator must be able to see.
    expect(observer.topics()).toMatchObject([{ marketId: MARKET, unavailable: 'DEGRADED' }]);
  });
});
