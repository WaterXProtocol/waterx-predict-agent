/**
 * Tests the ExecutionStream seam.
 *
 * The property that matters: a stream may only ACCELERATE a wait. Frames can be
 * lost (the server flags `gap: true` when its replay cursor was too old) and a
 * socket can die without saying so, so every one of these cases asserts that the
 * terminal answer still came from a REST read — and that a broken stream degrades
 * to polling rather than hanging a strategy forever.
 */
import { describe, expect, it, vi } from 'vitest';

import { PredictAgentClient } from '../src/client.ts';
import { PREDICT_EXECUTION_STREAM, PREDICT_STREAM_READY } from '../src/contract.ts';
import type { ExecutionStream, StreamConnector, StreamSocket } from '../src/execution-stream.ts';
import type { AgentSigner } from '../src/signer.ts';

const signer: AgentSigner = {
  signTransaction: (bytes) =>
    Promise.resolve({ signature: `sig(${String(bytes.length)})`, bytes: 'b' }),
  signPersonalMessage: (bytes) =>
    Promise.resolve({ signature: `personal(${String(bytes.length)})`, bytes: 'b' }),
  toSuiAddress: () => '0xagent',
};

const CREATED = {
  executionId: 'exec-1',
  status: 'AWAITING_SIGNATURE',
  sponsoredTransactionBytes: Buffer.from('tx-bytes').toString('base64'),
  sponsoredDigest: 'digest-1',
  signatureExpiresAt: '2026-07-30T00:01:00.000Z',
  referenceQuoteId: 'q-ref',
  submissionQuoteId: 'q-sub',
  enforcedWorstPrice: '0.505',
};
const SUBMITTED = { executionId: 'exec-1', status: 'SUBMITTED', transactionDigest: 'd' };
const PENDING = { executionId: 'exec-1', status: 'PENDING_FILL', transactionDigest: 'd' };
const FILLED = { executionId: 'exec-1', status: 'FILLED', transactionDigest: 'd' };

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const intent = {
  accountId: '0xacct',
  marketId: '0xmarket',
  outcomeId: 'YES' as const,
  side: 'BUY' as const,
  size: { buyAmount: '50' },
  referenceQuoteId: 'q-ref',
  maxSlippageBps: 100,
};

/** create → submit → then one GET per queued read. */
function makeClient(
  reads: unknown[],
  executionStream?: ExecutionStream | 'native',
  streamConnector?: StreamConnector,
): { client: PredictAgentClient; getCount: () => number } {
  let getIndex = 0;
  const fetch = ((url: URL | string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method === 'POST' && String(url).endsWith('/submit')) return Promise.resolve(json(SUBMITTED));
    if (method === 'POST') return Promise.resolve(json(CREATED, 201));
    const body = reads[Math.min(getIndex, reads.length - 1)];
    getIndex += 1;
    return Promise.resolve(json(body));
  }) as unknown as typeof globalThis.fetch;

  const client = new PredictAgentClient({
    baseUrl: 'https://api.test/',
    fetch,
    signer,
    token: 'tok',
    retry: { maxAttempts: 1, baseDelayMs: 0 },
    ...(executionStream !== undefined ? { executionStream } : {}),
    ...(streamConnector !== undefined ? { streamConnector } : {}),
  });
  return { client, getCount: () => getIndex };
}

describe('ExecutionStream', () => {
  it('still confirms the terminal state over REST, never from a frame', async () => {
    // Left undefined until the client actually subscribes — initialising it to a
    // no-op would let vi.waitFor pass before the subscription exists, and the
    // test would fire into the void and then sleep out the whole interval.
    let fire: (() => void) | undefined;
    const stream: ExecutionStream = {
      onExecutionUpdate: (_id: string, listener: () => void) => {
        fire = listener;
        return () => undefined;
      },
    };
    // The stream fires while the execution is STILL pending. If a frame were
    // treated as the answer, this would resolve as PENDING_FILL.
    const { client } = makeClient([PENDING, FILLED], stream);

    const promise = client.executeMarketOrder(intent, { waitFor: 'TERMINAL', pollIntervalMs: 10_000 });
    await vi.waitFor(() => expect(fire).toBeDefined());
    fire?.();
    fire?.();

    const result = await promise;
    expect(result.status).toBe('FILLED');
  });

  it('wakes on a frame instead of sleeping out the poll interval', async () => {
    // Left undefined until the client actually subscribes — initialising it to a
    // no-op would let vi.waitFor pass before the subscription exists, and the
    // test would fire into the void and then sleep out the whole interval.
    let fire: (() => void) | undefined;
    const stream: ExecutionStream = {
      onExecutionUpdate: (_id: string, listener: () => void) => {
        fire = listener;
        return () => undefined;
      },
    };
    const { client } = makeClient([PENDING, FILLED], stream);

    const startedAt = Date.now();
    // A 30 s interval: without the push wake-up this cannot finish quickly.
    const promise = client.executeMarketOrder(intent, { waitFor: 'TERMINAL', pollIntervalMs: 30_000 });
    await vi.waitFor(() => expect(fire).toBeDefined());
    fire?.();

    await expect(promise).resolves.toMatchObject({ status: 'FILLED' });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('degrades to polling when the stream never fires, rather than hanging', async () => {
    // An adapter whose socket died: it subscribes and then goes silent forever.
    const stream: ExecutionStream = { onExecutionUpdate: () => () => undefined };
    const { client } = makeClient([PENDING, FILLED], stream);

    // The poll interval remains a FLOOR on liveness precisely for this case.
    await expect(
      client.executeMarketOrder(intent, { waitFor: 'TERMINAL', pollIntervalMs: 1 }),
    ).resolves.toMatchObject({ status: 'FILLED' });
  });

  it('unsubscribes once the wait ends', async () => {
    const unsubscribe = vi.fn();
    const stream: ExecutionStream = { onExecutionUpdate: () => unsubscribe };
    const { client } = makeClient([FILLED], stream);

    await client.executeMarketOrder(intent, { waitFor: 'TERMINAL', pollIntervalMs: 1 });

    // A wait that leaks its listener leaks a socket handler per trade.
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('does not fail a completed trade when unsubscribing throws', async () => {
    const stream: ExecutionStream = {
      onExecutionUpdate: () => () => {
        throw new Error('socket already closed');
      },
    };
    const { client } = makeClient([FILLED], stream);

    // The trade is already done by the time cleanup runs; a teardown error must
    // not turn a filled order into a thrown call.
    await expect(
      client.executeMarketOrder(intent, { waitFor: 'TERMINAL', pollIntervalMs: 1 }),
    ).resolves.toMatchObject({ status: 'FILLED' });
  });

  it('polls exactly as before when no stream is supplied', async () => {
    const { client, getCount } = makeClient([PENDING, FILLED]);

    await client.executeMarketOrder(intent, { waitFor: 'TERMINAL', pollIntervalMs: 1 });

    // Two reads: the pending one and the terminal one.
    expect(getCount()).toBe(2);
  });
});

/**
 * The `executionStream: 'native'` wiring — that asking for the shipped stream
 * actually reaches the transport, using this client's own base URL and session,
 * and that the socket it opens belongs to the client and can be released.
 * `socket-execution-stream.test.ts` covers the protocol behind the seam.
 */
describe('the native execution stream option', () => {
  /** Captures the socket the client opens without connecting to anything. */
  function fakeTransport(): {
    connect: StreamConnector;
    urls: string[];
    tokens: string[];
    socket: () => FakeSocket | undefined;
    fire: (executionId: string, cursor?: string) => void;
  } {
    const urls: string[] = [];
    const tokens: string[] = [];
    let opened: FakeSocket | undefined;
    return {
      urls,
      tokens,
      socket: () => opened,
      fire: (executionId, cursor = '1') => {
        opened?.handlers.get(PREDICT_EXECUTION_STREAM)?.({ cursor, executionId });
      },
      connect: async ({ url, handshake }) => {
        urls.push(url);
        tokens.push((await handshake()).token);
        opened = new FakeSocket();
        return opened;
      },
    };
  }

  class FakeSocket implements StreamSocket {
    readonly handlers = new Map<string, (payload: unknown) => void>();
    disconnects = 0;
    on(event: string, listener: (payload: unknown) => void): void {
      this.handlers.set(event, listener);
    }
    disconnect(): void {
      this.disconnects += 1;
    }
  }

  it('streams over the client session and still settles from REST', async () => {
    const transport = fakeTransport();
    const { client } = makeClient([PENDING, FILLED], 'native', transport.connect);

    const promise = client.executeMarketOrder(intent, {
      waitFor: 'TERMINAL',
      pollIntervalMs: 30_000,
    });
    await vi.waitFor(() => expect(transport.socket()).toBeDefined());
    // A ready frame first, exactly as the server sends it, then the update.
    transport.socket()?.handlers.get(PREDICT_STREAM_READY)?.({ cursor: '1', gap: false });
    transport.fire('exec-1');

    // FILLED comes from the REST read the frame provoked, never from the frame.
    await expect(promise).resolves.toMatchObject({ status: 'FILLED' });
    // The stream's namespace hangs off the same base URL as the REST calls, and
    // the handshake presents the same session token.
    expect(transport.urls[0]).toBe('https://api.test/agent-api/v1/predict');
    expect(transport.tokens).toEqual(['tok']);

    client.close();
  });

  it('releases the socket when the wait ends rather than holding the process open', async () => {
    const transport = fakeTransport();
    const { client } = makeClient([FILLED], 'native', transport.connect);

    await client.waitForExecution('exec-1', { pollIntervalMs: 1 });
    const first = transport.socket();

    // The default is to drop the socket with the last waiter, so a one-shot CLI
    // exits the moment its trade settles instead of waiting on a live handle.
    expect(first?.disconnects).toBe(1);

    await client.waitForExecution('exec-2', { pollIntervalMs: 1 });

    // …and the next wait reconnects, on the same stream object.
    expect(transport.urls).toHaveLength(2);
    expect(transport.socket()).not.toBe(first);
  });

  it('closes a socket that is still mid-wait, and stays safe when called twice', async () => {
    const transport = fakeTransport();
    const { client } = makeClient([PENDING], 'native', transport.connect);

    const promise = client.waitForExecution('exec-1', { pollIntervalMs: 5, timeoutMs: 100 });
    await vi.waitFor(() => expect(transport.socket()).toBeDefined());

    client.close();

    expect(transport.socket()?.disconnects).toBe(1);
    // Closing the accelerator does not fail the wait: it falls back to the poll
    // interval and still reports what it last saw.
    await expect(promise).resolves.toMatchObject({ timedOut: true, status: 'PENDING_FILL' });
    // Idempotent: a `finally { client.close() }` that runs twice is not a bug.
    expect(() => client.close()).not.toThrow();
  });

  it('holds nothing to close when no stream was asked for', () => {
    const { client } = makeClient([FILLED]);

    expect(() => client.close()).not.toThrow();
  });
});

/**
 * The wait's own bounds. A stream changes when the loop looks; it must not change
 * whether the loop can be stopped, or how long past its deadline it may run.
 */
describe('wait loop timeout and abort', () => {
  it('stops within the timeout even when the poll interval is far longer', async () => {
    const { client } = makeClient([PENDING]);

    const startedAt = Date.now();
    const result = await client.waitForExecution('exec-1', {
      timeoutMs: 20,
      pollIntervalMs: 30_000,
    });

    // Sleeping the whole interval would overshoot the caller's deadline by 30 s —
    // a strategy that asked to give up in 20 ms would be blocked past its next
    // decision. Timing out is not an error; it reports the last status to
    // reconcile from.
    expect(result).toMatchObject({ timedOut: true, status: 'PENDING_FILL' });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('gives up promptly when aborted mid-interval', async () => {
    const { client } = makeClient([PENDING]);
    const controller = new AbortController();

    const startedAt = Date.now();
    const promise = client.waitForExecution('exec-1', {
      timeoutMs: 60_000,
      pollIntervalMs: 30_000,
      signal: controller.signal,
    });
    // Once the loop is asleep on its interval, not before.
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();

    await expect(promise).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('wakes an aborted wait that is parked on a stream, not just on a timer', async () => {
    const stream: ExecutionStream = { onExecutionUpdate: () => () => undefined };
    const { client } = makeClient([PENDING], stream);
    const controller = new AbortController();

    const startedAt = Date.now();
    const promise = client.waitForExecution('exec-1', {
      timeoutMs: 60_000,
      pollIntervalMs: 30_000,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();

    await expect(promise).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it('does not accumulate abort listeners across a long-running wait', async () => {
    // A signal reused for hundreds of poll cycles, each adding a listener it never
    // removes, is a leak that ends in a MaxListeners warning and a retained
    // closure per cycle.
    const stream: ExecutionStream = { onExecutionUpdate: () => () => undefined };
    const { client } = makeClient([PENDING, PENDING, PENDING, FILLED], stream);
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, 'addEventListener');
    const removed = vi.spyOn(controller.signal, 'removeEventListener');

    await client.waitForExecution('exec-1', {
      timeoutMs: 60_000,
      pollIntervalMs: 1,
      signal: controller.signal,
    });

    expect(added.mock.calls.length).toBeGreaterThan(1);
    expect(removed.mock.calls.length).toBe(added.mock.calls.length);
  });
});
