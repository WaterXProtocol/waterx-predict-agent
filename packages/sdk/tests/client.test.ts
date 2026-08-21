/**
 * Tests the behaviours that cost money if they are wrong: one idempotency key per
 * intent reused across every retry, retries gated on the server's own `retryable`
 * flag, and executeMany's STOP policy stopping launches without pretending to roll
 * anything back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PredictAgentClient } from '../src/client.ts';
import { PredictAgentApiError, PredictAgentTransportError } from '../src/errors.ts';
import type { AgentSigner } from '../src/signer.ts';

const AGENT = '0xagent';

const signer: AgentSigner = {
  signTransaction: (bytes) =>
    Promise.resolve({ signature: `sig(${String(bytes.length)})`, bytes: 'b' }),
  signPersonalMessage: (bytes) =>
    Promise.resolve({ signature: `personal(${String(bytes.length)})`, bytes: 'b' }),
  toSuiAddress: () => AGENT,
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A fetch double that CYCLES its queued responses and records every call.
 *
 * Cycling rather than sticking on the last entry: a multi-leg test queues one
 * create + one submit and expects that pair to repeat per leg. Sticking would
 * hand leg 2's create a submit body, which fails for a reason that has nothing
 * to do with the behaviour under test.
 */
function stubFetch(responses: (() => Response)[]): {
  fetch: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  let index = 0;
  const fetch = ((url: URL | string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const next = responses[index % responses.length];
    index += 1;
    if (next === undefined) throw new Error('no stubbed response');
    return Promise.resolve(next());
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (status: number, body: unknown) => (): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const apiError = (status: number, code: string, retryable: boolean) => (): Response =>
  new Response(JSON.stringify({ error: { code, message: 'nope', retryable } }), { status });

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

const intent = {
  accountId: '0xacct',
  marketId: '0xmarket',
  outcomeId: 'YES' as const,
  side: 'BUY' as const,
  size: { buyAmount: '50' },
  referenceQuoteId: 'q-ref',
  maxSlippageBps: 100,
};

function makeClient(responses: (() => Response)[]): {
  client: PredictAgentClient;
  calls: Call[];
} {
  const { fetch, calls } = stubFetch(responses);
  const client = new PredictAgentClient({
    baseUrl: 'https://api.test/',
    fetch,
    signer,
    token: 'tok',
    retry: { maxAttempts: 3, baseDelayMs: 0 },
  });
  return { client, calls };
}

describe('executeMarketOrder', () => {
  it('creates, signs the returned bytes, then submits', async () => {
    const { client, calls } = makeClient([json(201, CREATED), json(202, SUBMITTED)]);

    const result = await client.executeMarketOrder(intent);

    expect(calls[0]?.url).toBe('https://api.test/agent-api/v1/predict/executions');
    expect(calls[1]?.url).toBe(
      'https://api.test/agent-api/v1/predict/executions/exec-1/submit',
    );
    // The signature is over the bytes the API returned, not over anything local.
    expect(calls[1]?.body).toEqual({ signature: `sig(${String('tx-bytes'.length)})` });
    expect(result.status).toBe('SUBMITTED');
    expect(result.enforcedWorstPrice).toBe('0.505');
  });

  it('sends an Idempotency-Key on create', async () => {
    const { client, calls } = makeClient([json(201, CREATED), json(202, SUBMITTED)]);

    const result = await client.executeMarketOrder(intent);

    expect(calls[0]?.headers['Idempotency-Key']).toBe(result.idempotencyKey);
  });

  it('reuses the SAME key across a retried create', async () => {
    // A timeout mid-create must resolve to the original execution, never place a
    // second order — which only holds if the key does not change.
    const { client, calls } = makeClient([
      apiError(503, 'SPONSOR_UNAVAILABLE', true),
      json(201, CREATED),
      json(202, SUBMITTED),
    ]);

    await client.executeMarketOrder(intent);

    const keys = calls
      .filter((call) => call.url.endsWith('/executions'))
      .map((call) => call.headers['Idempotency-Key']);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  });

  it('honours a caller-supplied key so a retry survives a process restart', async () => {
    const { client, calls } = makeClient([json(201, CREATED), json(202, SUBMITTED)]);

    const result = await client.executeMarketOrder({ ...intent, idempotencyKey: 'mine-1' });

    expect(calls[0]?.headers['Idempotency-Key']).toBe('mine-1');
    expect(result.idempotencyKey).toBe('mine-1');
  });

  it('never leaks idempotencyKey into the request body', async () => {
    const { client, calls } = makeClient([json(201, CREATED), json(202, SUBMITTED)]);

    await client.executeMarketOrder({ ...intent, idempotencyKey: 'mine-1' });

    expect(calls[0]?.body).not.toHaveProperty('idempotencyKey');
  });

  it('does not retry an error the server called permanent', async () => {
    const { client, calls } = makeClient([apiError(409, 'IDEMPOTENCY_KEY_REUSED', false)]);

    await expect(client.executeMarketOrder(intent)).rejects.toThrow(PredictAgentApiError);
    expect(calls).toHaveLength(1);
  });

  it('retries an error the server called transient', async () => {
    const { client, calls } = makeClient([
      apiError(409, 'SLIPPAGE_EXCEEDED', true),
      apiError(409, 'SLIPPAGE_EXCEEDED', true),
      apiError(409, 'SLIPPAGE_EXCEEDED', true),
    ]);

    await expect(client.executeMarketOrder(intent)).rejects.toThrow(PredictAgentApiError);
    expect(calls).toHaveLength(3);
  });

  it('surfaces an unrecognised error body as a transport error, not a fabricated code', async () => {
    // A proxy's HTML 502 must not become a code an agent branches on.
    const { client } = makeClient([() => new Response('<html>502</html>', { status: 502 })]);

    await expect(client.executeMarketOrder(intent)).rejects.toThrow(PredictAgentTransportError);
  });

  it('waits for a terminal status when asked', async () => {
    const { client } = makeClient([
      json(201, CREATED),
      json(202, SUBMITTED),
      json(200, { executionId: 'exec-1', status: 'PENDING_FILL' }),
      json(200, { executionId: 'exec-1', status: 'FILLED', transactionDigest: 'exec-digest' }),
    ]);

    const result = await client.executeMarketOrder(intent, {
      waitFor: 'TERMINAL',
      pollIntervalMs: 0,
    });

    expect(result.status).toBe('FILLED');
    expect(result.terminal).toBe(true);
    expect(result.timedOut).toBe(false);
  });
});

describe('quoting a leg when it runs', () => {
  const unquoted = {
    accountId: '0xacct',
    marketId: '0xmarket',
    outcomeId: 'YES' as const,
    side: 'BUY' as const,
    size: { buyAmount: '50' },
    maxSlippageBps: 100,
  };
  const QUOTE = (id: string) => ({
    quoteId: id,
    marketId: '0xmarket',
    outcomeId: 'YES',
    side: 'BUY',
    expectedPrice: '0.5',
    expiresAt: '2026-07-30T00:00:03.000Z',
  });

  it('mints the quote itself when the intent carries none', async () => {
    const { client, calls } = makeClient([
      json(200, QUOTE('q-fresh')),
      json(201, CREATED),
      json(202, SUBMITTED),
    ]);

    await client.executeMarketOrder(unquoted);

    expect(calls[0]?.url).toBe('https://api.test/agent-api/v1/predict/quotes');
    // Priced against the quote it just minted, not against anything the caller
    // could have been holding since before this call.
    expect((calls[1]?.body as { referenceQuoteId?: string }).referenceQuoteId).toBe('q-fresh');
  });

  it('uses a supplied quote as-is, and mints nothing', async () => {
    const { client, calls } = makeClient([json(201, CREATED), json(202, SUBMITTED)]);

    await client.executeMarketOrder(intent);

    expect(calls.some((c) => c.url.endsWith('/quotes'))).toBe(false);
    expect((calls[0]?.body as { referenceQuoteId?: string }).referenceQuoteId).toBe('q-ref');
  });

  it('quotes each leg AFTER the previous one has been submitted', async () => {
    // The bug this exists to prevent: a caller that pre-mints a batch's quotes
    // is already wrong by the time leg two runs, because leg one's
    // create/sign/submit outlives a quote that lives seconds. So the order of
    // calls — not merely the count — is the assertion.
    const { client, calls } = makeClient([
      json(200, QUOTE('q-leg-1')),
      json(201, CREATED),
      json(202, SUBMITTED),
      json(200, QUOTE('q-leg-2')),
      json(201, CREATED),
      json(202, SUBMITTED),
    ]);

    const results = await client.executeMany([unquoted, unquoted], { concurrency: 1 });

    expect(results.every((entry) => entry.ok)).toBe(true);
    expect(calls.map((c) => c.url.replace('https://api.test/agent-api/v1/predict/', ''))).toEqual([
      'quotes',
      'executions',
      'executions/exec-1/submit',
      'quotes',
      'executions',
      'executions/exec-1/submit',
    ]);
    // Each leg priced against its own quote, minted in its own turn.
    expect((calls[1]?.body as { referenceQuoteId?: string }).referenceQuoteId).toBe('q-leg-1');
    expect((calls[4]?.body as { referenceQuoteId?: string }).referenceQuoteId).toBe('q-leg-2');
  });
});

describe('a deadline that expires after the order exists', () => {
  const abort = (): Response => {
    // What a caller's AbortSignal.timeout produces, as the transport surfaces it.
    throw Object.assign(new Error('The operation was aborted due to timeout'), {
      name: 'TimeoutError',
    });
  };

  it('reports UNKNOWN with the execution id, never a failure', async () => {
    // The order was created and may already be filled. Calling that a failure is
    // how a caller retries and places it twice — the exact duplicate this design
    // exists to prevent (plan §9).
    const { client } = makeClient([json(201, CREATED), abort, abort, abort]);

    const result = await client.executeMarketOrder(intent);

    expect(result.timedOut).toBe(true);
    expect(result.terminal).toBe(false);
    expect(result.executionId).toBe('exec-1');
    // The handle `order reconcile` needs, kept rather than thrown away.
    expect(result.idempotencyKey).toBeTypeOf('string');
    expect(result.fee).toEqual({ available: false, reason: 'NO_FILL_OBSERVED' });
  });

  it('still throws when the create itself is aborted', async () => {
    // Before the create there is nothing to be ambiguous about: no order exists,
    // and reporting one as maybe-live would send a caller to reconcile nothing.
    const { client } = makeClient([abort]);
    await expect(client.executeMarketOrder(intent)).rejects.toThrow();
  });

  it('still throws when the server REFUSES the submit', async () => {
    // A refusal is not a deadline. Swallowing it into `timedOut` would turn a
    // definitive "no" into "maybe", which is worse than either.
    const { client } = makeClient([json(201, CREATED), apiError(409, 'SLIPPAGE_EXCEEDED', false)]);
    await expect(client.executeMarketOrder(intent)).rejects.toBeInstanceOf(PredictAgentApiError);
  });

  it('leaves a batch leg reported as ok-but-unknown rather than failed', async () => {
    const { client } = makeClient([
      json(201, CREATED),
      json(202, SUBMITTED),
      json(201, CREATED),
      abort,
      abort,
      abort,
    ]);

    const results = await client.executeMany([intent, intent], { concurrency: 1 });

    expect(results[0]?.ok).toBe(true);
    // The second leg placed an order. `ok: false` here would be the CLI printing
    // FAILED for a live order, which is what this test exists to stop.
    expect(results[1]?.ok).toBe(true);
    expect(results[1]).toMatchObject({ result: { timedOut: true, executionId: 'exec-1' } });
  });
});

describe('executeMany', () => {
  it('reports each leg independently', async () => {
    const { client } = makeClient([json(201, CREATED), json(202, SUBMITTED)]);

    const results = await client.executeMany([intent, intent], { concurrency: 1 });

    expect(results).toHaveLength(2);
    expect(results.every((entry) => entry.ok)).toBe(true);
  });

  it('gives every leg its own idempotency key', async () => {
    const { client, calls } = makeClient([json(201, CREATED), json(202, SUBMITTED)]);

    await client.executeMany([intent, intent], { concurrency: 1 });

    const keys = calls
      .filter((call) => call.url.endsWith('/executions'))
      .map((call) => call.headers['Idempotency-Key']);
    expect(new Set(keys).size).toBe(2);
  });

  it('STOP skips legs that had not launched, and says so distinctly', async () => {
    const { client } = makeClient([apiError(403, 'INSUFFICIENT_ALLOWANCE', false)]);

    const results = await client.executeMany([intent, intent, intent], {
      concurrency: 1,
      failurePolicy: 'STOP',
    });

    expect(results[0]).toMatchObject({ ok: false });
    // Skipped, not failed — a caller can resubmit exactly these.
    expect(results[1]).toMatchObject({ ok: false, skipped: true });
    expect(results[2]).toMatchObject({ ok: false, skipped: true });
  });

  it('CONTINUE attempts every leg despite a failure', async () => {
    const { client } = makeClient([apiError(403, 'INSUFFICIENT_ALLOWANCE', false)]);

    const results = await client.executeMany([intent, intent], {
      concurrency: 1,
      failurePolicy: 'CONTINUE',
    });

    expect(results.some((entry) => 'skipped' in entry)).toBe(false);
  });
});

describe('authentication', () => {
  it('refuses to call a guarded route before a session is opened', async () => {
    // Automatic RE-authentication continues an established session; it never
    // opens the first one behind the caller's back.
    const { fetch } = stubFetch([json(200, {})]);
    const client = new PredictAgentClient({ baseUrl: 'https://api.test', fetch, signer });

    await expect(client.getAllowance('0xacct')).rejects.toThrow(/Not authenticated/);
  });

  it('signs the exact challenge the server re-derives', async () => {
    const { fetch, calls } = stubFetch([json(200, { token: 'tok-2', expiresIn: 900 })]);
    const client = new PredictAgentClient({ baseUrl: 'https://api.test', fetch, signer });

    await client.authenticate();

    const body = calls[0]?.body as { message: string; walletAddress: string; timestamp: number };
    expect(body.message).toBe(
      `Sign in to Bucket Agent\nWallet: ${AGENT}\nTimestamp: ${String(body.timestamp)}`,
    );
    expect(body.walletAddress).toBe(AGENT);
  });

  it('signs the challenge as a PERSONAL MESSAGE, not as a transaction', async () => {
    // Sui prefixes signed bytes with an intent: a personal message (scope 3) and
    // a transaction (scope 0) hash differently. The server verifies this with
    // verifyPersonalMessageSignature, so signing it as a transaction produces a
    // well-formed signature over the wrong bytes and EVERY login is rejected.
    // Shipped exactly that way once; caught only by running the SDK against a
    // real server, because both the signer and fetch are stubbed here.
    const signTransaction = vi.fn(() => Promise.resolve({ signature: 'tx', bytes: 'b' }));
    const signPersonalMessage = vi.fn(() => Promise.resolve({ signature: 'personal', bytes: 'b' }));
    const { fetch, calls } = stubFetch([json(200, { token: 'tok-2', expiresIn: 900 })]);
    const client = new PredictAgentClient({
      baseUrl: 'https://api.test',
      fetch,
      signer: { signTransaction, signPersonalMessage, toSuiAddress: () => AGENT },
    });

    await client.authenticate();

    expect(signPersonalMessage).toHaveBeenCalledTimes(1);
    expect(signTransaction).not.toHaveBeenCalled();
    expect((calls[0]?.body as { signature: string }).signature).toBe('personal');
  });

  it('uses the new token for subsequent calls', async () => {
    const { fetch, calls } = stubFetch([
      json(200, { token: 'tok-2', expiresIn: 900 }),
      json(200, { apiAllowance: {}, accountSpendableBalance: '0', effectiveBuyCapacity: '0' }),
    ]);
    const client = new PredictAgentClient({ baseUrl: 'https://api.test', fetch, signer });

    await client.authenticate();
    await client.getAllowance('0xacct');

    expect(calls[1]?.headers.authorization).toBe('Bearer tok-2');
  });
});

describe('reads', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('passes limit as a query parameter', async () => {
    const { client, calls } = makeClient([json(200, { positions: [] })]);

    await client.getPositions('0xacct', { limit: 10 });

    expect(calls[0]?.url).toBe(
      'https://api.test/agent-api/v1/predict/accounts/0xacct/positions?limit=10',
    );
  });

  it('sends a page cursor back exactly as the server issued it', async () => {
    const { client, calls } = makeClient([json(200, { fills: [], nextCursor: null })]);
    const cursor = 'djE6RklMTFM6M2YxYjljMmU';

    await client.getFills('0xacct', { limit: 2, cursor });

    // Verbatim, and URL-encoded rather than reformatted. A client that
    // normalised a cursor would be honoured against a row it did not mean.
    expect(calls[0]?.url).toBe(
      `https://api.test/agent-api/v1/predict/accounts/0xacct/fills?limit=2&cursor=${cursor}`,
    );
  });

  it('does not send a cursor parameter when there is no cursor', async () => {
    const { client, calls } = makeClient([json(200, { fills: [] })]);

    await client.getFills('0xacct', { limit: 2 });

    // `?cursor=` is not "no cursor" — the server refuses it, correctly.
    expect(calls[0]?.url).not.toContain('cursor');
  });

  it('omits limit when not supplied', async () => {
    const { client, calls } = makeClient([json(200, { executions: [] })]);

    await client.listExecutions('0xacct');

    expect(calls[0]?.url).toBe(
      'https://api.test/agent-api/v1/predict/accounts/0xacct/executions',
    );
  });

  it('sends the search text and returns the server’s resolution untouched', async () => {
    const resolution = {
      status: 'RESOLVED',
      normalizedQuery: 'arsenal chelsea',
      marketId: '0xmarket',
      matchCount: 1,
    };
    const { client, calls } = makeClient([
      json(200, { markets: [{ marketId: '0xmarket' }], resolution }),
    ]);

    const response = await client.searchMarkets({ search: 'arsenal chelsea', tradeable: true });

    expect(new URL(calls[0]!.url).searchParams.get('search')).toBe('arsenal chelsea');
    expect(response.resolution).toEqual(resolution);
  });

  it('never fills in a marketId the server left null', async () => {
    // AMBIGUOUS is an answer. Picking one candidate here would be the SDK
    // resolving an identity the server refused to resolve.
    const { client } = makeClient([
      json(200, {
        markets: [{ marketId: '0xa' }, { marketId: '0xb' }],
        resolution: {
          status: 'AMBIGUOUS',
          normalizedQuery: 'arsenal',
          marketId: null,
          matchCount: 2,
        },
      }),
    ]);

    const response = await client.searchMarkets({ search: 'arsenal' });

    expect(response.resolution.marketId).toBeNull();
    expect(response.markets).toHaveLength(2);
  });

  it('reads a search answered without a resolution as NOT_FOUND, not as a match', async () => {
    // A server older than this client. Inferring the id from a one-row page is
    // the exact local resolution the search endpoint exists to remove.
    const { client } = makeClient([json(200, { markets: [{ marketId: '0xonly' }] })]);

    const response = await client.searchMarkets({ search: 'arsenal' });

    expect(response.resolution.status).toBe('NOT_FOUND');
    expect(response.resolution.marketId).toBeNull();
    expect(response.resolution.matchCount).toBe(1);
  });

  it('reads the effective limits from the account-scoped route', async () => {
    const { client, calls } = makeClient([json(200, { accountId: '0xacct', blockers: [] })]);

    await client.getEffectiveLimits('0xacct');

    expect(calls[0]?.url).toBe(
      'https://api.test/agent-api/v1/predict/accounts/0xacct/effective-limits',
    );
    expect(calls[0]?.method).toBe('GET');
  });

  it('reads performance without a strategy filter', async () => {
    const { client, calls } = makeClient([
      json(200, { accountId: '0xacct', attributionScope: 'API_ATTRIBUTED_ONLY' }),
    ]);

    await client.getPerformance('0xacct');

    // No `?strategyId=`: the server runs forbidNonWhitelisted and an empty value
    // is a 400, not "no filter".
    expect(calls[0]?.url).toBe(
      'https://api.test/agent-api/v1/predict/accounts/0xacct/performance',
    );
  });

  it('sends the strategy filter when one is given', async () => {
    const { client, calls } = makeClient([json(200, { strategyId: 'momentum v2' })]);

    await client.getPerformance('0xacct', 'momentum v2');

    expect(new URL(calls[0]!.url).searchParams.get('strategyId')).toBe('momentum v2');
  });

  it('returns null rates as null rather than coercing them to zero', async () => {
    // The distinction the whole read hangs on: `null` is "nothing has closed",
    // `"0"` is "everything lost", and a strategy sizing off the wrong one would
    // shut itself down on its first day.
    const { client } = makeClient([
      json(200, {
        orders: { created: 3, terminal: 0, inFlight: 3, successRate: null, terminalRate: null },
        realized: { closedExits: 0, winRate: null, realizedPnl: '0' },
        excluded: { exitsWithoutAttributedBasis: 0, claimedPositions: 4, openPositions: 1 },
      }),
    ]);

    const performance = await client.getPerformance('0xacct');

    expect(performance.orders.successRate).toBeNull();
    expect(performance.realized.winRate).toBeNull();
    // And the population that was left out is carried through untouched.
    expect(performance.excluded.claimedPositions).toBe(4);
  });
});

/**
 * What an embedder may ask the client about its own session and its own socket.
 *
 * Both accessors exist for a long-lived host — the Runner — that must open one
 * session, share it with a stream it drives itself, and never hold the token.
 */
describe('what a long-lived embedder can reach', () => {
  it('answers whether a session is held without handing over the token', async () => {
    const { fetch } = stubFetch([json(200, { token: 'tok-2', expiresIn: 900 })]);
    const client = new PredictAgentClient({ baseUrl: 'https://api.test', fetch, signer });

    // The question a host asks per tick, so it does not mint a login per tick.
    expect(client.isAuthenticated()).toBe(false);
    await client.authenticate();
    expect(client.isAuthenticated()).toBe(true);

    // The boolean, and nothing else: no accessor here returns the credential.
    expect(JSON.stringify(client.isAuthenticated())).not.toContain('tok-2');
  });

  it('hands over the quote stream it owns, and none when none was configured', () => {
    const { fetch } = stubFetch([json(200, {})]);
    const bare = new PredictAgentClient({ baseUrl: 'https://api.test', fetch, signer });
    expect(bare.quoteStream()).toBeUndefined();

    const stream = { onQuote: () => () => undefined };
    const configured = new PredictAgentClient({
      baseUrl: 'https://api.test',
      fetch,
      signer,
      quoteStream: stream,
    });
    // The same object, so an embedder putting its own observer over this stream
    // is watching the feed the client's own price waits watch.
    expect(configured.quoteStream()).toBe(stream);
  });

  it('opens the native stream once and closes it with the client', () => {
    const { fetch } = stubFetch([json(200, {})]);
    let disconnects = 0;
    const client = new PredictAgentClient({
      baseUrl: 'https://api.test',
      fetch,
      signer,
      quoteStream: 'native',
      quoteStreamConnector: () => ({
        on: () => undefined,
        emit: () => undefined,
        disconnect: () => {
          disconnects += 1;
        },
      }),
    });

    const first = client.quoteStream();
    expect(first).toBeDefined();
    // Lazily built, then remembered: two callers must not end up on two sockets
    // with two handshakes and two copies of the session.
    expect(client.quoteStream()).toBe(first);

    client.close();
    // No socket was ever connected here — nothing subscribed — so there is
    // nothing to disconnect, and closing must still not throw.
    expect(disconnects).toBe(0);
  });
});
