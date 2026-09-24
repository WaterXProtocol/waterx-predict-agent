/**
 * Direct mode end to end: the CLI against a fake WaterX, as the owner's
 * on-chain delegate, with no Agent API and no login (ADR-0013).
 *
 * What is protected here, at the level of a whole invocation:
 *  - nothing reaches `/agent-api`, and no personal message is signed;
 *  - an order is signed only after the policy authorized it, exactly once;
 *  - a replay under the same key reads the order back instead of placing it
 *    again, across separate invocations sharing one journal;
 *  - what has no public source says so, rather than answering empty;
 *  - `next` and `order preview` report "no server mandate" as a fact of the
 *    mode, not as a refusal waiting to happen.
 *
 * The transaction bytes are real: the same `@waterx/sdk` builder the backend
 * uses, from the SDK's own direct-mode fixtures.
 */
import {
  BOUND_FUNCTIONS,
  createMemoryIntentStore,
  suiTransactionDigest,
  InMemoryMarketCatalog,
  type IntentStore,
  type MarketCatalog,
} from '@waterx/predict-agent-sdk';
import { describe, expect, it } from 'vitest';

import { EXIT_CODES } from '../src/index.ts';
import { createMemoryLedgers } from '../src/ledgers.ts';
import { buildPlace, buildSell, CONFIG } from '../../sdk/tests/direct-fixtures.ts';
import { ACCOUNT_ID, AGENT_WALLET, BASE_URL, invoke, type InvokeOptions } from './harness.ts';

const OWNER = `0x${'e'.repeat(64)}`;
const ONCHAIN = `0x${'2'.repeat(64)}`;
const ROUND = '753a7825-963e-4b67-8978-7bc0b27d6867';

export const DIRECT_ENV: Record<string, string> = {
  WATERX_PREDICT_MODE: 'direct',
  WATERX_PREDICT_NETWORK: 'mainnet',
  // Real funds are opt-in on mainnet (ADR-0017); these tests are the operator
  // who opted in.
  WATERX_PREDICT_POLICY: 'interactive',
  WATERX_PREDICT_BASE_URL: BASE_URL,
  WATERX_PREDICT_AGENT_WALLET: AGENT_WALLET,
  WATERX_PREDICT_SIGNER_COMMAND: '/opt/waterx/sign',
};

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

interface World {
  activity: Record<string, unknown>[];
  /** The owner holds position 42 on this market. */
  holding?: boolean;
  sells?: number;
  /** The chain's grant events name this agent on the account. */
  grantEvents?: boolean;
  /** The registry holds the order open, long past its expiry. */
  expiredOrder?: boolean;
  sponsor: 'OK' | 'THROW';
  places: number;
}

const ok = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify({ success: true, data }), { status, headers: { 'content-type': 'application/json' } });

/** The public WaterX routes, waterx-config and Sui GraphQL, behind one fetch. */
function fakeWaterx(world: World): NonNullable<InvokeOptions['fallbackFetch']> {
  return async (url, init) => {
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as Record<string, string>);
    const key = `${method} ${url.pathname}`;
    switch (key) {
      case 'GET /mainnet.json':
      case 'GET /private/deployment.json':
        return new Response(JSON.stringify(CONFIG), { status: 200 });
      case 'POST /graphql':
      case 'POST /private/graphql': {
        const query = String((body as unknown as { query: string }).query);
        const variables = (body as unknown as { variables: Record<string, string> }).variables;
        const registry = (CONFIG['packages'] as Record<string, { market_registries?: { USD: string }; original_id: string }>)[
          'waterx_prediction'
        ]!;
        if (query.includes('asMovePackage')) {
          // The deployed call shapes, as the chain prints them: exactly the pinned ones.
          const originals = new Map(
            Object.entries(CONFIG['packages'] as Record<string, { original_id?: string }>).map(([key, value]) => [
              key,
              value.original_id,
            ]),
          );
          const key = Object.keys(BOUND_FUNCTIONS).find((k) => k.endsWith(`::${variables['m']}::${variables['f']}`));
          const pinned = key === undefined ? undefined : BOUND_FUNCTIONS[key];
          const fn =
            pinned === undefined
              ? null
              : {
                  typeParameters: Array.from({ length: pinned.typeParameters }, () => ({ constraints: [] })),
                  parameters: pinned.parameters.map((p) => ({
                    repr: p
                      .replace(/\{([a-z_]+)\}/gu, (_w, k: string) => originals.get(k) ?? k)
                      .replace(/\b0x2::/gu, `0x${'0'.repeat(63)}2::`),
                  })),
                };
          return new Response(JSON.stringify({ data: { object: { asMovePackage: { module: { function: fn } } } } }), {
            status: 200,
          });
        }
        if (query.includes('events(last')) {
          // Recent grant events, newest last, as the chain answers the fallback.
          const nodes =
            world.grantEvents === true && String(variables['t']).endsWith('::events::DelegateAdded')
              ? [{ contents: { json: { account_object_address: ACCOUNT_ID, delegate: AGENT_WALLET } } }]
              : [];
          return new Response(
            JSON.stringify({ data: { events: { nodes, pageInfo: { hasPreviousPage: false, startCursor: null } } } }),
            { status: 200 },
          );
        }
        if (query.includes('events(')) {
          return new Response(
            JSON.stringify({
              data: {
                transaction: {
                  effects: {
                    events: {
                      nodes: [
                        {
                          contents: {
                            type: { repr: `${registry.original_id}::events::OrderPlaced` },
                            json: { market_registry_id: registry.market_registries!.USD, order_id: '1857' },
                          },
                        },
                      ],
                    },
                  },
                },
              },
            }),
            { status: 200 },
          );
        }
        if (query.includes('object(') && variables['a'] === registry.market_registries!.USD) {
          return new Response(
            JSON.stringify({
              data: {
                object: {
                  asMoveObject: {
                    contents: {
                      json: { orders: { id: '0x71' }, position_id_by_order: { id: '0x72' }, positions: { id: '0x73' } },
                    },
                  },
                },
              },
            }),
            { status: 200 },
          );
        }
        if (query.includes('dynamicField')) {
          const open =
            variables['a'] === '0x71' && world.expiredOrder
              ? { value: { json: { value: { expiry_ts: '1000', self_cancel_after_ts: '500', max_spend: '5000000' } } } }
              : null;
          return new Response(JSON.stringify({ data: { address: { dynamicField: open } } }), { status: 200 });
        }
        if (query.includes('object(')) {
          // The account object as testnet prints it: the owner, and this agent
          // holding predict mask 15 under the deployment's own permission key.
          const packages = CONFIG['packages'] as Record<string, { original_id: string }>;
          return new Response(
            JSON.stringify({
              data: {
                object: {
                  asMoveObject: {
                    contents: {
                      type: { repr: `${packages['waterx_account']!.original_id}::account::Account` },
                      json: {
                        owner_address: OWNER,
                        delegates: [
                          {
                            delegate_address: AGENT_WALLET,
                            protocol_permissions: {
                              contents: [
                                {
                                  key: `${packages['waterx_prediction']!.original_id.slice(2)}::account_data::WaterXPrediction`,
                                  value: 15,
                                },
                              ],
                            },
                            expires_at_ms: null,
                          },
                        ],
                      },
                    },
                  },
                },
              },
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ data: { transaction: { effects: { status: 'SUCCESS' } } } }), { status: 200 });
      }
      case 'GET /account/delegated':
        return ok({
          accounts: [
            {
              accountId: ACCOUNT_ID,
              ownerAddress: OWNER,
              delegate: { delegateAddress: AGENT_WALLET, predictPermissions: 15, expiresAtMs: null },
            },
          ],
          unverifiedAccounts: [],
          truncated: false,
        });
      case 'GET /account':
        return ok([{ accountId: ACCOUNT_ID, owner: OWNER, accountIndex: 0, isMainAccount: true }]);
      case 'GET /predict/browse':
        return ok({
          items: [
            {
              kind: 'market',
              market: { id: 'cat-1', slug: 'us-iran', title: 'Will the U.S. invade Iran?', category: 'politics' },
              nextRound: round,
            },
          ],
          nextCursor: null,
        });
      case 'GET /predict/quotes':
        return ok({ [ROUND]: { up: 43, down: 58 } });
      case 'GET /predict/quotes/bid':
        return ok({ [ROUND]: { up: 41, down: 56 } });
      case 'GET /predict/quotes/no':
        return ok({});
      case 'GET /predict/bets/me/activity':
        return ok({ activity: world.activity, nextCursor: null });
      case 'GET /predict/bets/me':
        return ok({
          bets:
            world.holding === true
              ? [
                  {
                    betId: `${ONCHAIN}:order:1`,
                    positionId: '42',
                    marketSlug: 'us-iran',
                    roundId: ROUND,
                    side: 'up',
                    betAgainst: false,
                    shares: 11.6,
                    stake: { amountUsd: 5 },
                    avgFillPriceCents: 43,
                    submissionState: 'confirmed',
                    placedAt: 1_789_000_000_000,
                    cardSnapshot: { kind: 'politics-binary' },
                  },
                ]
              : [],
          nextCursor: null,
        });
      case 'GET /predict/markets/prediction/us-iran':
      case 'GET /predict/markets/politics/us-iran':
        return ok({ detail: { round } });
      case 'POST /predict/bets/sell': {
        world.sells = (world.sells ?? 0) + 1;
        const closeShares = BigInt(body!.closeShares!);
        const bytes = await buildSell(
          {
            accountId: body!.accountId,
            positionId: BigInt(body!.positionId!),
            closeShares,
            minProceeds: (closeShares * 40n) / 100n,
            expiryTs: BigInt(body!.expiryTs!),
          },
          body!.delegateSender!,
        );
        return ok({ sponsored: true, txBytes: Buffer.from(bytes).toString('base64'), digest: suiTransactionDigest(bytes) });
      }
      case 'POST /predict/bets/place': {
        world.places += 1;
        const bytes = await buildPlace(
          {
            accountId: body!.accountId,
            marketId: body!.marketId,
            selection: body!.selection,
            maxSpend: BigInt(body!.maxSpend!),
            minShares: BigInt(body!.minShares!),
            priceCapBps: BigInt(body!.priceCapBps!),
            expiryTs: BigInt(body!.expiryTs!),
          },
          body!.delegateSender!,
        );
        return ok({
          sponsored: true,
          txBytes: Buffer.from(bytes).toString('base64'),
          digest: suiTransactionDigest(bytes),
        });
      }
      case 'POST /sponsor/execute':
        if (world.sponsor === 'THROW') throw new TypeError('socket hang up');
        return ok({ digest: body!.digest });
      default:
        if (key.startsWith('GET /predict/markets/')) {
          // A market page this fake does not serve answers as the backend does: not found.
          return new Response(JSON.stringify({ success: false, error: { code: 404, message: 'not found' } }), { status: 404 });
        }
        throw new Error(`the fake WaterX has no ${key}`);
    }
  };
}

function setup(): {
  world: World;
  store: IntentStore;
  ledgers: ReturnType<typeof createMemoryLedgers>;
  run: (argv: readonly string[], extra?: InvokeOptions) => ReturnType<typeof invoke>;
} {
  const world: World = { activity: [], sponsor: 'OK', places: 0 };
  const store = createMemoryIntentStore();
  const catalog: MarketCatalog = new InMemoryMarketCatalog();
  const ledgers = createMemoryLedgers();
  return {
    world,
    store,
    ledgers,
    run: (argv, extra = {}) =>
      invoke(argv, {
        env: DIRECT_ENV,
        fallbackFetch: fakeWaterx(world),
        intentStore: store,
        marketCatalog: catalog,
        ledgers,
        ...extra,
      }),
  };
}

const apiCalls = (fetches: readonly { url: string }[]) => fetches.filter((call) => call.url.includes('/agent-api'));
const signed = (runs: readonly { input: string }[]) => runs.map((run) => (JSON.parse(run.input) as { type: string }).type);

async function resolveMarket(run: ReturnType<typeof setup>['run']): Promise<string> {
  const result = await run(['market', 'search', '--search', 'iran']);
  expect(result.envelope.ok).toBe(true);
  const data = result.envelope.data as { resolution: { status: string; marketId: string } };
  expect(data.resolution.status).toBe('RESOLVED');
  return data.resolution.marketId;
}

const buy = (marketId: string, extra: Record<string, unknown> = {}) => ({
  accountId: ACCOUNT_ID,
  marketId,
  outcomeId: 'YES',
  side: 'BUY',
  size: { buyAmount: '5' },
  maxSlippageBps: 100,
  ...extra,
});

/** Preview (for the approval), quote, execute — the documented interactive path. */
async function place(
  run: ReturnType<typeof setup>['run'],
  marketId: string,
  extra: Record<string, unknown> = {},
) {
  const preview = await run(['order', 'preview', '--input', JSON.stringify(buy(marketId))]);
  const token = (preview.envelope.data as { policy: { approvalToken: string } }).policy.approvalToken;
  const quote = await run([
    'market',
    'quote',
    '--input',
    JSON.stringify({ marketId, outcomeId: 'YES', side: 'BUY', size: { buyAmount: '5' } }),
  ]);
  const quoteId = (quote.envelope.data as { quote: { quoteId: string } }).quote.quoteId;
  return await run([
    'order',
    'execute',
    '--approve',
    token,
    '--approver',
    'tester',
    '--input',
    JSON.stringify(buy(marketId, { referenceQuoteId: quoteId, ...extra })),
  ]);
}

describe('direct mode', () => {
  it('describes itself as direct, and needs no login to do so', async () => {
    const { run } = setup();
    const result = await run(['describe']);
    const data = result.envelope.data as { api: { mode: string; network: string } };
    expect(data.api).toMatchObject({ mode: 'direct', network: 'mainnet' });
    expect(result.fetches).toHaveLength(0);
  });

  it('resolves a market from the public catalog without touching the Agent API', async () => {
    const { run } = setup();
    const marketId = await resolveMarket(run);
    expect(marketId.startsWith('wxp1.')).toBe(true);

    const got = await run(['market', 'get', '--marketId', marketId]);
    expect(got.envelope.data).toMatchObject({ market: { title: 'Will the U.S. invade Iran?' } });
    expect(apiCalls(got.fetches)).toHaveLength(0);
    expect(got.signerRuns).toHaveLength(0);
  });

  it('previews with no server mandate, and says why instead of calling it a refusal', async () => {
    const { run } = setup();
    const marketId = await resolveMarket(run);
    const result = await run(['order', 'preview', '--input', JSON.stringify(buy(marketId))]);

    expect(result.envelope.ok).toBe(true);
    expect(result.envelope.data).toMatchObject({
      placed: false,
      riskLimits: { available: false, reason: 'DIRECT_MODE_NO_SERVER_MANDATE' },
      capacity: { available: false, reason: 'DIRECT_MODE_NO_SERVER_MANDATE' },
    });
    expect(result.envelope.data).not.toHaveProperty('blockers');
    expect(apiCalls(result.fetches)).toHaveLength(0);
    expect(result.signerRuns).toHaveLength(0);
  });

  it('warns that a buy below the keeper’s minimum fill would be cancelled, and does not refuse it', async () => {
    const { run } = setup();
    const marketId = await resolveMarket(run);
    const small = await run(['order', 'preview', '--input', JSON.stringify(buy(marketId, { size: { buyAmount: '1' } }))]);
    expect(small.envelope.data).toMatchObject({
      fillRisk: { likelyCancelled: true, reason: 'BELOW_KEEPER_MIN_FILL' },
      policy: { decision: 'APPROVAL_REQUIRED' },
    });
    const enough = await run(['order', 'preview', '--input', JSON.stringify(buy(marketId, { size: { buyAmount: '2' } }))]);
    expect(enough.envelope.data).not.toHaveProperty('fillRisk');
  });

  it('repeats that warning on the write itself, for the caller that never previewed', async () => {
    // Under `delegated-auto` nothing previews. Without this the first news of
    // the floor is an order that sat and was cancelled, with its budget held
    // until the cancel lands.
    const { run } = setup();
    const marketId = await resolveMarket(run);
    const small = buy(marketId, { size: { buyAmount: '1' } });
    const preview = await run(['order', 'preview', '--input', JSON.stringify(small)]);
    const token = (preview.envelope.data as { policy: { approvalToken: string } }).policy.approvalToken;
    const quote = await run([
      'market',
      'quote',
      '--input',
      JSON.stringify({ marketId, outcomeId: 'YES', side: 'BUY', size: { buyAmount: '1' } }),
    ]);
    const quoteId = (quote.envelope.data as { quote: { quoteId: string } }).quote.quoteId;

    const placed = await run([
      'order',
      'execute',
      '--approve',
      token,
      '--approver',
      'tester',
      '--input',
      JSON.stringify({ ...small, referenceQuoteId: quoteId }),
    ]);

    expect(placed.envelope.data).toMatchObject({
      placed: true,
      fillRisk: { likelyCancelled: true, reason: 'BELOW_KEEPER_MIN_FILL' },
    });
  });

  it('places one approved order: one transaction signature, sponsored, and journaled', async () => {
    const { run, store, world } = setup();
    const marketId = await resolveMarket(run);
    const result = await place(run, marketId);

    expect(result.envelope.error).toBeUndefined();
    expect(result.exit).toBe(EXIT_CODES.OK);
    const data = result.envelope.data as { executionId: string; execution: { status: string; enforcedWorstPrice: string } };
    expect(data.executionId.startsWith('dx1.')).toBe(true);
    expect(data.execution).toMatchObject({ status: 'SUBMITTED', enforcedWorstPrice: '0.4343' });
    expect(signed(result.signerRuns)).toEqual(['TRANSACTION']);
    expect(world.places).toBe(1);
    expect(result.fetches.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toContain('POST /sponsor/execute');
    expect(apiCalls(result.fetches)).toHaveLength(0);
    // Nothing the chain would accept leaves on stdout.
    expect(result.stdout).not.toContain('txBytes');
    expect(result.stdout).not.toContain('fake-personal-message-signature');
    expect((await store.pending())[0]?.executionId).toBe(data.executionId);

    const read = await run(['order', 'get', '--executionId', data.executionId]);
    expect(read.envelope.ok).toBe(true);
    expect(read.signerRuns).toHaveLength(0);
  });

  it('reads an unanswered order back on a replay with the same key, across invocations', async () => {
    const { run, world } = setup();
    const marketId = await resolveMarket(run);
    world.sponsor = 'THROW';
    const key = { idempotencyKey: 'operator-key-0001' };

    const first = await place(run, marketId, key);
    expect(first.exit).toBe(EXIT_CODES.AMBIGUOUS);
    const firstId = (first.envelope.data as { executionId: string }).executionId;

    const again = await place(run, marketId, key);
    expect((again.envelope.data as { executionId: string }).executionId).toBe(firstId);
    expect(signed(again.signerRuns)).toEqual([]);
    expect(world.places).toBe(1);
  });

  it('refuses a transaction the backend built for something else, before signing', async () => {
    const { run } = setup();
    const marketId = await resolveMarket(run);
    const tampered: NonNullable<InvokeOptions['fallbackFetch']> = async (url, init) => {
      if (url.pathname === '/predict/bets/place') {
        const body = JSON.parse(String(init?.body)) as Record<string, string>;
        const bytes = await buildPlace(
          {
            accountId: body.accountId,
            marketId: body.marketId,
            selection: body.selection,
            // Ten times the budget the agent asked for.
            maxSpend: BigInt(body.maxSpend!) * 10n,
            minShares: BigInt(body.minShares!),
            priceCapBps: BigInt(body.priceCapBps!),
            expiryTs: BigInt(body.expiryTs!),
          },
          body.delegateSender!,
        );
        return ok({ sponsored: true, txBytes: Buffer.from(bytes).toString('base64'), digest: suiTransactionDigest(bytes) });
      }
      return await fakeWaterx({ activity: [], sponsor: 'OK', places: 0 })(url, init);
    };
    const preview = await run(['order', 'preview', '--input', JSON.stringify(buy(marketId))]);
    const token = (preview.envelope.data as { policy: { approvalToken: string } }).policy.approvalToken;
    const quote = await run([
      'market',
      'quote',
      '--input',
      JSON.stringify({ marketId, outcomeId: 'YES', side: 'BUY', size: { buyAmount: '5' } }),
    ]);
    const quoteId = (quote.envelope.data as { quote: { quoteId: string } }).quote.quoteId;
    const refused = await run(
      ['order', 'execute', '--approve', token, '--approver', 'tester', '--input', JSON.stringify(buy(marketId, { referenceQuoteId: quoteId }))],
      { fallbackFetch: tampered },
    );
    expect(refused.envelope.error).toMatchObject({ code: 'TRANSACTION_REFUSED', source: 'CLI' });
    expect(refused.exit).toBe(EXIT_CODES.REJECTED);
    expect(refused.signerRuns).toHaveLength(0);
    expect(refused.fetches.some((call) => call.url.endsWith('/sponsor/execute'))).toBe(false);
  });

  it('reports an order that can no longer fill as expired, with its escrow held until a cancel', async () => {
    const { run, world } = setup();
    const marketId = await resolveMarket(run);
    const placed = await place(run, marketId);
    const executionId = (placed.envelope.data as { executionId: string }).executionId;

    world.expiredOrder = true;
    const read = await run(['order', 'get', '--executionId', executionId]);
    expect(read.envelope.data).toMatchObject({
      execution: { status: 'EXPIRED', terminal: true },
      openOrder: { orderId: '1857', escrow: '5' },
      refund: { required: true, reason: 'ORDER_EXPIRED_UNFILLED' },
    });
    expect(read.signerRuns).toHaveLength(0);

    // Expired is an end: nothing is left in flight.
    const next = await run(['next']);
    expect((next.envelope.data as { state: string }).state).toBe('READY');
  });

  it('says a read has no public source, rather than answering an empty list', async () => {
    const { run } = setup();
    const result = await run(['account', 'executions', '--accountId', ACCOUNT_ID]);
    expect(result.envelope.error).toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      details: expect.objectContaining({ mode: 'direct', capability: 'account.executions' }),
    });
  });

  it('reports account status against the execution policy, not a mandate', async () => {
    const { run } = setup();
    const result = await run(['account', 'status', '--accountId', ACCOUNT_ID]);
    expect(result.envelope.data).toMatchObject({
      mode: 'direct',
      limits: { reason: 'DIRECT_MODE_NO_SERVER_MANDATE' },
      capacity: null,
      exposure: { openPositions: 0 },
    });
    expect(apiCalls(result.fetches)).toHaveLength(0);
  });

  it('walks next to READY without a login, then holds on what it sent and has not seen settle', async () => {
    const { run } = setup();
    const ready = await run(['next']);
    expect(ready.envelope.data).toMatchObject({
      state: 'READY',
      facts: {
        session: 'OPEN',
        deployment: { mode: 'direct', network: 'mainnet', realFunds: true },
        account: { status: 'READ', mandate: 'NONE_IN_DIRECT_MODE', unsettledSource: 'LOCAL_INTENT_JOURNAL' },
      },
    });
    expect(ready.signerRuns).toHaveLength(0);
    expect(apiCalls(ready.fetches)).toHaveLength(0);

    const marketId = await resolveMarket(run);
    const placed = await place(run, marketId);
    const executionId = (placed.envelope.data as { executionId: string }).executionId;

    const holding = await run(['next']);
    const data = holding.envelope.data as { state: string; facts: { account: { unsettledExecutions: { executionId: string }[] } } };
    expect(data.state).not.toBe('READY');
    expect(data.facts.account.unsettledExecutions.map((row) => row.executionId)).toEqual([executionId]);
  });

  it('reaches READY on a named account the delegation index has not caught up with', async () => {
    const { run, world } = setup();
    const lagging = {
      routes: {
        'GET /account/delegated': {
          status: 200,
          body: { success: true, data: { accounts: [], unverifiedAccounts: [], truncated: false } },
        },
      },
    };
    const unnamed = await run(['next'], lagging);
    expect((unnamed.envelope.data as { state: string }).state).toBe('AWAITING_OWNER');

    // Unnamed, but the chain's own grant events carry it: found and verified.
    world.grantEvents = true;
    const fromEvents = await run(['next'], lagging);
    expect(fromEvents.envelope.data).toMatchObject({ state: 'READY', facts: { accountId: ACCOUNT_ID } });
    world.grantEvents = false;

    const named = await run(['next'], {
      ...lagging,
      env: { ...DIRECT_ENV, WATERX_PREDICT_ACCOUNT_ID: ACCOUNT_ID },
    });
    expect(named.envelope.data).toMatchObject({ state: 'READY', facts: { accountId: ACCOUNT_ID } });
  });

  it('takes up the one authorized account, and never switches to another unless it is named', async () => {
    const { run, ledgers } = setup();
    const first = await run(['next']);
    expect(first.envelope.data).toMatchObject({ state: 'READY', facts: { adoption: { status: 'ADOPTED_NOW', accountId: ACCOUNT_ID } } });
    const again = await run(['next']);
    expect(again.envelope.data).toMatchObject({ facts: { adoption: { status: 'UNCHANGED' } } });
    expect(ledgers.audit.events.filter((e) => e.event === 'account.adopted')).toEqual([
      expect.objectContaining({ accountId: ACCOUNT_ID, basis: 'FIRST_SEEN' }),
    ]);

    // The owner's grant moved to a different account.
    const other = `0x${'d'.repeat(63)}7`;
    const moved = {
      routes: {
        'GET /account/delegated': {
          status: 200,
          body: {
            success: true,
            data: {
              accounts: [{ accountId: other, ownerAddress: OWNER, delegate: { delegateAddress: AGENT_WALLET, predictPermissions: 15, expiresAtMs: null } }],
              unverifiedAccounts: [],
              truncated: false,
            },
          },
        },
        'GET /account': {
          status: 200,
          body: { success: true, data: [{ accountId: other, owner: OWNER, accountIndex: 0, isMainAccount: true }] },
        },
      },
    };
    const conflict = await run(['next'], moved);
    const answer = conflict.envelope.data as { state: string; stop: boolean; handOver: { to: string } };
    expect(answer).toMatchObject({ state: 'ACCOUNT_CHOICE_NEEDED', stop: true, handOver: { to: 'AGENT_OPERATOR' } });
    expect(conflict.fetches.some((call) => call.url.includes('/predict/bets/me'))).toBe(false);

    const chosen = await run(['next', '--accountId', other], moved);
    expect(ledgers.audit.events.at(-1)).toMatchObject({
      event: 'account.adopted',
      accountId: other,
      basis: 'NAMED',
      namedBy: 'COMMAND',
      previous: ACCOUNT_ID,
    });
    expect(chosen.envelope.data).toMatchObject({ state: 'READY', facts: { adoption: { status: 'SWITCHED_BY_NAME', accountId: other } } });
    const settledOnIt = await run(['next'], moved);
    expect(settledOnIt.envelope.data).toMatchObject({ state: 'READY', facts: { adoption: { status: 'UNCHANGED' } } });
  });

  it('probes the write path in doctor on request: built and verified, never signed', async () => {
    const { run, world } = setup();
    const result = await run(['doctor', '--accountId', ACCOUNT_ID, '--probeWrite']);
    const checks = (result.envelope.data as { checks: { id: string; status: string; summary: string }[] }).checks;
    const probe = checks.find((check) => check.id === 'write-probe');
    expect(probe).toMatchObject({ status: 'PASS' });
    // No position is held, so there is nothing a close could name.
    expect(checks.find((check) => check.id === 'write-probe-sell')).toMatchObject({ status: 'SKIP' });
    expect(world.places).toBe(1);
    expect(result.signerRuns).toHaveLength(0);
    expect(result.fetches.some((call) => call.url.endsWith('/sponsor/execute'))).toBe(false);

    // Without the flag nothing is built.
    const plain = await run(['doctor', '--accountId', ACCOUNT_ID]);
    const plainChecks = (plain.envelope.data as { checks: { id: string }[] }).checks;
    expect(plainChecks.some((check) => check.id === 'write-probe')).toBe(false);
    expect(world.places).toBe(1);
  });

  it('is read-only on mainnet until the operator opts in, and says how', async () => {
    const { run } = setup();
    const env = { ...DIRECT_ENV };
    delete env['WATERX_PREDICT_POLICY'];
    const ready = await run(['next'], { env });
    const data = ready.envelope.data as { state: string; headline: string; suggestions: { command: string }[] };
    expect(data.state).toBe('READY');
    // It names the CHOOSER, not one of the three modes, and not an `export` a
    // tool host cannot perform (ADR-0021).
    expect(data.headline).toMatch(/waterx-predict policy/u);
    expect(data.headline).not.toMatch(/export /u);
    expect(data.suggestions.map((s) => s.command)).toContain('runtime.policy');
    expect(data.suggestions.map((s) => s.command)).not.toContain('order.preview');

    const marketId = await resolveMarket(run);
    const refused = await run(['order', 'execute', '--input', JSON.stringify(buy(marketId, { referenceQuoteId: 'dq1.1.1.x' }))], { env });
    expect(refused.envelope.error).toMatchObject({ code: 'POLICY_DENIED' });
    expect(refused.signerRuns).toHaveLength(0);
  });

  it('reads a private deployment’s document and chain where the operator points them', async () => {
    const { run } = setup();
    const result = await run(['doctor'], {
      env: {
        ...DIRECT_ENV,
        WATERX_PREDICT_DEPLOYMENT_URL: 'https://chain.test.invalid/private/deployment.json',
        WATERX_PREDICT_SUI_GRAPHQL_URL: 'https://chain.test.invalid/private/graphql',
      },
    });
    const paths = result.fetches.map((call) => new URL(call.url).pathname);
    expect(paths).toContain('/private/deployment.json');
    expect(paths).toContain('/private/graphql');
    expect(paths).not.toContain('/mainnet.json');
    expect(paths).not.toContain('/graphql');
  });

  it('probes a close too when a position is held, and still signs nothing', async () => {
    const { run, world } = setup();
    await resolveMarket(run);
    world.holding = true;
    const result = await run(['doctor', '--accountId', ACCOUNT_ID, '--probeWrite']);
    const checks = (result.envelope.data as { checks: { id: string; status: string; detail?: string }[] }).checks;
    expect(checks.find((check) => check.id === 'write-probe-sell')).toMatchObject({ status: 'PASS' });
    expect(world.sells).toBe(1);
    expect(result.signerRuns).toHaveLength(0);
    expect(result.fetches.some((call) => call.url.endsWith('/sponsor/execute'))).toBe(false);
  });

  it('checks the deployment document in doctor instead of logging in', async () => {
    const { run } = setup();
    const result = await run(['doctor']);
    const checks = (result.envelope.data as { checks: { id: string; status: string }[] }).checks;
    expect(checks.find((check) => check.id === 'deployment-config')?.status).toBe('PASS');
    expect(checks.find((check) => check.id === 'authentication')?.status).toBe('SKIP');
    expect(checks.find((check) => check.id === 'contract-shapes')?.status).toBe('PASS');
    // No server mandate exists in this mode, so it is not listed as missing.
    const requirements = (result.envelope.data as { requirements: { id: string }[] }).requirements;
    expect(requirements.map((row) => row.id)).not.toContain('riskProfile');
    expect(result.signerRuns).toHaveLength(0);
  });
});
