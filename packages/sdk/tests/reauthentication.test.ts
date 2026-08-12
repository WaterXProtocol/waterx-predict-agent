/**
 * Automatic re-authentication.
 *
 * A strategy outlives its token, so the token WILL expire in the middle of a
 * flow that has already created an execution. Every test here defends one of the
 * three properties that make recovering from that safe rather than expensive:
 *
 *  - the replay is the SAME logical write — identical bytes, identical
 *    Idempotency-Key — so a 401 between create and submit can never become a
 *    second order;
 *  - concurrent rejections produce ONE login, not one per in-flight request;
 *  - it is BOUNDED. A server that keeps rejecting produces an error, never a
 *    login loop, and a rejection that a new token cannot fix is not retried at
 *    all.
 */
import { describe, expect, it, vi } from 'vitest';

import { PredictAgentClient } from '../src/client.ts';
import { AuthSession } from '../src/session.ts';
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
  /** The raw serialized body, so a test can compare BYTES and not just shape. */
  rawBody: string | undefined;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const unauthenticated = (): Response =>
  json(401, { error: { code: 'UNAUTHENTICATED', message: 'token expired', retryable: false } });

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

/** A fetch double routed by (method, path), recording every call verbatim. */
function router(handle: (call: Call, index: number) => Response): {
  fetch: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch = ((url: URL | string, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      rawBody: init?.body === undefined ? undefined : String(init.body),
    };
    calls.push(call);
    return Promise.resolve(handle(call, calls.length - 1));
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const isAuth = (call: Call): boolean => call.url.endsWith('/agent-api/v1/auth');
const authCalls = (calls: Call[]): Call[] => calls.filter(isAuth);

describe('automatic re-authentication', () => {
  it('replays the rejected request once, under a fresh token', async () => {
    let issued = 0;
    const { fetch, calls } = router((call) => {
      if (isAuth(call)) {
        issued += 1;
        return json(200, { token: `tok-${String(issued)}`, expiresIn: 900 });
      }
      // The first guarded call meets a dead token; the second must succeed.
      return call.headers.authorization === 'Bearer tok-1'
        ? json(200, { positions: [] })
        : unauthenticated();
    });
    const client = new PredictAgentClient({
      baseUrl: 'https://api.test',
      fetch,
      signer,
      token: 'stale',
      retry: { maxAttempts: 3, baseDelayMs: 0 },
    });

    await expect(client.getPositions('0xacct')).resolves.toEqual({ positions: [] });

    const guarded = calls.filter((call) => !isAuth(call));
    expect(guarded).toHaveLength(2);
    expect(guarded[0]?.headers.authorization).toBe('Bearer stale');
    expect(guarded[1]?.headers.authorization).toBe('Bearer tok-1');
    expect(authCalls(calls)).toHaveLength(1);
  });

  it('replays the IDENTICAL bytes and the SAME idempotency key', async () => {
    // The intent object is mutated the instant the first create is in flight, the
    // way a caller reusing an intent between orders would. The replay must send
    // what was already signed for, not the new value — a different body under the
    // same key is a different order.
    const mutable = { ...intent, size: { buyAmount: '50' } };
    const { fetch, calls } = router((call, index) => {
      if (isAuth(call)) return json(200, { token: 'tok-1', expiresIn: 900 });
      if (call.url.endsWith('/submit')) return json(202, SUBMITTED);
      if (index === 0) {
        mutable.size = { buyAmount: '5000' };
        return unauthenticated();
      }
      return json(201, CREATED);
    });
    const client = new PredictAgentClient({
      baseUrl: 'https://api.test',
      fetch,
      signer,
      token: 'stale',
      retry: { maxAttempts: 3, baseDelayMs: 0 },
    });

    await client.executeMarketOrder({ ...mutable, idempotencyKey: 'key-1' });

    const creates = calls.filter((call) => call.url.endsWith('/executions'));
    expect(creates).toHaveLength(2);
    expect(creates[1]?.rawBody).toBe(creates[0]?.rawBody);
    expect(creates[0]?.rawBody).toContain('"buyAmount":"50"');
    expect(creates.map((call) => call.headers['Idempotency-Key'])).toEqual(['key-1', 'key-1']);
  });

  it('recovers a token that dies between create and submit, without a second create', async () => {
    const { fetch, calls } = router((call) => {
      if (isAuth(call)) return json(200, { token: 'tok-1', expiresIn: 900 });
      if (call.url.endsWith('/submit')) {
        return call.headers.authorization === 'Bearer tok-1'
          ? json(202, SUBMITTED)
          : unauthenticated();
      }
      return json(201, CREATED);
    });
    const client = new PredictAgentClient({
      baseUrl: 'https://api.test',
      fetch,
      signer,
      token: 'stale',
      retry: { maxAttempts: 3, baseDelayMs: 0 },
    });

    const result = await client.executeMarketOrder({ ...intent, idempotencyKey: 'key-1' });

    expect(result.status).toBe('SUBMITTED');
    expect(calls.filter((call) => call.url.endsWith('/executions'))).toHaveLength(1);
    // Re-submitting the same signature is a server-side no-op; re-CREATING would
    // not be, which is why the create must not be repeated here.
    const submits = calls.filter((call) => call.url.endsWith('/submit'));
    expect(submits).toHaveLength(2);
    expect(submits[1]?.rawBody).toBe(submits[0]?.rawBody);
  });

  it('mints ONE session for a burst of concurrent rejections', async () => {
    let issued = 0;
    const { fetch, calls } = router((call) => {
      if (isAuth(call)) {
        issued += 1;
        return json(200, { token: `tok-${String(issued)}`, expiresIn: 900 });
      }
      return call.headers.authorization === 'Bearer stale'
        ? unauthenticated()
        : json(200, { positions: [] });
    });
    const client = new PredictAgentClient({
      baseUrl: 'https://api.test',
      fetch,
      signer,
      token: 'stale',
      retry: { maxAttempts: 3, baseDelayMs: 0 },
    });

    await Promise.all([
      client.getPositions('0xa'),
      client.getPositions('0xb'),
      client.getPositions('0xc'),
      client.getPositions('0xd'),
      client.getPositions('0xe'),
    ]);

    // Five simultaneous 401s, one challenge signed. Five logins would race to
    // overwrite each other's token and burn four signatures for nothing.
    expect(authCalls(calls)).toHaveLength(1);
    expect(issued).toBe(1);
  });

  it('stops after one re-authentication rather than looping', async () => {
    const { fetch, calls } = router((call) =>
      isAuth(call) ? json(200, { token: 'tok-1', expiresIn: 900 }) : unauthenticated(),
    );
    const client = new PredictAgentClient({
      baseUrl: 'https://api.test',
      fetch,
      signer,
      token: 'stale',
      retry: { maxAttempts: 3, baseDelayMs: 0 },
    });

    await expect(client.getPositions('0xacct')).rejects.toThrow(
      expect.objectContaining({ code: 'UNAUTHENTICATED' }),
    );
    expect(authCalls(calls)).toHaveLength(1);
    expect(calls.filter((call) => !isAuth(call))).toHaveLength(2);
  });

  it('signs a FRESH personal-message challenge, never a replayed one', async () => {
    const signPersonalMessage = vi.fn((bytes: Uint8Array) =>
      Promise.resolve({ signature: `personal(${String(bytes.length)})`, bytes: 'b' }),
    );
    const signTransaction = vi.fn(() => Promise.resolve({ signature: 'tx', bytes: 'b' }));
    let issued = 0;
    const { fetch, calls } = router((call) => {
      if (isAuth(call)) {
        issued += 1;
        return json(200, { token: `tok-${String(issued)}`, expiresIn: 900 });
      }
      return call.headers.authorization === 'Bearer tok-2'
        ? json(200, { positions: [] })
        : unauthenticated();
    });
    const client = new PredictAgentClient({
      baseUrl: 'https://api.test',
      fetch,
      signer: { signTransaction, signPersonalMessage, toSuiAddress: () => AGENT },
      retry: { maxAttempts: 3, baseDelayMs: 0 },
    });

    await client.authenticate();
    await client.getPositions('0xacct');

    // The server rejects a challenge older than five minutes, so a re-login has
    // to mint its own timestamp — and it is a personal message both times.
    expect(signPersonalMessage).toHaveBeenCalledTimes(2);
    expect(signTransaction).not.toHaveBeenCalled();
    const stamps = authCalls(calls).map(
      (call) => (JSON.parse(call.rawBody ?? '{}') as { timestamp: number }).timestamp,
    );
    expect(stamps).toHaveLength(2);
    expect(stamps[1]).toBeGreaterThanOrEqual(stamps[0] ?? 0);
    const messages = authCalls(calls).map(
      (call) => (JSON.parse(call.rawBody ?? '{}') as { message: string }).message,
    );
    expect(messages[1]).toBe(`Sign in to Bucket Agent\nWallet: ${AGENT}\nTimestamp: ${String(stamps[1])}`);
  });

  it('rolls a self-minted token over before it expires', async () => {
    let issued = 0;
    const { fetch, calls } = router((call) => {
      if (isAuth(call)) {
        issued += 1;
        // Already expired on arrival: the next guarded call must not spend it.
        return json(200, { token: `tok-${String(issued)}`, expiresIn: 0 });
      }
      return json(200, { positions: [] });
    });
    const client = new PredictAgentClient({ baseUrl: 'https://api.test', fetch, signer });

    await client.authenticate();
    await client.getPositions('0xacct');

    expect(authCalls(calls)).toHaveLength(2);
    expect(calls.at(-1)?.headers.authorization).toBe('Bearer tok-2');
  });

  it('never re-authenticates on a rejection a new token cannot fix', async () => {
    for (const [status, code] of [
      [403, 'DELEGATION_REVOKED'],
      [401, 'SIGNATURE_INVALID'],
      [409, 'IDEMPOTENCY_KEY_REUSED'],
    ] as const) {
      const { fetch, calls } = router((call) =>
        isAuth(call)
          ? json(200, { token: 'tok-1', expiresIn: 900 })
          : json(status, { error: { code, message: 'no', retryable: false } }),
      );
      const client = new PredictAgentClient({
        baseUrl: 'https://api.test',
        fetch,
        signer,
        token: 'stale',
        retry: { maxAttempts: 3, baseDelayMs: 0 },
      });

      await expect(client.getPositions('0xacct'), code).rejects.toThrow(
        expect.objectContaining({ code }),
      );
      // Logging in again would hide a permanent failure behind a login.
      expect(authCalls(calls), code).toHaveLength(0);
    }
  });

  it('surfaces UNAUTHENTICATED untouched when the caller opted out', async () => {
    const { fetch, calls } = router((call) =>
      isAuth(call) ? json(200, { token: 'tok-1', expiresIn: 900 }) : unauthenticated(),
    );
    const client = new PredictAgentClient({
      baseUrl: 'https://api.test',
      fetch,
      signer,
      token: 'stale',
      autoReauthenticate: false,
      retry: { maxAttempts: 3, baseDelayMs: 0 },
    });

    await expect(client.getPositions('0xacct')).rejects.toThrow(
      expect.objectContaining({ code: 'UNAUTHENTICATED' }),
    );
    expect(authCalls(calls)).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it('reports a failed re-authentication instead of retrying it forever', async () => {
    const { fetch, calls } = router((call) =>
      isAuth(call)
        ? json(401, {
            error: { code: 'SIGNATURE_INVALID', message: 'bad signature', retryable: false },
          })
        : unauthenticated(),
    );
    const client = new PredictAgentClient({
      baseUrl: 'https://api.test',
      fetch,
      signer,
      token: 'stale',
      retry: { maxAttempts: 3, baseDelayMs: 0 },
    });

    // A signer that can no longer produce a valid challenge is an operator
    // problem; reporting it beats masking it as the original 401.
    await expect(client.getPositions('0xacct')).rejects.toThrow(
      expect.objectContaining({ code: 'SIGNATURE_INVALID' }),
    );
    expect(authCalls(calls)).toHaveLength(1);
  });
});

describe('AuthSession', () => {
  it('joins an in-flight mint instead of starting a competing one', async () => {
    let resolveMint: ((value: { token: string; expiresIn: number }) => void) | undefined;
    const mint = vi.fn(
      () =>
        new Promise<{ token: string; expiresIn: number }>((resolve) => {
          resolveMint = resolve;
        }),
    );
    const session = new AuthSession({ mint, automatic: true, token: 'stale' });

    const first = session.refresh('stale');
    const second = session.refresh('stale');
    resolveMint?.({ token: 'tok-1', expiresIn: 900 });

    expect(await first).toBe('tok-1');
    expect(await second).toBe('tok-1');
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('hands back the current token when someone else already replaced the rejected one', async () => {
    const mint = vi.fn(() => Promise.resolve({ token: 'tok-2', expiresIn: 900 }));
    const session = new AuthSession({ mint, automatic: true, token: 'tok-1' });

    await session.refresh('tok-1');
    // A request still holding tok-1 arrives late. Its token is stale, but the
    // session already moved on — minting again would sign for nothing.
    expect(await session.refresh('tok-1')).toBe('tok-2');
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('starts a new mint once the previous one has settled', async () => {
    let issued = 0;
    const mint = vi.fn(() => {
      issued += 1;
      return Promise.resolve({ token: `tok-${String(issued)}`, expiresIn: 900 });
    });
    const session = new AuthSession({ mint, automatic: true });

    await session.authenticate();
    await session.authenticate();

    expect(mint).toHaveBeenCalledTimes(2);
    expect(session.peek()).toBe('tok-2');
  });

  it('refuses to replace anything when it is not automatic', async () => {
    const mint = vi.fn(() => Promise.resolve({ token: 'tok-2', expiresIn: 900 }));
    const session = new AuthSession({ mint, automatic: false, token: 'tok-1' });

    expect(await session.refresh('tok-1')).toBeUndefined();
    // An expired lifetime is likewise not acted on: the caller asked to be told.
    expect(mint).not.toHaveBeenCalled();
    expect(await session.require()).toBe('tok-1');
  });
});
