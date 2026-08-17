/**
 * Tests the SHIPPED Socket.IO quote stream.
 *
 * Everything goes through the `connect` seam, so no socket is opened and no port
 * is bound, and every timer is driven by fake timers rather than waited out.
 *
 * What is asserted is the part that is easy to get wrong and expensive when it
 * is: the subscribe that must not be sent before the handshake is accepted, the
 * sequence break that means a trigger was missed, the resume that a reconnect
 * owes, the heartbeat that is the only thing separating a quiet market from a
 * dead socket, the refusals that must not be retried and the ones that must, and
 * the sockets and timers that must not outlive the wait that opened them.
 *
 * The property none of this can weaken, covered in `quote-stream-trigger.test.ts`:
 * a streamed price is a TRIGGER. An order is priced off a fresh executable quote,
 * every time, whatever the stream said.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PREDICT_AGENT_STREAM_NAMESPACE,
  PREDICT_EXECUTION_STREAM,
  PREDICT_QUOTE_HEARTBEAT,
  PREDICT_QUOTE_STREAM,
  PREDICT_QUOTE_STREAM_HEARTBEAT_MS,
  PREDICT_QUOTE_STREAM_MAX_TOPICS,
  PREDICT_QUOTE_SUBSCRIBE,
  PREDICT_QUOTE_SUBSCRIPTION,
  PREDICT_QUOTE_UNSUBSCRIBE,
  PREDICT_STREAM_READY,
  type PredictQuoteRejectionReason,
  type PredictQuoteStreamFrame,
  type PredictQuoteTopic,
} from '../src/contract.ts';
import type { StreamHandshake } from '../src/execution-stream.ts';
import {
  type QuoteSocket,
  type QuoteStreamEvent,
  SocketQuoteStream,
  type SocketQuoteStreamOptions,
  streamTriggerPrice,
} from '../src/quote-stream.ts';

const TOPIC = { marketId: 'mkt-1', outcomeId: 'YES' } as const;

interface Sent {
  event: string;
  payload: { topics: { marketId: string; outcomeId: string }[]; resume?: boolean };
}

/** A socket whose events this test drives by hand. */
class FakeSocket implements QuoteSocket {
  readonly handlers = new Map<string, (payload: unknown) => void>();
  readonly sent: Sent[] = [];
  disconnects = 0;
  throwOnDisconnect = false;
  throwOnEmit = false;

  on(event: string, listener: (payload: unknown) => void): void {
    this.handlers.set(event, listener);
  }

  /** Client → server. */
  emit(event: string, payload: unknown): void {
    if (this.throwOnEmit) throw new Error('socket closed');
    this.sent.push({ event, payload: payload as Sent['payload'] });
  }

  disconnect(): void {
    this.disconnects += 1;
    if (this.throwOnDisconnect) throw new Error('socket already closed');
  }

  /** Server → client. */
  deliver(event: string, payload: unknown): void {
    this.handlers.get(event)?.(payload);
  }

  ready(): void {
    this.deliver(PREDICT_STREAM_READY, {
      stream: PREDICT_EXECUTION_STREAM,
      agentWallet: '0xagent',
      cursor: null,
      replayed: 0,
      gap: false,
    });
  }

  frame(
    seq: string,
    prices: { bid?: string | null; ask?: string | null } = {},
    extra: { kind?: 'SNAPSHOT' | 'UPDATE'; gap?: boolean; stale?: boolean } = {},
  ): void {
    this.deliver(PREDICT_QUOTE_STREAM, {
      stream: PREDICT_QUOTE_STREAM,
      ...TOPIC,
      kind: extra.kind ?? 'UPDATE',
      seq,
      gap: extra.gap ?? false,
      indicativeBid: prices.bid ?? '0.410000',
      indicativeAsk: prices.ask ?? '0.430000',
      impliedProbability: '0.420000',
      qualityFlags: ['INDICATIVE_ONLY', 'TOP_OF_BOOK_ONLY'],
      freshness: {
        observedAt: '2026-08-17T00:00:00.000Z',
        sourceTimestamp: '2026-08-17T00:00:00.000Z',
        sourceAgeMs: 1_000,
        emittedAt: '2026-08-17T00:00:01.000Z',
        pollIntervalMs: 2_000,
        staleAfterMs: 15_000,
        stale: extra.stale ?? false,
      },
    });
  }

  heartbeat(topics: { marketId: string; outcomeId: string; seq: string; stale: boolean }[]): void {
    this.deliver(PREDICT_QUOTE_HEARTBEAT, {
      stream: PREDICT_QUOTE_STREAM,
      serverTime: '2026-08-17T00:00:15.000Z',
      intervalMs: PREDICT_QUOTE_STREAM_HEARTBEAT_MS,
      topics,
    });
  }

  reject(reason: PredictQuoteRejectionReason, topic: PredictQuoteTopic = TOPIC): void {
    this.deliver(PREDICT_QUOTE_SUBSCRIPTION, {
      stream: PREDICT_QUOTE_STREAM,
      accepted: [],
      rejected: [{ ...topic, reason }],
      subscribed: 0,
      limit: PREDICT_QUOTE_STREAM_MAX_TOPICS,
    });
  }
}

interface Harness {
  stream: SocketQuoteStream;
  sockets: FakeSocket[];
  urls: string[];
  handshakes: StreamHandshake[];
  connected: () => Promise<FakeSocket>;
  /** The transport asks for a fresh handshake and produces a fresh socket. */
  reconnect: () => Promise<FakeSocket>;
}

function harness(options: Partial<SocketQuoteStreamOptions> = {}): Harness {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const handshakes: StreamHandshake[] = [];
  let build: (() => Promise<StreamHandshake>) | undefined;

  const stream = new SocketQuoteStream({
    baseUrl: 'https://api.test/',
    token: async () => await Promise.resolve('tok'),
    ...options,
    connect: async ({ url, handshake }) => {
      urls.push(url);
      build = handshake;
      handshakes.push(await handshake());
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });

  const connected = async (): Promise<FakeSocket> => {
    await vi.waitFor(() => {
      expect(sockets.length).toBeGreaterThan(0);
    });
    const socket = sockets.at(-1);
    if (socket === undefined) throw new Error('no socket');
    return socket;
  };

  return {
    stream,
    sockets,
    urls,
    handshakes,
    connected,
    // socket.io owns reconnection and reuses ONE Socket object across it: the
    // transport asks for a fresh handshake, and the same object comes back
    // connected. Modelling it as a new object would let a bug that emits on the
    // dead socket pass, so the same instance is returned with its outbox cleared.
    reconnect: async () => {
      const socket = await connected();
      if (build === undefined) throw new Error('never connected');
      handshakes.push(await build());
      socket.sent.length = 0;
      return socket;
    },
  };
}

function record(): { events: QuoteStreamEvent[]; listener: (event: QuoteStreamEvent) => void } {
  const events: QuoteStreamEvent[] = [];
  return { events, listener: (event) => events.push(event) };
}

function reasons(events: QuoteStreamEvent[]): string[] {
  return events.filter((event) => event.type === 'UNAVAILABLE').map((event) => event.reason);
}

/** Let the connector promise and the zero-delay flush both settle. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SocketQuoteStream', () => {
  it('connects to the agent namespace and subscribes only after the handshake is accepted', async () => {
    const h = harness();
    const { events, listener } = record();
    h.stream.onQuote(TOPIC, listener);

    const socket = await h.connected();
    expect(h.urls).toEqual([`https://api.test${PREDICT_AGENT_STREAM_NAMESPACE}`]);
    // No cursor: this feed has no log to replay, and asking for one on the shared
    // namespace would deliver execution frames nobody here reads.
    expect(h.handshakes[0]).toEqual({ token: 'tok' });

    // Nothing sent yet — the gateway disconnects a socket whose handshake it
    // refused, and topics pushed into that window are silently dropped.
    await settle();
    expect(socket.sent).toEqual([]);

    socket.ready();
    await settle();
    expect(socket.sent).toEqual([
      { event: PREDICT_QUOTE_SUBSCRIBE, payload: { topics: [TOPIC] } },
    ]);

    socket.frame('1', {}, { kind: 'SNAPSHOT' });
    expect(events).toEqual([
      { type: 'FRAME', frame: expect.objectContaining({ seq: '1', kind: 'SNAPSHOT' }) },
    ]);
    h.stream.close();
  });

  it('batches a burst of topics into one subscribe message', async () => {
    // The server allows 60 subscribe messages per rolling minute. Twenty topics
    // opened in a loop must cost one message, not twenty.
    const h = harness();
    for (let index = 0; index < 20; index += 1) {
      h.stream.onQuote({ marketId: `mkt-${String(index)}`, outcomeId: 'YES' }, () => undefined);
    }
    const socket = await h.connected();
    socket.ready();
    await settle();

    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]?.payload.topics).toHaveLength(20);
    h.stream.close();
  });

  it('reports a sequence break and still delivers the frame', async () => {
    const h = harness();
    const { events, listener } = record();
    h.stream.onQuote(TOPIC, listener);
    const socket = await h.connected();
    socket.ready();
    await settle();

    socket.frame('1', {}, { kind: 'SNAPSHOT' });
    socket.frame('2');
    expect(reasons(events)).toEqual([]);

    socket.frame('5', { ask: '0.500000' });
    // GAP first, then the frame: a consumer that caches on FRAME must invalidate
    // before it caches. The frame itself is complete current state — what a gap
    // costs on a state feed is intermediate values, i.e. triggers.
    expect(events.slice(-2)).toEqual([
      { type: 'UNAVAILABLE', reason: 'GAP' },
      { type: 'FRAME', frame: expect.objectContaining({ seq: '5' }) },
    ]);
    // Not re-subscribed: there is nothing to catch up to, and asking would spend
    // the message budget to be told the same current state.
    expect(socket.sent).toHaveLength(1);
    h.stream.close();
  });

  it('treats a server-declared snapshot gap as a gap', async () => {
    const h = harness();
    const { events, listener } = record();
    h.stream.onQuote(TOPIC, listener);
    const socket = await h.connected();
    socket.ready();
    await settle();

    socket.frame('7', {}, { kind: 'SNAPSHOT', gap: true });
    expect(reasons(events)).toEqual(['GAP']);
    h.stream.close();
  });

  it('resumes every held topic on reconnect and restarts its sequence', async () => {
    const h = harness();
    const { events, listener } = record();
    h.stream.onQuote(TOPIC, listener);
    const first = await h.connected();
    first.ready();
    await settle();
    first.frame('9', {}, { kind: 'SNAPSHOT' });

    const second = await h.reconnect();
    second.ready();
    await settle();

    // Every cached price is invalidated: this feed cannot say what moved while we
    // were away, so a wait prices off REST until the snapshot lands.
    expect(reasons(events)).toEqual(['DISCONNECTED']);
    expect(second.sent).toEqual([
      { event: PREDICT_QUOTE_SUBSCRIBE, payload: { topics: [TOPIC], resume: true } },
    ]);

    // Sequences restart per connection. `1` after `9` is not a gap; keeping the
    // old sequence would either invent one here or hide a real one later.
    second.frame('1', {}, { kind: 'SNAPSHOT' });
    expect(reasons(events)).toEqual(['DISCONNECTED']);
    second.frame('3');
    expect(reasons(events)).toEqual(['DISCONNECTED', 'GAP']);
    h.stream.close();
  });

  it('detects frames dropped in a quiet market from the heartbeat sequence', async () => {
    // Updates are change-only, so without this a dropped frame in a slow market
    // goes unnoticed until the next move — which may be the move being waited for.
    const h = harness();
    const { events, listener } = record();
    h.stream.onQuote(TOPIC, listener);
    const socket = await h.connected();
    socket.ready();
    await settle();
    socket.frame('4', {}, { kind: 'SNAPSHOT' });

    socket.heartbeat([{ ...TOPIC, seq: '4', stale: false }]);
    expect(reasons(events)).toEqual([]);

    socket.heartbeat([{ ...TOPIC, seq: '6', stale: false }]);
    expect(reasons(events)).toEqual(['GAP']);
    // Adopted, so the next heartbeat at the same sequence does not re-report it.
    socket.heartbeat([{ ...TOPIC, seq: '6', stale: false }]);
    expect(reasons(events)).toEqual(['GAP']);
    h.stream.close();
  });

  it('rebuilds a connection that goes silent for two heartbeats', async () => {
    // A half-open TCP connection looks perfectly healthy from the client side
    // while delivering nothing, which is why this is not left to socket.io.
    const h = harness({ maxSilentWindows: 5 });
    const { events, listener } = record();
    h.stream.onQuote(TOPIC, listener);
    const socket = await h.connected();
    socket.ready();
    await settle();
    socket.frame('1', {}, { kind: 'SNAPSHOT' });

    await vi.advanceTimersByTimeAsync(2 * PREDICT_QUOTE_STREAM_HEARTBEAT_MS + 5_001);

    expect(reasons(events)).toContain('DISCONNECTED');
    expect(socket.disconnects).toBe(1);
    expect(h.sockets).toHaveLength(2);
    h.stream.close();
  });

  it('counts a connection that opens and then says nothing as silence', async () => {
    // A transport that connects and never delivers a ready frame is the quietest
    // failure there is: without a watchdog armed at open, the client would sit
    // connected and mute and never spend the budget it is meant to spend.
    const degraded: string[] = [];
    const h = harness({ maxSilentWindows: 1, onDegraded: (reason) => degraded.push(reason) });
    h.stream.onQuote(TOPIC, () => undefined);
    const socket = await h.connected();

    await vi.advanceTimersByTimeAsync(2 * PREDICT_QUOTE_STREAM_HEARTBEAT_MS + 5_001);
    expect(h.stream.isDegraded).toBe(true);
    expect(degraded).toHaveLength(1);
    expect(socket.disconnects).toBe(1);
    h.stream.close();
  });

  it('gives up to polling after a bounded number of silent windows', async () => {
    const degraded: string[] = [];
    const h = harness({
      maxSilentWindows: 2,
      onDegraded: (reason) => degraded.push(reason),
    });
    const { events, listener } = record();
    h.stream.onQuote(TOPIC, listener);
    const socket = await h.connected();
    socket.ready();
    await settle();

    for (let window = 0; window < 2; window += 1) {
      await vi.advanceTimersByTimeAsync(2 * PREDICT_QUOTE_STREAM_HEARTBEAT_MS + 5_001);
      const latest = h.sockets.at(-1);
      if (latest !== undefined && latest !== socket) latest.ready();
      await settle();
    }

    expect(h.stream.isDegraded).toBe(true);
    expect(degraded).toHaveLength(1);
    expect(reasons(events)).toContain('DEGRADED');

    // A later watcher is told immediately rather than left waiting on a frame
    // that will never arrive.
    const { events: later, listener: laterListener } = record();
    h.stream.onQuote(TOPIC, laterListener);
    expect(reasons(later)).toEqual(['DEGRADED']);
    h.stream.close();
  });

  it('stops after a bounded number of refused handshakes and refreshes the token first', async () => {
    // A server that refuses a credential keeps refusing it; a login loop is worse
    // than polling.
    const refreshed: string[] = [];
    const h = harness({
      maxHandshakeFailures: 2,
      refreshToken: async (rejected) => {
        refreshed.push(rejected);
        return await Promise.resolve('tok-2');
      },
    });
    h.stream.onQuote(TOPIC, () => undefined);
    const first = await h.connected();

    first.deliver('error', { reason: 'invalid_token' });
    const second = await h.reconnect();
    // Replaced BEFORE reconnecting: presenting the token the server just refused
    // would spend the budget on a guaranteed no.
    expect(refreshed).toEqual(['tok']);
    expect(h.handshakes.at(-1)).toEqual({ token: 'tok-2' });

    second.deliver('error', { reason: 'invalid_token' });
    expect(h.stream.isDegraded).toBe(true);
    h.stream.close();
  });

  it('never re-asks for a terminally refused topic, and retries a temporary one', async () => {
    const h = harness({ retryRejectedMs: 30_000 });
    const closed = record();
    const quiet = record();
    h.stream.onQuote(TOPIC, closed.listener);
    const other = { marketId: 'mkt-2', outcomeId: 'NO' } as const;
    h.stream.onQuote(other, quiet.listener);
    const socket = await h.connected();
    socket.ready();
    await settle();
    expect(socket.sent).toHaveLength(1);

    // MARKET_CLOSED is terminal for the round; NOT_QUOTABLE is temporary. A
    // strategy stops on the first and pauses on the second, never the reverse.
    socket.reject('MARKET_CLOSED');
    socket.reject('NOT_QUOTABLE', other);
    expect(reasons(closed.events)).toEqual(['MARKET_CLOSED']);
    expect(reasons(quiet.events)).toEqual(['NOT_QUOTABLE']);

    await vi.advanceTimersByTimeAsync(30_001);
    expect(socket.sent).toHaveLength(2);
    expect(socket.sent[1]).toEqual({
      event: PREDICT_QUOTE_SUBSCRIBE,
      payload: { topics: [other] },
    });
    h.stream.close();
  });

  it('does not re-subscribe a terminally refused topic across a reconnect', async () => {
    const h = harness();
    h.stream.onQuote(TOPIC, () => undefined);
    const first = await h.connected();
    first.ready();
    await settle();
    first.reject('UNKNOWN_MARKET');

    const second = await h.reconnect();
    second.ready();
    await settle();
    expect(second.sent).toEqual([]);
    h.stream.close();
  });

  it('disconnects when the last listener releases, leaving no timers behind', async () => {
    const h = harness();
    const release = h.stream.onQuote(TOPIC, () => undefined);
    const second = h.stream.onQuote(TOPIC, () => undefined);
    const socket = await h.connected();
    socket.ready();
    await settle();

    // Reference counted, and idempotent: the first release must not evict the
    // second watcher, and releasing twice must not either.
    release();
    release();
    await settle();
    expect(socket.sent).toHaveLength(1);
    expect(socket.disconnects).toBe(0);

    second();
    await settle();
    // No unsubscribe: the disconnect below releases every topic server-side, so
    // sending one would spend a message from the rate budget to say the same
    // thing. The unsubscribe path exists for a socket that stays open — the next
    // test covers it.
    expect(socket.sent).toHaveLength(1);
    expect(socket.disconnects).toBe(1);
    // Nothing left holding the event loop open.
    expect(vi.getTimerCount()).toBe(0);
    h.stream.close();
  });

  it('unsubscribes a released topic from a socket it is holding open', async () => {
    const h = harness({ idleDisconnectMs: 30_000 });
    const release = h.stream.onQuote(TOPIC, () => undefined);
    const other = { marketId: 'mkt-2', outcomeId: 'NO' } as const;
    h.stream.onQuote(other, () => undefined);
    const socket = await h.connected();
    socket.ready();
    await settle();

    release();
    await settle();
    expect(socket.sent[1]).toEqual({
      event: PREDICT_QUOTE_UNSUBSCRIBE,
      payload: { topics: [TOPIC] },
    });
    expect(socket.disconnects).toBe(0);
    h.stream.close();
  });

  it('drops a socket that arrives after every topic was released', async () => {
    // The connector takes at least a tick. A wait that ends inside that window
    // must not leave a connected socket behind.
    const h = harness();
    const release = h.stream.onQuote(TOPIC, () => undefined);
    release();
    const socket = await h.connected();
    expect(socket.disconnects).toBe(1);
    h.stream.close();
  });

  it('survives a listener, an emit and a disconnect that throw', async () => {
    const h = harness();
    const seen: QuoteStreamEvent[] = [];
    h.stream.onQuote(TOPIC, () => {
      throw new Error('listener exploded');
    });
    h.stream.onQuote(TOPIC, (event) => seen.push(event));
    const socket = await h.connected();
    socket.throwOnDisconnect = true;
    socket.ready();
    await settle();

    socket.frame('1', {}, { kind: 'SNAPSHOT' });
    expect(seen).toHaveLength(1);

    socket.throwOnEmit = true;
    expect(() => {
      h.stream.close();
    }).not.toThrow();
  });

  it('reports an unreadable frame as a gap rather than repairing it', async () => {
    // A frame with an unreadable freshness block could be a stale value whose flag
    // did not survive serialization; defaulting that to "fresh" is how a strategy
    // trades off a price the server had already withdrawn.
    const h = harness();
    const { events, listener } = record();
    h.stream.onQuote(TOPIC, listener);
    const socket = await h.connected();
    socket.ready();
    await settle();

    socket.deliver(PREDICT_QUOTE_STREAM, { ...TOPIC, kind: 'UPDATE', seq: '1' });
    expect(events).toEqual([{ type: 'UNAVAILABLE', reason: 'GAP' }]);

    // An unreadable topic cannot even be attributed, so it is dropped silently.
    socket.deliver(PREDICT_QUOTE_STREAM, { marketId: 'mkt-1' });
    expect(events).toHaveLength(1);
    h.stream.close();
  });
});

describe('streamTriggerPrice', () => {
  const frame = (
    bid: string | null,
    ask: string | null,
    stale = false,
  ): PredictQuoteStreamFrame => ({
    stream: PREDICT_QUOTE_STREAM,
    ...TOPIC,
    kind: 'UPDATE',
    seq: '1',
    gap: false,
    indicativeBid: bid,
    indicativeAsk: ask,
    impliedProbability: null,
    qualityFlags: [],
    freshness: {
      observedAt: null,
      sourceTimestamp: null,
      sourceAgeMs: null,
      emittedAt: '2026-08-17T00:00:00.000Z',
      pollIntervalMs: 2_000,
      staleAfterMs: 15_000,
      stale,
    },
  });

  it('reads a BUY off the ask and a SELL off the bid', () => {
    // The same two sides POST /quotes prices, so a trigger can never fire off a
    // book the order is not priced against.
    expect(streamTriggerPrice('BUY', frame('0.410000', '0.430000'))).toBe('0.430000');
    expect(streamTriggerPrice('SELL', frame('0.410000', '0.430000'))).toBe('0.410000');
  });

  it('has no price for a stale frame or a missing side', () => {
    expect(streamTriggerPrice('BUY', frame('0.410000', '0.430000', true))).toBeNull();
    expect(streamTriggerPrice('BUY', frame('0.410000', null))).toBeNull();
  });
});
