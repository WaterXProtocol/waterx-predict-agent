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

import { type ExecutionStream, PredictAgentClient } from '../src/client.ts';
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
  executionStream?: ExecutionStream,
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
      onExecutionUpdate: (_id, listener) => {
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
      onExecutionUpdate: (_id, listener) => {
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
