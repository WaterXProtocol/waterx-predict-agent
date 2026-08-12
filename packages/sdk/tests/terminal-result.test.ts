/**
 * What a finished wait tells the caller.
 *
 * Two failure modes are worth this much test surface, because both book a trade
 * that did not happen:
 *
 *  - reading an ABSENT figure as zero. No fill means no shares and no cost, not
 *    "filled zero"; no separately observable fee means the price already carries
 *    it, not "the fee was 0"; no allowance figure means unknown, not "spent out".
 *  - reading a TIMEOUT as a failed order. The order is on-chain and a keeper may
 *    still fill it. A caller that catches an exception here and resubmits under a
 *    fresh key pays twice, so running out of time is returned as a fact.
 */
import { describe, expect, it } from 'vitest';

import { PredictAgentClient } from '../src/client.ts';
import { isTerminalExecutionStatus, toFeeFacts } from '../src/execution-facts.ts';
import type { AgentSigner } from '../src/signer.ts';

const AGENT = '0xagent';

const signer: AgentSigner = {
  signTransaction: (bytes) =>
    Promise.resolve({ signature: `sig(${String(bytes.length)})`, bytes: 'b' }),
  signPersonalMessage: (bytes) =>
    Promise.resolve({ signature: `personal(${String(bytes.length)})`, bytes: 'b' }),
  toSuiAddress: () => AGENT,
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

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

const SUBMITTED = { executionId: 'exec-1', status: 'SUBMITTED', transactionDigest: 'exec-digest' };

/** A real-shaped fill: decimals as STRINGS, and a null fee, as the server sends. */
const FILL = {
  filledAmount: '49.993412',
  filledShares: '98.500000',
  avgFillPrice: '0.507547',
  actualFee: null,
  txDigest: 'keeper-digest',
  filledAt: '2026-07-30T00:00:31.000Z',
};

const intent = {
  accountId: '0xacct',
  marketId: '0xmarket',
  outcomeId: 'YES' as const,
  side: 'BUY' as const,
  size: { buyAmount: '50' },
  referenceQuoteId: 'q-ref',
  maxSlippageBps: 100,
};

interface Call {
  url: string;
  method: string;
}

/**
 * A fetch double routed by URL, so a test can queue reads independently of how
 * many create/submit calls a leg makes. Reads are consumed in order and the last
 * one STICKS, which is what a real execution does once it is terminal.
 */
function server(reads: unknown[]): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  let readIndex = 0;
  const fetch = ((url: URL | string, init?: RequestInit) => {
    const call: Call = { url: String(url), method: init?.method ?? 'GET' };
    calls.push(call);
    if (call.method === 'POST' && call.url.endsWith('/executions')) {
      return Promise.resolve(json(201, CREATED));
    }
    if (call.url.endsWith('/submit')) return Promise.resolve(json(202, SUBMITTED));
    const read = reads[Math.min(readIndex, reads.length - 1)];
    readIndex += 1;
    return Promise.resolve(json(200, read));
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

function makeClient(reads: unknown[]): { client: PredictAgentClient; calls: Call[] } {
  const { fetch, calls } = server(reads);
  const client = new PredictAgentClient({
    baseUrl: 'https://api.test/',
    fetch,
    signer,
    token: 'tok',
    retry: { maxAttempts: 3, baseDelayMs: 0 },
  });
  return { client, calls };
}

const readCount = (calls: Call[]): number =>
  calls.filter((call) => call.method === 'GET' && call.url.includes('/executions/')).length;

describe('terminal execution facts', () => {
  it('reports the fill exactly as the server stated it', async () => {
    const { client } = makeClient([
      { executionId: 'exec-1', status: 'PENDING_FILL' },
      {
        executionId: 'exec-1',
        status: 'FILLED',
        transactionDigest: 'exec-digest',
        fill: FILL,
        remainingAllowance: '450.006588',
      },
    ]);

    const result = await client.executeMarketOrder(intent, {
      waitFor: 'TERMINAL',
      pollIntervalMs: 0,
    });

    // Strings, byte-for-byte. Parsing these into numbers loses precision the
    // chain does not: 49.993412 is the amount, not approximately the amount.
    expect(result.fill).toEqual(FILL);
    expect(result.fill?.filledShares).toBe('98.500000');
    expect(result.remainingAllowance).toBe('450.006588');
    expect(result.terminal).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it('says a null fee is EMBEDDED IN PRICE rather than reporting zero', async () => {
    // The broker's published price is already fee-adjusted. A strategy that read
    // this as 0 would compute a net PnL that is wrong by the whole fee.
    const { client } = makeClient([
      { executionId: 'exec-1', status: 'FILLED', fill: FILL, remainingAllowance: '450' },
    ]);

    const result = await client.executeMarketOrder(intent, { waitFor: 'TERMINAL' });

    expect(result.fee).toEqual({ available: false, reason: 'EMBEDDED_IN_PRICE' });
    expect(result.fee).not.toHaveProperty('actualFee');
  });

  it('surfaces a separately observable fee when the server reports one', async () => {
    const { client } = makeClient([
      {
        executionId: 'exec-1',
        status: 'FILLED',
        fill: { ...FILL, actualFee: '0.125000' },
        remainingAllowance: '450',
      },
    ]);

    const result = await client.executeMarketOrder(intent, { waitFor: 'TERMINAL' });

    expect(result.fee).toEqual({ available: true, actualFee: '0.125000' });
  });

  it('distinguishes a terminal rejection from a fill of zero', async () => {
    const { client } = makeClient([
      { executionId: 'exec-1', status: 'REJECTED', remainingAllowance: '500' },
    ]);

    const result = await client.executeMarketOrder(intent, { waitFor: 'TERMINAL' });

    expect(result.status).toBe('REJECTED');
    expect(result.terminal).toBe(true);
    expect(result.fill).toBeUndefined();
    expect(result.fee).toEqual({ available: false, reason: 'NO_FILL_OBSERVED' });
    // The reservation was released, so the allowance figure is real and terminal.
    expect(result.remainingAllowance).toBe('500');
  });

  it('leaves allowance undefined for an agent with no risk profile', async () => {
    // The server omits the field entirely rather than sending 0, and undefined
    // must not collapse into "nothing left to spend".
    const { client } = makeClient([{ executionId: 'exec-1', status: 'FILLED', fill: FILL }]);

    const result = await client.executeMarketOrder(intent, { waitFor: 'TERMINAL' });

    expect(result.remainingAllowance).toBeUndefined();
  });

  it('carries no settlement facts when the caller stops at SUBMITTED', async () => {
    const { client, calls } = makeClient([]);

    const result = await client.executeMarketOrder(intent);

    expect(result.status).toBe('SUBMITTED');
    expect(result.terminal).toBe(false);
    expect(result.fill).toBeUndefined();
    expect(result.fee).toEqual({ available: false, reason: 'NO_FILL_OBSERVED' });
    expect(result.remainingAllowance).toBeUndefined();
    // And nothing was read: SUBMITTED is what the submit itself returned.
    expect(readCount(calls)).toBe(0);
  });

  it('keeps the submit digest when a later read has not caught up', async () => {
    // Losing it would cost the caller the only on-chain handle it holds.
    const { client } = makeClient([{ executionId: 'exec-1', status: 'PENDING_FILL' }]);

    const result = await client.executeMarketOrder(intent, {
      waitFor: 'TERMINAL',
      timeoutMs: 0,
    });

    expect(result.transactionDigest).toBe('exec-digest');
  });
});

describe('a wait that runs out of time', () => {
  it('returns the last known state instead of throwing', async () => {
    const { client } = makeClient([{ executionId: 'exec-1', status: 'PENDING_FILL' }]);

    const result = await client.executeMarketOrder(intent, {
      waitFor: 'TERMINAL',
      timeoutMs: 0,
    });

    expect(result.timedOut).toBe(true);
    expect(result.terminal).toBe(false);
    expect(result.status).toBe('PENDING_FILL');
    // No settlement facts were invented to fill the gap.
    expect(result.fill).toBeUndefined();
    expect(result.fee).toEqual({ available: false, reason: 'NO_FILL_OBSERVED' });
    expect(result.remainingAllowance).toBeUndefined();
  });

  it('hands back the handles needed to reconcile', async () => {
    const { client } = makeClient([{ executionId: 'exec-1', status: 'PENDING_FILL' }]);

    const result = await client.executeMarketOrder(
      { ...intent, idempotencyKey: 'mine-1' },
      { waitFor: 'TERMINAL', timeoutMs: 0 },
    );

    expect(result.executionId).toBe('exec-1');
    expect(result.idempotencyKey).toBe('mine-1');
    expect(result.enforcedWorstPrice).toBe('0.505');
  });

  it('does not resubmit — it only stopped watching', async () => {
    const { client, calls } = makeClient([{ executionId: 'exec-1', status: 'PENDING_FILL' }]);

    await client.executeMarketOrder(intent, { waitFor: 'TERMINAL', timeoutMs: 0 });

    expect(calls.filter((call) => call.url.endsWith('/submit'))).toHaveLength(1);
    expect(
      calls.filter((call) => call.method === 'POST' && call.url.endsWith('/executions')),
    ).toHaveLength(1);
  });

  it('resumes from the execution id and settles on the real outcome', async () => {
    // The reconciliation path a timed-out caller — or a restarted process holding
    // nothing but the id — takes.
    const { client, calls } = makeClient([
      { executionId: 'exec-1', status: 'PENDING_FILL' },
      { executionId: 'exec-1', status: 'FILLED', fill: FILL, remainingAllowance: '450.006588' },
    ]);

    const stopped = await client.executeMarketOrder(intent, {
      waitFor: 'TERMINAL',
      timeoutMs: 0,
    });
    const settled = await client.waitForExecution(stopped.executionId, { pollIntervalMs: 0 });

    expect(stopped.timedOut).toBe(true);
    expect(settled.timedOut).toBe(false);
    expect(settled.status).toBe('FILLED');
    expect(settled.fill).toEqual(FILL);
    expect(settled.remainingAllowance).toBe('450.006588');
    // Two reads, one order.
    expect(readCount(calls)).toBe(2);
  });

  it('is reported by executeMany as a launched leg, not a failed one', async () => {
    // `ok: false` here would push a caller to retry a leg that is live on chain.
    const { client } = makeClient([{ executionId: 'exec-1', status: 'PENDING_FILL' }]);

    const results = await client.executeMany([intent], {
      concurrency: 1,
      waitFor: 'TERMINAL',
      timeoutMs: 0,
    });

    const leg = results[0];
    expect(leg?.ok).toBe(true);
    expect(leg?.ok === true && leg.result.timedOut).toBe(true);
    expect(leg?.ok === true && leg.result.executionId).toBe('exec-1');
  });
});

describe('execution fact helpers', () => {
  it('treats only the four terminal statuses as terminal', () => {
    for (const status of ['FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED'] as const) {
      expect(isTerminalExecutionStatus(status)).toBe(true);
    }
    // SUBMITTED and PENDING_FILL are the two that get mistaken for a trade.
    for (const status of [
      'RECEIVED',
      'RISK_RESERVED',
      'AWAITING_SIGNATURE',
      'SUBMITTING',
      'SUBMITTED',
      'PENDING_FILL',
    ] as const) {
      expect(isTerminalExecutionStatus(status)).toBe(false);
    }
  });

  it('never produces a zero fee out of an absent one', () => {
    expect(toFeeFacts(undefined)).toEqual({ available: false, reason: 'NO_FILL_OBSERVED' });
    expect(toFeeFacts(FILL)).toEqual({ available: false, reason: 'EMBEDDED_IN_PRICE' });
    expect(toFeeFacts({ ...FILL, actualFee: '0' })).toEqual({ available: true, actualFee: '0' });
  });
});
