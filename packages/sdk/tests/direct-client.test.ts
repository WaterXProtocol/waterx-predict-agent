/**
 * `PredictDirectClient` against a fake WaterX, whose tx builds are real bytes.
 *
 * What is protected:
 *  - an order is protected by a cap derived here, and nothing is signed that
 *    fails verification;
 *  - the digest is on file BEFORE the submission, and a retry reads it back
 *    instead of placing a second order;
 *  - only a definitive refusal, or a digest the chain provably never saw, lets
 *    the same intent be built again;
 *  - how an order ended comes from the activity feed and the chain, never a guess.
 */
import { describe, expect, it } from 'vitest';

import type { ChainAccount, ChainOrderState, ChainReader, LandingStatus, PlacedOrder } from '../src/direct/chain.ts';
import {
  decodeExecutionId,
  DirectCapabilityUnavailable,
  PredictDirectClient,
} from '../src/direct/client.ts';
import { decodeMarketHandle } from '../src/direct/handle.ts';
import { BOUND_FUNCTIONS, type FunctionShape } from '../src/direct/abi.ts';
import { DirectDeploymentError } from '../src/direct/deployment.ts';
import { DirectHttp } from '../src/direct/http.ts';
import { DirectVerificationError } from '../src/direct/verify.ts';
import { PredictAgentApiError, PredictAgentTransportError } from '../src/errors.ts';
import { createMemoryIntentStore, type IntentStore } from '../src/intent-store.ts';
import { suiTransactionDigest } from '../src/sui-digest.ts';
import { normalizeSuiAddress } from '../src/sui-tx.ts';
import { buildPlace, buildSell, deployment } from './direct-fixtures.ts';

const AGENT = normalizeSuiAddress(`0x${'a'.repeat(64)}`);
const OWNER = normalizeSuiAddress(`0x${'e'.repeat(64)}`);
const ACCOUNT = normalizeSuiAddress(`0x${'c'.repeat(64)}`);
const ONCHAIN = normalizeSuiAddress(`0x${'2'.repeat(64)}`);
const ROUND = '753a7825-963e-4b67-8978-7bc0b27d6867';
// The intent store stamps records with the real clock, so the client's clock
// starts there too; the tests move it forward, never back.
const NOW = Date.now();

interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: any;
}

type Handler = (call: Call) => { status?: number; data?: unknown; error?: { code: number; message: string } } | 'THROW';

const envelope = (result: ReturnType<Handler>): Response => {
  if (result === 'THROW') throw new TypeError('socket hang up');
  const status = result.status ?? 200;
  const body = result.error === undefined ? { success: true, data: result.data } : { success: false, error: result.error };
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
};

const delegated = (mask = 15, ownerAddress: string | null = OWNER) => ({
  data: {
    accounts: [{ accountId: ACCOUNT, ownerAddress, delegate: { delegateAddress: AGENT, predictPermissions: mask, expiresAtMs: null } }],
    unverifiedAccounts: [],
    truncated: false,
  },
});

const round = {
  id: ROUND,
  marketId: 'cat-1',
  phase: 'open',
  startsAt: 1_789_000_000,
  endsAt: 1_798_779_540,
  sides: [
    { key: 'up', oddsCents: 43, trade: { marketId: ONCHAIN, selection: 'YES' } },
    { key: 'down', oddsCents: 58, trade: { marketId: ONCHAIN, selection: 'NO' } },
  ],
};


/**
 * A bet the history keeps after its order filled.
 *
 * This row outlives the position it names: the registry drops its
 * order→position index when the position is sold or claimed, and after that
 * this is the only place the two are still tied together.
 */
function filledBet(overrides: Record<string, unknown> = {}) {
  return {
    betId: `${ONCHAIN}:9`,
    orderId: '77',
    marketId: 'cat-1',
    roundId: ROUND,
    positionId: '9',
    marketSlug: 'us-iran',
    cardSnapshot: { kind: 'politics' },
    side: 'up',
    lockedOddsCents: 43,
    avgFillPriceCents: 43.1,
    stake: { amountUsd: 5, token: 'USD' },
    placedAt: NOW,
    settledAt: null,
    outcome: 'pending',
    submissionState: 'confirmed',
    payoutUsd: null,
    shares: 11.6,
    roundEndsAt: null,
    ...overrides,
  };
}

/** The server's own paging: newest first, an opaque cursor, a null at the end. */
function paged(rows: any[], call: Call, key: 'activity' | 'bets') {
  const limit = Number(call.query['limit'] ?? '100');
  const from = call.query['cursor'] === undefined ? 0 : Number(call.query['cursor']);
  const page = rows.slice(from, from + limit);
  const next = from + limit < rows.length ? String(from + limit) : null;
  return { [key]: page, nextCursor: next };
}

function fakeWaterx(overrides: Record<string, Handler> = {}) {
  const calls: Call[] = [];
  const activity: any[] = [];
  const bets: any[] = [];
  const handlers: Record<string, Handler> = {
    'GET account/delegated': () => delegated(),
    'GET account': () => ({ data: [{ accountId: ACCOUNT, owner: OWNER, accountIndex: 0, isMainAccount: true }] }),
    'GET predict/browse': () => ({
      data: {
        items: [{ kind: 'market', market: { id: 'cat-1', slug: 'us-iran', title: 'Will the U.S. invade Iran?', category: 'politics' }, nextRound: round }],
        nextCursor: null,
      },
    }),
    'GET predict/quotes': () => ({ data: { [ROUND]: { up: 43, down: 58 } } }),
    'GET predict/quotes/bid': () => ({ data: { [ROUND]: { up: 41, down: 56 } } }),
    'GET predict/quotes/no': () => ({ data: {} }),
    // Both histories page, because the real ones do: the client must not assume
    // that one read of the newest hundred rows is the whole account.
    'GET predict/bets/me/activity': (call) => ({ data: paged(activity, call, 'activity') }),
    'GET predict/bets/me': (call) => ({ data: paged(bets, call, 'bets') }),
    'POST sponsor/execute': (call) => ({ data: { digest: call.body.digest } }),
    ...overrides,
  };
  const fetch = (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/+/u, '');
    const call: Call = {
      method: init?.method ?? 'GET',
      path,
      query: Object.fromEntries(url.searchParams),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    };
    calls.push(call);
    const key = `${call.method} ${path}`;
    let handler = handlers[key];
    if (handler === undefined && key.startsWith('POST predict/bets/place')) handler = placeHandler;
    if (handler === undefined && key.startsWith('POST predict/bets/sell')) handler = sellHandler;
    if (handler === undefined) throw new Error(`fake WaterX has no ${key}`);
    const result = handler(call);
    return result instanceof Promise ? envelope(await result) : envelope(result);
  }) as unknown as typeof globalThis.fetch;
  return { calls, activity, bets, fetch, handlers };
}

const placeHandler: Handler = ((call: Call) =>
  (async () => {
    const b = call.body;
    const bytes = await buildPlace(
      {
        accountId: b.accountId,
        marketId: b.marketId,
        selection: b.selection,
        maxSpend: BigInt(b.maxSpend),
        minShares: BigInt(b.minShares),
        priceCapBps: BigInt(b.priceCapBps),
        expiryTs: BigInt(b.expiryTs),
      },
      b.delegateSender,
    );
    return { data: { sponsored: true, txBytes: Buffer.from(bytes).toString('base64'), digest: suiTransactionDigest(bytes) } };
  })()) as unknown as Handler;

const sellHandler: Handler = ((call: Call) =>
  (async () => {
    const b = call.body;
    const bytes = await buildSell(
      {
        accountId: b.accountId,
        positionId: BigInt(b.positionId),
        closeShares: BigInt(b.closeShares),
        minProceeds: 1_300_000n,
        expiryTs: BigInt(b.expiryTs),
      },
      b.delegateSender,
    );
    return { data: { sponsored: true, txBytes: Buffer.from(bytes).toString('base64'), digest: suiTransactionDigest(bytes) } };
  })()) as unknown as Handler;

class FakeChain implements ChainReader {
  readonly statuses = new Map<string, LandingStatus>();
  landing(digest: string): Promise<LandingStatus> {
    return Promise.resolve(this.statuses.get(digest) ?? 'SUCCESS');
  }
}

function setup(options: { overrides?: Record<string, Handler>; store?: IntentStore; clock?: { now: number } } = {}) {
  const waterx = fakeWaterx(options.overrides);
  const chain = new FakeChain();
  const clock = options.clock ?? { now: NOW };
  const signed: Uint8Array[] = [];
  const store = options.store ?? createMemoryIntentStore();
  const client = new PredictDirectClient({
    baseUrl: 'https://waterx.test.invalid',
    network: 'mainnet',
    signer: {
      toSuiAddress: () => AGENT,
      signTransaction: (bytes: Uint8Array) => {
        signed.push(bytes);
        return Promise.resolve({ signature: 'sig-base64', bytes: '' });
      },
      signPersonalMessage: () => Promise.reject(new Error('direct mode signs no message')),
    },
    fetch: waterx.fetch,
    deployment: { load: () => Promise.resolve(deployment) },
    chain,
    intentStore: store,
    now: () => clock.now,
  });
  return { client, waterx, chain, signed, store, clock };
}

const BUY = {
  accountId: ACCOUNT,
  outcomeId: 'YES' as const,
  side: 'BUY' as const,
  size: { buyAmount: '5' },
  maxSlippageBps: 100,
};

async function marketId(client: PredictDirectClient): Promise<string> {
  const listing = await client.searchMarkets({ search: 'iran' });
  expect(listing.resolution.status).toBe('RESOLVED');
  return listing.resolution.marketId!;
}

describe('markets and quotes', () => {
  it('projects a binary round into one market whose id carries the round and both legs', async () => {
    const { client } = setup();
    const { markets, resolution } = await client.searchMarkets({ search: 'Iran' });
    expect(markets).toHaveLength(1);
    const market = markets[0]!;
    expect(decodeMarketHandle(market.marketId)).toEqual({
      roundId: ROUND,
      onchainMarketId: ONCHAIN,
      yesSide: 'up',
      noSide: 'down',
    });
    expect(market).toMatchObject({
      title: 'Will the U.S. invade Iran?',
      status: 'PREGAME',
      tradeable: true,
      closesAt: '2027-01-01T04:59:00.000Z',
    });
    expect(market.outcomes).toEqual([
      expect.objectContaining({ outcomeId: 'YES', indicativeAsk: '0.43', indicativeBid: '0.41' }),
      expect.objectContaining({ outcomeId: 'NO', indicativeAsk: '0.58', indicativeBid: '0.56' }),
    ]);
    expect(resolution).toEqual({ status: 'RESOLVED', normalizedQuery: 'iran', marketId: market.marketId, matchCount: 1 });
  });

  it('titles a market by its question when the catalog title is null', async () => {
    const { client } = setup({
      overrides: {
        'GET predict/browse': () => ({
          data: {
            items: [{ kind: 'market', market: { id: 'cat-1', slug: 'nebius', title: null, category: 'politics', display: { question: 'Will Nebius be acquired?' } }, nextRound: round }],
            nextCursor: null,
          },
        }),
      },
    });
    const listing = await client.getMarkets({ limit: 5 });
    expect(listing.markets[0]?.title).toBe('Will Nebius be acquired?');
  });

  it('never calls a page of one a unique answer when the server has more', async () => {
    const { client } = setup({
      overrides: {
        'GET predict/browse': () => ({
          data: {
            items: [{ kind: 'market', market: { id: 'c', slug: 's', title: 't', category: 'politics' }, nextRound: round }],
            nextCursor: 'more',
          },
        }),
      },
    });
    const { resolution } = await client.searchMarkets({ search: 'x', limit: 1 });
    expect(resolution.status).toBe('AMBIGUOUS');
    expect(resolution.marketId).toBeNull();
  });

  it('quotes the leg’s ask for a buy and bid for a sell, and remembers the title', async () => {
    const { client } = setup();
    const id = await marketId(client);
    expect((await client.getQuote({ marketId: id, outcomeId: 'NO', side: 'BUY', size: { buyAmount: '5' } })).expectedPrice).toBe('0.58');
    expect((await client.getQuote({ marketId: id, outcomeId: 'YES', side: 'SELL', size: { sellShares: '5' } })).expectedPrice).toBe('0.41');
    expect((await client.getMarket(id)).market.title).toBe('Will the U.S. invade Iran?');
  });

  it('refuses an id it did not issue, and a leg with no live price', async () => {
    const { client } = setup({ overrides: { 'GET predict/quotes': () => ({ data: { [ROUND]: { up: null } } }) } });
    await expect(client.getMarket('0x1234')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const id = await marketId(client).catch(() => '');
    const handle = id === '' ? `wxp1.${ROUND}.${Buffer.from(ONCHAIN.slice(2), 'hex').toString('base64url')}.up.down` : id;
    await expect(client.getQuote({ marketId: handle, outcomeId: 'YES', side: 'BUY', size: { buyAmount: '1' } })).rejects.toMatchObject({
      code: 'QUOTE_UNAVAILABLE',
    });
  });
});

describe('placing a buy', () => {
  it('sends a capped order, verifies it, files the digest, then submits', async () => {
    const { client, waterx, signed, store } = setup();
    const id = await marketId(client);
    let filedBeforeSubmit = false;
    waterx.handlers['POST sponsor/execute'] = (call) =>
      (async () => {
        const pending = await store.pending();
        filedBeforeSubmit = pending.some((record) => record.executionId !== undefined && record.executionId.includes(call.body.digest));
        return { data: { digest: call.body.digest } };
      })() as never;

    const result = await client.executeMarketOrder({ ...BUY, marketId: id });

    const place = waterx.calls.find((call) => call.path === 'predict/bets/place')!;
    // 0.43 ask, 1% slippage → 0.4343 floored to 4343 bps. Never the web app's 10000.
    expect(place.body).toMatchObject({
      sender: OWNER,
      delegateSender: AGENT,
      accountId: ACCOUNT,
      marketId: ONCHAIN,
      selection: 'YES',
      maxSpend: '5000000',
      priceCapBps: '4343',
      minShares: '11512779',
      expiryTs: String(NOW + 60_000),
    });
    expect(signed).toHaveLength(1);
    expect(filedBeforeSubmit).toBe(true);
    expect(result).toMatchObject({ status: 'SUBMITTED', terminal: false, enforcedWorstPrice: '0.4343', idempotencyKeyReplayed: false });
    expect(decodeExecutionId(result.executionId)).toMatchObject({ owner: OWNER, side: 'BUY' });
  });

  it('probes the build path: builds and verifies an order, and signs and submits nothing', async () => {
    const { client, waterx, signed, store } = setup();
    const id = await marketId(client);
    const probe = await client.probeOrder({ ...BUY, marketId: id });
    expect(probe).toMatchObject({ call: 'place_order', enforcedWorstPrice: '0.4343', consolidationLegs: 0 });
    expect(probe.digest).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u);
    expect(signed).toHaveLength(0);
    expect(waterx.calls.some((call) => call.path === 'sponsor/execute')).toBe(false);
    expect(await store.pending()).toHaveLength(0);
  });

  it('follows the order to its fill, which the feed alone cannot name', async () => {
    // The shape here is the server's, not a convenience: a `bought` row is
    // position-backed, so its `orderIds` is EMPTY and its digest is the
    // keeper's. Nothing on it points back at this submission, so the feed can
    // show the fill and still not be able to say it is ours. The bet history
    // is what joins the two, and this client has no chain order reads at all.
    const { client, waterx } = setup();
    const id = await marketId(client);
    const first = await client.executeMarketOrder({ ...BUY, marketId: id });
    const digest = decodeExecutionId(first.executionId).digest;
    waterx.activity.push({ kind: 'bought_pending', txDigest: digest, orderIds: ['77'], positionIds: [], timestampMs: NOW, roundId: ROUND, side: 'up', shares: null, amountUsd: 5, oddsCents: 43 });
    expect((await client.readExecution(first.executionId)).status).toBe('PENDING_FILL');

    waterx.activity.unshift({ kind: 'bought', txDigest: 'FillDigest', orderIds: [], positionIds: ['9'], timestampMs: NOW + 1000, roundId: ROUND, side: 'up', shares: 11.6, amountUsd: 5, oddsCents: 43.1 });
    expect((await client.readExecution(first.executionId)).status).toBe('PENDING_FILL');

    waterx.bets.push(filledBet({ orderId: '77', positionId: '9' }));
    const settled = await client.readExecution(first.executionId);
    expect(settled).toMatchObject({
      status: 'FILLED',
      terminal: true,
      fee: { available: false, reason: 'EMBEDDED_IN_PRICE' },
      fill: { filledAmount: '5', filledShares: '11.6', avgFillPrice: '0.431', txDigest: 'FillDigest' },
    });
    // Asked of the whole history, never of `active`: the case this read exists
    // for is a position that is no longer active.
    expect(waterx.calls.some((call) => call.path === 'predict/bets/me' && call.query['filter'] === 'all')).toBe(true);
  });

  it('reports a cancelled order as cancelled, and a failed transaction as rejected', async () => {
    const { client, waterx, chain } = setup();
    const id = await marketId(client);
    const a = await client.executeMarketOrder({ ...BUY, marketId: id });
    waterx.activity.push({ kind: 'bought_unfilled', txDigest: decodeExecutionId(a.executionId).digest, orderIds: ['5'], positionIds: [], timestampMs: NOW, roundId: ROUND, side: 'up', shares: null, amountUsd: null, oddsCents: null });
    expect((await client.readExecution(a.executionId)).status).toBe('CANCELLED');
    const b = await client.executeMarketOrder({ ...BUY, marketId: id, size: { buyAmount: '6' } });
    chain.statuses.set(decodeExecutionId(b.executionId).digest, 'FAILURE');
    expect((await client.readExecution(b.executionId)).status).toBe('REJECTED');
  });

  it('signs nothing when the digest is not the digest of the bytes', async () => {
    const { client, waterx, signed, store } = setup();
    const id = await marketId(client);
    const honest = placeHandler;
    waterx.handlers['POST predict/bets/place'] = ((call: Call) =>
      (async () => {
        const result = (await (honest(call) as unknown as Promise<{ data: Record<string, string> }>));
        return { data: { ...result.data, digest: `${'1'.repeat(43)}` } };
      })()) as unknown as Handler;
    await expect(client.executeMarketOrder({ ...BUY, marketId: id })).rejects.toMatchObject({ rule: 'DIGEST' });
    expect(signed).toHaveLength(0);
    expect(await store.pending()).toHaveLength(0);
    expect(waterx.calls.some((call) => call.path === 'sponsor/execute')).toBe(false);
  });

  it('signs nothing when the bytes are not the order asked for', async () => {
    const { client, signed, waterx, store } = setup({
      overrides: {
        'POST predict/bets/place': ((call: Call) =>
          placeHandler({ ...call, body: { ...call.body, priceCapBps: '10000' } })) as Handler,
      },
    });
    const id = await marketId(client);
    await expect(client.executeMarketOrder({ ...BUY, marketId: id })).rejects.toBeInstanceOf(DirectVerificationError);
    expect(signed).toEqual([]);
    expect(waterx.calls.some((call) => call.path === 'sponsor/execute')).toBe(false);
    // Nothing was sent, so the intent is free to be built again.
    expect(await store.pending()).toEqual([]);
  });

  it('refuses an unsponsored build — a delegate cannot pay its own gas', async () => {
    const { client, signed } = setup({
      overrides: { 'POST predict/bets/place': () => ({ data: { sponsored: false, txBytes: 'AA==' } }) },
    });
    const id = await marketId(client);
    await expect(client.executeMarketOrder({ ...BUY, marketId: id })).rejects.toMatchObject({ code: 'SPONSOR_UNAVAILABLE' });
    expect(signed).toEqual([]);
  });

  it('refuses before building when the delegation does not allow it', async () => {
    const { client, waterx } = setup({ overrides: { 'GET account/delegated': () => delegated(8) } });
    const id = await marketId(client);
    await expect(client.executeMarketOrder({ ...BUY, marketId: id })).rejects.toMatchObject({
      code: 'DELEGATION_PERMISSION_DENIED',
    });
    expect(waterx.calls.some((call) => call.path === 'predict/bets/place')).toBe(false);
  });

  it('refuses a bound below the current ask instead of sending an order that cannot fill', async () => {
    const { client } = setup();
    const id = await marketId(client);
    await expect(
      client.executeMarketOrder({ ...BUY, marketId: id, worstAcceptablePrice: '0.40' }),
    ).rejects.toMatchObject({ code: 'SLIPPAGE_EXCEEDED' });
  });

  it('prices off a reference quote while it lives, and refuses it after', async () => {
    const { client, waterx, clock } = setup();
    const id = await marketId(client);
    const quote = await client.getQuote({ marketId: id, outcomeId: 'YES', side: 'BUY', size: { buyAmount: '5' } });
    waterx.handlers['GET predict/quotes'] = () => ({ data: { [ROUND]: { up: 60, down: 40 } } });
    await client.executeMarketOrder({ ...BUY, marketId: id, referenceQuoteId: quote.quoteId });
    expect(waterx.calls.find((call) => call.path === 'predict/bets/place')!.body.priceCapBps).toBe('4343');
    clock.now += 6_000;
    await expect(
      client.executeMarketOrder({ ...BUY, marketId: id, size: { buyAmount: '7' }, referenceQuoteId: quote.quoteId }),
    ).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });
  });
});

describe('not placing an order twice', () => {
  it('reads an unanswered submission back instead of sending it again', async () => {
    const { client, waterx, signed } = setup({ overrides: { 'POST sponsor/execute': () => ({ status: 503, error: { code: 9001, message: 'busy' } }) } });
    const id = await marketId(client);
    const first = await client.executeMarketOrder({ ...BUY, marketId: id });
    expect(first).toMatchObject({ status: 'SUBMITTING', timedOut: true, terminal: false });

    const again = await client.executeMarketOrder({ ...BUY, marketId: id });
    expect(again.idempotencyKeyReplayed).toBe(true);
    expect(again.executionId).toBe(first.executionId);
    expect(waterx.calls.filter((call) => call.path === 'predict/bets/place')).toHaveLength(1);
    expect(signed).toHaveLength(1);
  });

  it('treats a dropped connection on submit the same way', async () => {
    const { client, waterx } = setup({ overrides: { 'POST sponsor/execute': () => 'THROW' } });
    const id = await marketId(client);
    const first = await client.executeMarketOrder({ ...BUY, marketId: id });
    expect(first.timedOut).toBe(true);
    await client.executeMarketOrder({ ...BUY, marketId: id });
    expect(waterx.calls.filter((call) => call.path === 'predict/bets/place')).toHaveLength(1);
  });

  it('builds again after a definitive refusal, which executed nothing', async () => {
    let refuse = true;
    const { client, waterx } = setup({
      overrides: {
        'POST sponsor/execute': (call) =>
          refuse ? { status: 410, error: { code: 9002, message: 'expired' } } : { data: { digest: call.body.digest } },
      },
    });
    const id = await marketId(client);
    await expect(client.executeMarketOrder({ ...BUY, marketId: id })).rejects.toMatchObject({ code: 'SIGNATURE_EXPIRED' });
    refuse = false;
    const retried = await client.executeMarketOrder({ ...BUY, marketId: id });
    expect(retried.status).toBe('SUBMITTED');
    expect(waterx.calls.filter((call) => call.path === 'predict/bets/place')).toHaveLength(2);
  });

  it('journals a caller’s own key: the same key reads back, a new key is a new order', async () => {
    const { client, waterx, signed, store, clock } = setup({ overrides: { 'POST sponsor/execute': () => 'THROW' } });
    const id = await marketId(client);
    const first = await client.executeMarketOrder({ ...BUY, marketId: id, idempotencyKey: 'caller-key-0001' });
    expect(first).toMatchObject({ timedOut: true, idempotencyKey: 'caller-key-0001' });
    expect((await store.pending())[0]?.executionId).toBe(first.executionId);

    const again = await client.executeMarketOrder({ ...BUY, marketId: id, idempotencyKey: 'caller-key-0001' });
    expect(again).toMatchObject({ executionId: first.executionId, idempotencyKey: 'caller-key-0001', idempotencyKeyReplayed: true });
    expect(signed).toHaveLength(1);

    clock.now += 1_000;
    await client.executeMarketOrder({ ...BUY, marketId: id, idempotencyKey: 'caller-key-0002' });
    expect(waterx.calls.filter((call) => call.path === 'predict/bets/place')).toHaveLength(2);
  });

  it('lists what it sent and has not seen settle, and settles what has', async () => {
    const { client, waterx, store } = setup();
    const id = await marketId(client);
    const first = await client.executeMarketOrder({ ...BUY, marketId: id });
    const second = await client.executeMarketOrder({ ...BUY, marketId: id, size: { buyAmount: '6' } });
    // A reservation that never reached the sponsor is not an order.
    await store.reserve({ ...BUY, marketId: id, size: { buyAmount: '7' } });

    const open = await client.listUnsettled(ACCOUNT);
    expect(open.map((row) => row.executionId).sort()).toEqual([first.executionId, second.executionId].sort());
    expect(open[0]).toMatchObject({ side: 'BUY', marketId: id, outcomeId: 'YES', terminalAt: null });
    expect(await client.listUnsettled(normalizeSuiAddress('0x99'))).toEqual([]);

    const digest = decodeExecutionId(first.executionId).digest;
    waterx.activity.push({ kind: 'bought_unfilled', txDigest: digest, orderIds: ['5'], positionIds: [], timestampMs: NOW, roundId: ROUND, side: 'up', shares: null, amountUsd: 5, oddsCents: 43 });
    const after = await client.listUnsettled(ACCOUNT);
    expect(after.map((row) => row.executionId)).toEqual([second.executionId]);
    expect((await store.find({ ...BUY, marketId: id }))?.status).toBe('SETTLED');
  });

  it('builds again only once the chain provably never saw the first digest', async () => {
    const { client, waterx, chain, clock } = setup({ overrides: { 'POST sponsor/execute': () => ({ status: 502, error: { code: 500, message: 'bad gateway' } }) } });
    const id = await marketId(client);
    const first = await client.executeMarketOrder({ ...BUY, marketId: id });
    const digest = decodeExecutionId(first.executionId).digest;
    chain.statuses.set(digest, 'NOT_FOUND');
    // Too early: the sponsor session might still carry it.
    await client.executeMarketOrder({ ...BUY, marketId: id });
    expect(waterx.calls.filter((call) => call.path === 'predict/bets/place')).toHaveLength(1);
    // Later, still unseen: it can never execute, so a fresh attempt is safe.
    clock.now += 11 * 60_000;
    waterx.handlers['POST sponsor/execute'] = (call) => ({ data: { digest: call.body.digest } });
    const fresh = await client.executeMarketOrder({ ...BUY, marketId: id });
    expect(fresh.idempotencyKeyReplayed).toBe(false);
    expect(fresh.executionId).not.toBe(first.executionId);
    expect(waterx.calls.filter((call) => call.path === 'predict/bets/place')).toHaveLength(2);
  });
});

describe('selling', () => {
  const SELL = {
    accountId: ACCOUNT,
    outcomeId: 'YES' as const,
    side: 'SELL' as const,
    size: { sellShares: '3' },
    positionId: '42',
    maxSlippageBps: 500,
  };

  it('accepts the backend’s floor when it clears ours, and reports what it enforces', async () => {
    // Bid 0.41 at 10% (2× 5%) → floor ceil(3 × 0.369) = 1.107 < 1.3 from the backend.
    const { client, waterx } = setup();
    const id = await marketId(client);
    const result = await client.executeMarketOrder({ ...SELL, marketId: id });
    expect(waterx.calls.find((call) => call.path === 'predict/bets/sell')!.body).toMatchObject({
      positionId: '42',
      closeShares: '3000000',
      slippageBps: '500',
    });
    expect(result.enforcedWorstPrice).toBe('0.433334');
  });

  it('refuses a floor below ours', async () => {
    const { client, signed } = setup({ overrides: { 'GET predict/quotes/bid': () => ({ data: { [ROUND]: { up: 60 } } }) } });
    const id = await marketId(client);
    await expect(client.executeMarketOrder({ ...SELL, marketId: id })).rejects.toMatchObject({ rule: 'FLOOR' });
    expect(signed).toEqual([]);
  });
});

describe('accounts, positions and what this mode cannot answer', () => {
  it('lists delegated accounts in the Agent API shape, with the effective mask', async () => {
    const { client } = setup({ overrides: { 'GET account/delegated': () => delegated(0) } });
    const { accounts } = await client.listAuthorizedAccounts();
    expect(accounts).toEqual([
      expect.objectContaining({
        accountId: ACCOUNT,
        ownerAddress: OWNER,
        isSuspended: false,
        delegation: expect.objectContaining({ mayPlaceOrder: false, mayRequestClose: false }),
      }),
    ]);
  });

  it('lists positions of the main account with the leg resolved from the catalog', async () => {
    const { client, waterx } = setup({
      overrides: {
        'GET predict/markets/politics/us-iran': () => ({ data: { detail: { round } } }),
      },
    });
    waterx.bets.push({
      betId: `${ONCHAIN}:42`,
      orderId: '77',
      marketId: 'cat-1',
      roundId: ROUND,
      positionId: '42',
      marketSlug: 'us-iran',
      cardSnapshot: { kind: 'politics' },
      side: 'down',
      lockedOddsCents: 58,
      avgFillPriceCents: 57.9,
      stake: { amountUsd: 5, token: 'USD' },
      placedAt: NOW,
      settledAt: null,
      outcome: 'pending',
      submissionState: 'confirmed',
      payoutUsd: null,
      shares: 8.635578,
      roundEndsAt: null,
    });
    const { positions } = await client.getPositions(ACCOUNT);
    expect(positions).toEqual([
      expect.objectContaining({ positionId: '42', outcomeId: 'NO', shares: '8.635578', originalCost: '5', avgEntryPrice: '0.579' }),
    ]);
    expect(decodeMarketHandle(positions[0]!.marketId).onchainMarketId).toBe(ONCHAIN);
  });

  it('re-reads the delegation listing, so a grant made while waiting appears', async () => {
    let granted = false;
    const { client } = setup({
      overrides: {
        'GET account/delegated': () =>
          granted ? delegated() : { data: { accounts: [], unverifiedAccounts: [], truncated: false } },
      },
    });
    expect((await client.listAuthorizedAccounts()).accounts).toHaveLength(0);
    granted = true;
    expect((await client.listAuthorizedAccounts()).accounts).toHaveLength(1);
  });

  it('refuses positions of an account the public feed does not cover', async () => {
    const { client } = setup({
      overrides: { 'GET account': () => ({ data: [{ accountId: ACCOUNT, owner: OWNER, accountIndex: 1, isMainAccount: false }] }) },
    });
    await expect(client.getPositions(ACCOUNT)).rejects.toBeInstanceOf(DirectCapabilityUnavailable);
  });

  it('says plainly what has no public source', async () => {
    const { client } = setup();
    for (const read of [client.getEffectiveLimits(), client.getAllowance(), client.getFills(), client.getPerformance(), client.listExecutions()]) {
      await expect(read).rejects.toBeInstanceOf(DirectCapabilityUnavailable);
    }
  });

  it('maps public error numbers onto the shared vocabulary', async () => {
    const { client } = setup({ overrides: { 'GET account/delegated': () => ({ status: 429, error: { code: 9004, message: 'slow down' } }) } });
    const error = await client.listAuthorizedAccounts().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PredictAgentApiError);
    expect(error).toMatchObject({ code: 'RATE_LIMITED', retryable: true, details: expect.objectContaining({ publicCode: 9004 }) });
  });
});

describe('rate limits', () => {
  it('does not retry a 429 inside the window, and reports how long the server asked to wait', async () => {
    let calls = 0;
    const http = new DirectHttp({
      baseUrl: 'https://waterx.test.invalid',
      fetch: (async () => {
        calls += 1;
        return new Response(JSON.stringify({ success: false, error: { code: 9004, message: 'slow down' } }), {
          status: 429,
          headers: { 'retry-after-short': '1', 'retry-after-long': '1937' },
        });
      }) as unknown as typeof globalThis.fetch,
    });
    const error = await http.get('account/delegated').catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: 'RATE_LIMITED', details: expect.objectContaining({ retryAfterMs: 1_937_000 }) });
    expect(calls).toBe(1);
  });
});

describe('accounts read from the chain', () => {
  const ACCOUNT_TYPE = `${deployment.originals.account}::account::Account`;
  // The chain prints a permission key's package without the 0x.
  const PREDICT_KEY = `${deployment.originals.prediction.slice(2)}::account_data::WaterXPrediction`;
  const onChain = (overrides: Partial<ChainAccount> = {}, mask = 9, expiresAtMs: number | null = null): ChainAccount => ({
    type: ACCOUNT_TYPE,
    owner: OWNER,
    delegates: [{ address: AGENT, protocolPermissions: [{ keyType: PREDICT_KEY, mask }], expiresAtMs }],
    ...overrides,
  });

  function withChainAccount(account: ChainAccount | undefined, hints: string[] = [ACCOUNT]) {
    const waterx = fakeWaterx({
      // The index has not caught up with the grant.
      'GET account/delegated': () => ({ data: { accounts: [], unverifiedAccounts: [], truncated: false } }),
    });
    const chain: ChainReader = {
      landing: () => Promise.resolve('SUCCESS'),
      account: () => Promise.resolve(account),
    };
    const client = new PredictDirectClient({
      baseUrl: 'https://waterx.test.invalid',
      network: 'mainnet',
      signer: {
        toSuiAddress: () => AGENT,
        signTransaction: () => Promise.resolve({ signature: 'sig-base64', bytes: '' }),
        signPersonalMessage: () => Promise.reject(new Error('unused')),
      },
      fetch: waterx.fetch,
      deployment: { load: () => Promise.resolve(deployment) },
      chain,
      intentStore: createMemoryIntentStore(),
      accountHints: hints,
    });
    return { client, waterx };
  }

  it('finds a named account the index has not caught up with', async () => {
    const { client } = withChainAccount(onChain());
    const listing = await client.listAuthorizedAccounts();
    expect(listing.accounts).toEqual([
      expect.objectContaining({ accountId: ACCOUNT, ownerAddress: OWNER, delegation: expect.objectContaining({ mayPlaceOrder: true, mayRequestClose: true }) }),
    ]);
  });

  it('places an order on it, with the owner the chain names', async () => {
    const { client, waterx } = withChainAccount(onChain());
    const id = await marketId(client);
    await client.executeMarketOrder({ ...BUY, marketId: id });
    expect(waterx.calls.find((call) => call.path === 'predict/bets/place')?.body).toMatchObject({ sender: OWNER, delegateSender: AGENT });
  });

  it('grants nothing to a name: another wallet’s delegation, another package’s key, or an expired entry', async () => {
    const cases: ChainAccount[] = [
      onChain({ delegates: [{ address: OWNER, protocolPermissions: [{ keyType: PREDICT_KEY, mask: 9 }], expiresAtMs: null }] }),
      onChain({ delegates: [{ address: AGENT, protocolPermissions: [{ keyType: `${'1'.repeat(64)}::account_data::WaterXPrediction`, mask: 9 }], expiresAtMs: null }] }),
      onChain({}, 9, Date.now() - 1),
      onChain({ type: `${'2'.repeat(64)}::account::Account` }),
    ];
    for (const account of cases) {
      const { client } = withChainAccount(account);
      const listing = await client.listAuthorizedAccounts();
      expect(listing.accounts.every((row) => row.delegation.mayPlaceOrder === false)).toBe(true);
      const id = await marketId(client);
      await expect(client.executeMarketOrder({ ...BUY, marketId: id })).rejects.toMatchObject({ code: 'DELEGATION_PERMISSION_DENIED' });
    }
  });

  it('finds a grant the index missed from the chain’s own grant events, and verifies it', async () => {
    const stranger = normalizeSuiAddress(`0x${'7'.repeat(64)}`);
    const waterx = fakeWaterx({
      'GET account/delegated': () => ({ data: { accounts: [], unverifiedAccounts: [], truncated: false } }),
    });
    const asked: string[] = [];
    const chain: ChainReader = {
      landing: () => Promise.resolve('SUCCESS'),
      // The stranger's event names this agent too, but its account does not hold it.
      delegationCandidates: (pkg, delegate) => {
        asked.push(`${pkg}|${delegate}`);
        return Promise.resolve([ACCOUNT, stranger]);
      },
      account: (id) => Promise.resolve(id === ACCOUNT ? onChain() : onChain({ delegates: [] })),
    };
    const client = new PredictDirectClient({
      baseUrl: 'https://waterx.test.invalid',
      network: 'mainnet',
      signer: {
        toSuiAddress: () => AGENT,
        signTransaction: () => Promise.resolve({ signature: 'sig-base64', bytes: '' }),
        signPersonalMessage: () => Promise.reject(new Error('unused')),
      },
      fetch: waterx.fetch,
      deployment: { load: () => Promise.resolve(deployment) },
      chain,
    });
    const listing = await client.listAuthorizedAccounts();
    expect(listing.accounts.map((row) => row.accountId)).toEqual([ACCOUNT]);
    expect(asked).toEqual([`${deployment.originals.account}|${AGENT}`]);
  });

  it('answers from a named account while the index is rate limited', async () => {
    const { client, waterx } = withChainAccount(onChain());
    waterx.handlers['GET account/delegated'] = () => ({ status: 429, error: { code: 9004, message: 'slow down' } });
    expect((await client.listAuthorizedAccounts()).accounts).toHaveLength(1);
    const bare = withChainAccount(onChain(), []);
    bare.waterx.handlers['GET account/delegated'] = () => ({ status: 429, error: { code: 9004, message: 'slow down' } });
    await expect(bare.client.listAuthorizedAccounts()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });
});

describe('settlement read from the registry', () => {
  const REGISTRY = deployment.objects.marketRegistry;

  /** A chain that also answers order reads, as the Sui GraphQL reader does. */
  class RegistryChain extends FakeChain {
    placed: PlacedOrder[] = [{ registry: REGISTRY, orderId: '1857', kind: 'OPEN' }];
    order: ChainOrderState = { state: 'OPEN', expiryTs: 0, selfCancelAfterTs: 0, escrow: '5000000' };
    positions = new Set<string>();
    placedOrders(): Promise<PlacedOrder[] | undefined> {
      return Promise.resolve(this.placed);
    }
    orderState(): Promise<ChainOrderState> {
      return Promise.resolve(this.order);
    }
    positionOpen(_registry: string, positionId: string): Promise<boolean> {
      return Promise.resolve(this.positions.has(positionId));
    }
  }

  function withRegistry(overrides: Record<string, Handler> = {}) {
    const chain = new RegistryChain();
    const waterx = fakeWaterx(overrides);
    const clock = { now: NOW };
    const client = new PredictDirectClient({
      baseUrl: 'https://waterx.test.invalid',
      network: 'mainnet',
      signer: {
        toSuiAddress: () => AGENT,
        signTransaction: () => Promise.resolve({ signature: 'sig-base64', bytes: '' }),
        signPersonalMessage: () => Promise.reject(new Error('unused')),
      },
      fetch: waterx.fetch,
      deployment: { load: () => Promise.resolve(deployment) },
      chain,
      intentStore: createMemoryIntentStore(),
      now: () => clock.now,
    });
    return { client, chain, waterx, clock };
  }

  it('holds an open order as pending, and calls it expired once no fill can be reported', async () => {
    const { client, chain, clock } = withRegistry();
    const id = await marketId(client);
    const placed = await client.executeMarketOrder({ ...BUY, marketId: id });
    chain.order = { state: 'OPEN', expiryTs: NOW + 60_000, selfCancelAfterTs: NOW + 30_000, escrow: '5000000' };

    const pending = await client.readExecution(placed.executionId);
    expect(pending).toMatchObject({ status: 'PENDING_FILL', terminal: false, openOrder: { orderId: '1857', escrow: '5' } });

    clock.now = NOW + 60_000 + 299_999;
    expect((await client.readExecution(placed.executionId)).status).toBe('PENDING_FILL');
    clock.now = NOW + 60_000 + 300_000;
    const expired = await client.readExecution(placed.executionId);
    expect(expired).toMatchObject({
      status: 'EXPIRED',
      terminal: true,
      fill: undefined,
      openOrder: { cancellableAfter: new Date(NOW + 360_000).toISOString() },
    });
  });

  it('settles a buy the registry filled even while the feed is silent — or down', async () => {
    const { client, chain, waterx } = withRegistry();
    const id = await marketId(client);
    const placed = await client.executeMarketOrder({ ...BUY, marketId: id });
    chain.order = {
      state: 'FILLED',
      positionId: '1014',
      position: { filledShares: '11600000', filledCost: '5000000', openedTs: NOW + 5_000 },
    };
    const expected = {
      status: 'FILLED',
      terminal: true,
      fill: { filledAmount: '5', filledShares: '11.6', avgFillPrice: '0.431034', txDigest: null },
    };
    expect(await client.readExecution(placed.executionId)).toMatchObject(expected);

    waterx.handlers['GET predict/bets/me/activity'] = () => ({ status: 503, error: { code: 9001, message: 'down' } });
    expect(await client.readExecution(placed.executionId)).toMatchObject(expected);
  });

  it('settles a buy the keeper cancelled, found by the order id the chain named', async () => {
    // As on mainnet (order 38308): the feed has only the keeper's cancel, under
    // the keeper's digest, and the order is gone from the registry.
    const { client, chain, waterx } = withRegistry();
    const id = await marketId(client);
    const placed = await client.executeMarketOrder({ ...BUY, marketId: id });
    chain.order = { state: 'GONE' };
    expect((await client.readExecution(placed.executionId)).status).toBe('SUBMITTED');
    waterx.activity.push({ kind: 'bought_unfilled', txDigest: 'KeeperCancel', orderIds: ['1857'], positionIds: [], timestampMs: NOW, roundId: ROUND, side: 'up', shares: 0, amountUsd: 5, oddsCents: null });
    expect(await client.readExecution(placed.executionId)).toMatchObject({ status: 'CANCELLED', terminal: true, fill: undefined });
  });

  it('settles a filled buy whose position has since been sold', async () => {
    // The ending this whole path exists for. Closing a position drops the
    // registry's order→position index with it, so the chain that could once
    // prove the fill now says only GONE — the same answer it gives a cancel.
    // Left there, the buy reads as pending for good and a runtime that will
    // not trade past something unsettled never trades again.
    const { client, chain, waterx } = withRegistry();
    const id = await marketId(client);
    const placed = await client.executeMarketOrder({ ...BUY, marketId: id });
    const digest = decodeExecutionId(placed.executionId).digest;
    chain.order = { state: 'GONE' };
    waterx.activity.push(
      { kind: 'bought', txDigest: 'KeeperDigest', orderIds: [], positionIds: ['9'], timestampMs: NOW + 1_000, roundId: ROUND, side: 'up', shares: 11.6, amountUsd: 5, oddsCents: 43.1 },
      { kind: 'bought_pending', txDigest: digest, orderIds: ['1857'], positionIds: [], timestampMs: NOW, roundId: ROUND, side: 'up', shares: null, amountUsd: 5, oddsCents: 43 },
    );
    expect((await client.readExecution(placed.executionId)).status).toBe('PENDING_FILL');

    waterx.bets.push(filledBet({ orderId: '1857', positionId: '9', outcome: 'pending' }));
    expect(await client.readExecution(placed.executionId)).toMatchObject({
      status: 'FILLED',
      terminal: true,
      fill: { filledAmount: '5', filledShares: '11.6', txDigest: 'KeeperDigest' },
    });
  });

  it('settles a filled buy even when the fill itself is past the feed, without inventing one', async () => {
    // Status and detail are separate facts. The history proves the buy filled;
    // the keeper's row is where the amounts and its digest come from, and when
    // that row is no longer reachable the fill is reported absent rather than
    // guessed from the bet, which carries no fill time to guess it with.
    const { client, chain, waterx } = withRegistry();
    const id = await marketId(client);
    const placed = await client.executeMarketOrder({ ...BUY, marketId: id });
    chain.order = { state: 'GONE' };
    waterx.bets.push(filledBet({ orderId: '1857', positionId: '9' }));
    expect(await client.readExecution(placed.executionId)).toMatchObject({
      status: 'FILLED',
      terminal: true,
      fill: undefined,
      fee: { available: false, reason: 'NO_FILL_OBSERVED' },
    });
  });

  it('reads an order the history calls unfilled as cancelled, and a pending one as nothing', async () => {
    const { client, chain, waterx } = withRegistry();
    const id = await marketId(client);
    const placed = await client.executeMarketOrder({ ...BUY, marketId: id });
    chain.order = { state: 'GONE' };
    // No position, and the history has not ended it: that is not a verdict.
    const pending = filledBet({ orderId: '1857', positionId: '', outcome: 'pending', shares: 0 });
    waterx.bets.push(pending);
    expect((await client.readExecution(placed.executionId)).terminal).toBe(false);

    pending.outcome = 'unfilled';
    expect(await client.readExecution(placed.executionId)).toMatchObject({ status: 'CANCELLED', terminal: true });
  });

  it('walks the history past the first page, but never past the order it is looking for', async () => {
    const { client, chain, waterx } = withRegistry();
    const id = await marketId(client);
    const placed = await client.executeMarketOrder({ ...BUY, marketId: id });
    const digest = decodeExecutionId(placed.executionId).digest;
    chain.order = { state: 'GONE' };
    waterx.activity.push({ kind: 'bought_pending', txDigest: digest, orderIds: ['1857'], positionIds: [], timestampMs: NOW, roundId: ROUND, side: 'up', shares: null, amountUsd: 5, oddsCents: 43 });
    // A hundred newer bets, then ours: one page is not the account.
    for (let i = 0; i < 100; i += 1) {
      waterx.bets.push(filledBet({ betId: `filler-${String(i)}`, orderId: `90${String(i)}`, positionId: `90${String(i)}`, placedAt: NOW + 1 }));
    }
    waterx.bets.push(filledBet({ orderId: '1857', positionId: '9' }));
    expect((await client.readExecution(placed.executionId)).status).toBe('FILLED');

    // Same bet, but now everything ahead of it predates the order. A page whose
    // oldest row is older than the order cannot be hiding it, so the walk stops
    // there rather than reading an account's whole history back.
    const { client: bounded, chain: boundedChain, waterx: older } = withRegistry();
    const second = (await bounded.executeMarketOrder({ ...BUY, marketId: await marketId(bounded) })).executionId;
    boundedChain.order = { state: 'GONE' };
    older.activity.push({ kind: 'bought_pending', txDigest: decodeExecutionId(second).digest, orderIds: ['1857'], positionIds: [], timestampMs: NOW, roundId: ROUND, side: 'up', shares: null, amountUsd: 5, oddsCents: 43 });
    for (let i = 0; i < 100; i += 1) {
      older.bets.push(filledBet({ betId: `old-${String(i)}`, orderId: `80${String(i)}`, positionId: `80${String(i)}`, placedAt: NOW - 10_000 }));
    }
    older.bets.push(filledBet({ orderId: '1857', positionId: '9' }));
    expect((await bounded.readExecution(second)).terminal).toBe(false);
  });

  it('prefers the feed’s fill, which names the keeper’s transaction', async () => {
    const { client, chain, waterx } = withRegistry();
    const id = await marketId(client);
    const placed = await client.executeMarketOrder({ ...BUY, marketId: id });
    chain.order = { state: 'FILLED', positionId: '9' };
    const digest = decodeExecutionId(placed.executionId).digest;
    waterx.activity.push(
      { kind: 'bought', txDigest: 'KeeperDigest', orderIds: [], positionIds: ['9'], timestampMs: NOW, roundId: ROUND, side: 'up', shares: 11.6, amountUsd: 5, oddsCents: 43.1 },
      { kind: 'bought_pending', txDigest: digest, orderIds: ['1857'], positionIds: [], timestampMs: NOW, roundId: ROUND, side: 'up', shares: null, amountUsd: 5, oddsCents: 43 },
    );
    expect((await client.readExecution(placed.executionId)).fill?.txDigest).toBe('KeeperDigest');
  });

  it('ignores an order from another registry, and never guesses a gone buy', async () => {
    const { client, chain } = withRegistry();
    const id = await marketId(client);
    const placed = await client.executeMarketOrder({ ...BUY, marketId: id });
    chain.placed = [{ registry: normalizeSuiAddress('0x5'), orderId: '1', kind: 'OPEN' }];
    chain.order = { state: 'FILLED', positionId: '1' };
    expect((await client.readExecution(placed.executionId)).status).toBe('SUBMITTED');

    chain.placed = [{ registry: REGISTRY, orderId: '1857', kind: 'OPEN' }];
    chain.order = { state: 'GONE' };
    expect(await client.readExecution(placed.executionId)).toMatchObject({ status: 'SUBMITTED', terminal: false });
  });

  it('settles a sell by the position its close order named — the split-off one on a partial close', async () => {
    const { client, chain } = withRegistry();
    const id = await marketId(client);
    const sold = await client.executeMarketOrder({
      accountId: ACCOUNT,
      marketId: id,
      outcomeId: 'YES',
      side: 'SELL',
      size: { sellShares: '3' },
      positionId: '42',
      maxSlippageBps: 500,
    });
    // The source position 42 stays; the close was on 43.
    chain.placed = [{ registry: REGISTRY, orderId: '1858', kind: 'CLOSE', positionId: '43' }];
    chain.order = { state: 'GONE' };
    chain.positions = new Set(['42']);
    expect(await client.readExecution(sold.executionId)).toMatchObject({ status: 'FILLED', terminal: true });

    chain.positions = new Set(['42', '43']);
    expect(await client.readExecution(sold.executionId)).toMatchObject({ status: 'CANCELLED', terminal: true });
  });

  it('lets an expired order stop blocking the journal', async () => {
    const { client, chain, clock } = withRegistry();
    const id = await marketId(client);
    await client.executeMarketOrder({ ...BUY, marketId: id });
    chain.order = { state: 'OPEN', expiryTs: NOW + 60_000, selfCancelAfterTs: NOW + 30_000, escrow: '5000000' };
    expect(await client.listUnsettled(ACCOUNT)).toHaveLength(1);
    clock.now = NOW + 400_000;
    expect(await client.listUnsettled(ACCOUNT)).toHaveLength(0);
  });
});

describe('contract shapes checked before signing', () => {
  class ShapeChain extends FakeChain {
    reads = 0;
    broken = false;
    failing = false;
    functionShape(packageId: string, module: string, name: string): Promise<FunctionShape | undefined> {
      this.reads += 1;
      if (this.failing) return Promise.reject(new Error('graphql down'));
      const key = Object.keys(BOUND_FUNCTIONS).find((k) => k.endsWith(`::${module}::${name}`))!;
      const pinned = BOUND_FUNCTIONS[key]!;
      const named = (id: string): string => {
        for (const [original, config] of deployment.packageNames) if (config === id) return original;
        return id;
      };
      const parameters = pinned.parameters.map((p) =>
        p.replace(/\{([a-z_]+)\}/gu, (_w, k: string) => named(k)).replace(/\b0x2::/gu, `0x${'0'.repeat(63)}2::`),
      );
      if (this.broken && name === 'place_order') parameters.reverse();
      expect(packageId).toMatch(/^0x[0-9a-f]{64}$/u);
      return Promise.resolve({ typeParameters: pinned.typeParameters, parameters });
    }
  }

  function withShapes() {
    const chain = new ShapeChain();
    const waterx = fakeWaterx();
    const signed: Uint8Array[] = [];
    const client = new PredictDirectClient({
      baseUrl: 'https://waterx.test.invalid',
      network: 'mainnet',
      signer: {
        toSuiAddress: () => AGENT,
        signTransaction: (bytes: Uint8Array) => {
          signed.push(bytes);
          return Promise.resolve({ signature: 'sig-base64', bytes: '' });
        },
        signPersonalMessage: () => Promise.reject(new Error('unused')),
      },
      fetch: waterx.fetch,
      deployment: { load: () => Promise.resolve(deployment) },
      chain,
      intentStore: createMemoryIntentStore(),
    });
    return { client, chain, waterx, signed };
  }

  it('signs when the packages match, and asks the chain once for the whole client', async () => {
    const { client, chain, signed } = withShapes();
    const id = await marketId(client);
    await client.executeMarketOrder({ ...BUY, marketId: id });
    const afterFirst = chain.reads;
    await client.executeMarketOrder({ ...BUY, marketId: id, size: { buyAmount: '6' } });
    expect(signed).toHaveLength(2);
    expect(afterFirst).toBe(Object.keys(BOUND_FUNCTIONS).length);
    expect(chain.reads).toBe(afterFirst);
    expect(await client.checkAbi()).toEqual([]);
  });

  it('refuses to sign against packages whose shapes moved', async () => {
    const { client, chain, signed, waterx } = withShapes();
    chain.broken = true;
    const id = await marketId(client);
    await expect(client.executeMarketOrder({ ...BUY, marketId: id })).rejects.toMatchObject({ rule: 'ABI' });
    expect(signed).toHaveLength(0);
    expect(waterx.calls.some((call) => call.path === 'sponsor/execute')).toBe(false);
  });

  it('refuses when the shapes cannot be read, and asks again next time', async () => {
    const { client, chain, signed } = withShapes();
    chain.failing = true;
    const id = await marketId(client);
    await expect(client.executeMarketOrder({ ...BUY, marketId: id })).rejects.toBeInstanceOf(DirectDeploymentError);
    expect(signed).toHaveLength(0);
    chain.failing = false;
    await client.executeMarketOrder({ ...BUY, marketId: id });
    expect(signed).toHaveLength(1);
  });
});

describe('the Runner’s two-step write', () => {
  it('creates bytes to sign and an id that names them, then submits a signature for that id', async () => {
    const { client, waterx, signed } = setup();
    const id = await marketId(client);
    const quote = await client.getQuote({ marketId: id, outcomeId: 'YES', side: 'BUY', size: { buyAmount: '5' } });
    const created = await client.createExecution(
      { ...BUY, marketId: id, referenceQuoteId: quote.quoteId },
      { idempotencyKey: 'job-1:leg-0' },
    );
    expect(created).toMatchObject({ status: 'AWAITING_SIGNATURE', enforcedWorstPrice: '0.4343', referenceQuoteId: quote.quoteId });
    expect(decodeExecutionId(created.executionId).digest).toBe(created.sponsoredDigest);
    expect(Date.parse(created.signatureExpiresAt)).toBe(NOW + 50_000);
    // Nothing is signed or sent by the create.
    expect(signed).toHaveLength(0);
    expect(waterx.calls.some((call) => call.path === 'sponsor/execute')).toBe(false);

    const submitted = await client.submitExecution(created.executionId, 'runner-signature');
    expect(submitted).toEqual({ executionId: created.executionId, status: 'SUBMITTED', transactionDigest: created.sponsoredDigest });
    expect(waterx.calls.find((call) => call.path === 'sponsor/execute')?.body).toMatchObject({
      digest: created.sponsoredDigest,
      signature: 'runner-signature',
    });
  });

  it('throws a definitive refusal as it came, and anything else as a read-back', async () => {
    const { client, waterx } = setup();
    const id = await marketId(client);
    const quote = await client.getQuote({ marketId: id, outcomeId: 'YES', side: 'BUY', size: { buyAmount: '5' } });
    const created = await client.createExecution({ ...BUY, marketId: id, referenceQuoteId: quote.quoteId }, { idempotencyKey: 'k' });
    waterx.handlers['POST sponsor/execute'] = () => ({ status: 410, error: { code: 9002, message: 'expired' } });
    await expect(client.submitExecution(created.executionId, 'sig')).rejects.toMatchObject({ code: 'SIGNATURE_EXPIRED' });
    waterx.handlers['POST sponsor/execute'] = () => 'THROW';
    await expect(client.submitExecution(created.executionId, 'sig')).rejects.toBeInstanceOf(PredictAgentTransportError);
  });

  it('reads the delegation as permissions, and a failed read as unknown', async () => {
    const { client } = setup();
    expect(await client.getDelegation(ACCOUNT)).toMatchObject({ mayPlaceOrder: true, mayRequestClose: true });
    const other = await client.getDelegation(normalizeSuiAddress('0x55'));
    expect(other).toMatchObject({ mayPlaceOrder: false, mayRequestClose: false });
    const broken = setup({ overrides: { 'GET account/delegated': () => 'THROW' } });
    expect(await broken.client.getDelegation(ACCOUNT)).toMatchObject({ mayPlaceOrder: null, mayRequestClose: null });
  });

  it('reads a market’s phase from its page, and a round that is no longer current as ended', async () => {
    let current: Record<string, unknown> = { ...round, phase: 'live' };
    const { client } = setup({
      overrides: { 'GET predict/markets/politics/us-iran': () => ({ data: { detail: { round: current } } }) },
    });
    const id = await marketId(client);
    expect((await client.getMarket(id)).market.status).toBe('IN_PLAY');
    current = { ...round, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    expect((await client.getMarket(id)).market.status).toBe('CLOSED');
  });
});
