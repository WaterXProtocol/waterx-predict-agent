/**
 * The write plane: preview, execute, get, reconcile, execute-many.
 *
 * This is the file where a passing test is worth real money, so the assertions
 * are deliberately about what did NOT happen. A denial that reaches the network
 * first, a size unit that gets guessed, a timed-out wait that reads as a failure,
 * a batch that looks atomic — each of those is a bug that costs the operator, and
 * each has a test here that fails loudly rather than a comment saying it must not
 * occur.
 *
 * Every invocation goes through the real dispatcher with a stubbed transport and
 * a stubbed signer. Nothing opens a socket, spawns a process, or touches a real
 * key: `signerRuns` is a list of the requests a signer WOULD have received, and
 * it is the strongest evidence available that a refusal happened before signing.
 */
import { describe, expect, it } from 'vitest';

import { EXIT_CODES } from '../src/index.ts';
import { ACCOUNT_ID, AGENT_WALLET, ALLOWANCE_OK, AUTH_OK, BASE_URL, CONFIGURED_ENV, invoke } from './harness.ts';

const MARKET_ID = `0x${'d'.repeat(63)}3`;
const POSITION_ID = 'pos-1';
const QUOTE_ID = 'quote-abc';
const EXECUTION_ID = 'exec-abc';

const MARKET_OK = {
  status: 200,
  body: {
    market: {
      marketId: MARKET_ID,
      title: 'Will it rain',
      category: 'weather',
      status: 'OPEN',
      tradeable: true,
      event: { eventId: 'evt-1' },
      outcomes: [
        {
          outcomeId: 'YES',
          name: 'Yes',
          impliedProbability: '0.50',
          indicativeBid: '0.49',
          indicativeAsk: '0.51',
        },
      ],
      closesAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z',
    },
  },
} as const;

const QUOTE_OK = {
  status: 200,
  body: {
    quoteId: QUOTE_ID,
    marketId: MARKET_ID,
    outcomeId: 'YES',
    side: 'BUY',
    expectedPrice: '0.5000',
    expectedFillSize: null,
    availableSize: null,
    feeAmount: null,
    liquidityTier: 'TOP_OF_BOOK_ONLY',
    qualityFlags: [],
    asOf: '2026-08-12T00:00:00.000Z',
    expiresAt: '2026-08-12T00:00:03.000Z',
    onchainMarketIdHex: '0xabc',
    onchainSelection: 'YES',
  },
} as const;

/** A created execution, awaiting the agent's transaction signature. */
const created = (executionId = EXECUTION_ID) =>
  ({
    status: 200,
    body: {
      executionId,
      status: 'AWAITING_SIGNATURE',
      sponsoredTransactionBytes: 'c3BvbnNvcmVkLWJ5dGVz',
      sponsoredDigest: 'digest-sponsored',
      signatureExpiresAt: '2026-08-12T00:01:00.000Z',
      referenceQuoteId: QUOTE_ID,
      submissionQuoteId: 'quote-at-submission',
      enforcedWorstPrice: '0.5050',
    },
  }) as const;

const submitted = (executionId = EXECUTION_ID, status = 'SUBMITTED') =>
  ({ status: 200, body: { executionId, status, transactionDigest: 'digest-onchain' } }) as const;

const filled = (executionId = EXECUTION_ID) =>
  ({
    status: 200,
    body: {
      executionId,
      status: 'FILLED',
      transactionDigest: 'digest-onchain',
      fill: {
        filledShares: '100',
        filledCost: '50.00',
        averagePrice: '0.5000',
        feeAmount: null,
        settledAt: '2026-08-12T00:00:02.000Z',
      },
      remainingAllowance: '925.00',
    },
  }) as const;

const EXECUTIONS_PATH = '/agent-api/v1/predict/executions';
const submitPath = (executionId = EXECUTION_ID) => `POST ${EXECUTIONS_PATH}/${executionId}/submit`;

/** The intent every test starts from: a 50 wxUSD BUY with 1% protection. */
const BUY = {
  accountId: ACCOUNT_ID,
  marketId: MARKET_ID,
  outcomeId: 'YES',
  side: 'BUY',
  size: { buyAmount: '50' },
  maxSlippageBps: 100,
};

const input = (extra: Record<string, unknown> = {}) => JSON.stringify({ ...BUY, ...extra });

const READ_ROUTES = {
  'POST /agent-api/v1/auth': AUTH_OK,
  [`GET /agent-api/v1/predict/markets/${MARKET_ID}`]: MARKET_OK,
  'POST /agent-api/v1/predict/quotes': QUOTE_OK,
  [`GET /agent-api/v1/predict/accounts/${ACCOUNT_ID}/allowance`]: ALLOWANCE_OK,
};

const WRITE_ROUTES = {
  ...READ_ROUTES,
  [`POST ${EXECUTIONS_PATH}`]: created(),
  [submitPath()]: submitted(),
};

/** A policy file on disk, which is where a delegation belongs. */
const CONFIG_PATH = '/tmp/waterx-write-plane-config.json';
const withPolicy = (policy: unknown): { env: Record<string, string>; files: Record<string, string> } => ({
  env: { WATERX_PREDICT_CONFIG: CONFIG_PATH },
  files: {
    [CONFIG_PATH]: JSON.stringify({
      baseUrl: BASE_URL,
      agentWallet: AGENT_WALLET,
      signerCommand: '/opt/waterx/sign',
      policy,
    }),
  },
});

const SCOPE = {
  accounts: [ACCOUNT_ID],
  sides: ['BUY'],
  maxBuyAmount: '100',
  maxCumulativeBuyAmount: '150',
  maxSlippageBps: 200,
  maxLegs: 3,
  notAfter: '2026-08-13T00:00:00.000Z',
};

/** Requests the signer received, split by what was being signed. */
const signatures = (runs: readonly { input: string }[]) =>
  runs.map((run) => (JSON.parse(run.input) as { type: string }).type);

/** The token `order preview` publishes for exactly this intent. */
async function previewToken(extra: Record<string, unknown> = {}): Promise<string> {
  const result = await invoke(['order', 'preview', '--input', input(extra)], {
    env: CONFIGURED_ENV,
    routes: READ_ROUTES,
  });
  const data = result.envelope.data as { policy: { approvalToken: string } };
  return data.policy.approvalToken;
}

describe('an ambiguous intent stops before the write', () => {
  const cases: { name: string; body: Record<string, unknown> }[] = [
    { name: 'a BUY that names shares', body: { ...BUY, size: { sellShares: '10' } } },
    {
      name: 'a SELL that names a budget',
      body: { ...BUY, side: 'SELL', size: { buyAmount: '50' }, positionId: POSITION_ID },
    },
    { name: 'an order that names both units', body: { ...BUY, size: { buyAmount: '50', sellShares: '10' } } },
    { name: 'an order that names neither', body: { ...BUY, size: {} } },
    { name: 'a SELL with no position to close', body: { ...BUY, side: 'SELL', size: { sellShares: '10' } } },
    { name: 'a BUY that names a position', body: { ...BUY, positionId: POSITION_ID } },
  ];

  for (const testCase of cases) {
    it(`refuses ${testCase.name} without sending anything`, async () => {
      const result = await invoke(
        ['order', 'execute', '--input', JSON.stringify({ ...testCase.body, referenceQuoteId: QUOTE_ID })],
        { env: CONFIGURED_ENV, routes: WRITE_ROUTES },
      );

      expect(result.envelope.ok).toBe(false);
      expect(result.envelope.error?.code).toBe('INVALID_INPUT');
      expect(result.exit).toBe(EXIT_CODES.INVALID_INPUT);
      // The two assertions that matter: no unit was guessed, and nothing was
      // sent to find out.
      expect(result.fetches).toHaveLength(0);
      expect(result.signerRuns).toHaveLength(0);
    });
  }

  it('refuses an order with no quote to price it against', async () => {
    const { referenceQuoteId: _omitted, ...withoutQuote } = { ...BUY, referenceQuoteId: QUOTE_ID };
    const result = await invoke(['order', 'execute', '--input', JSON.stringify(withoutQuote)], {
      env: CONFIGURED_ENV,
      routes: WRITE_ROUTES,
    });

    expect(result.envelope.ok).toBe(false);
    expect(result.fetches).toHaveLength(0);
  });
});

describe('order preview', () => {
  it('resolves, prices and policy-checks without placing or signing an order', async () => {
    const result = await invoke(['order', 'preview', '--input', input()], {
      env: CONFIGURED_ENV,
      routes: READ_ROUTES,
    });
    const data = result.envelope.data as {
      placed: boolean;
      market: { marketId: string; outcome: { resolved: boolean } };
      quote: { quoteId: string; availableSize: null };
      priceProtection: { estimate: { bound: string; effective: string; binding: string } };
      policy: { decision: string; approvalToken: string; approveWith: string };
      riskLimits: { available: boolean; tracking: string };
    };

    expect(result.exit).toBe(EXIT_CODES.OK);
    expect(data.placed).toBe(false);
    expect(data.market.marketId).toBe(MARKET_ID);
    expect(data.market.outcome.resolved).toBe(true);
    expect(data.quote.quoteId).toBe(QUOTE_ID);
    // 0.50 × (1 + 100bps) = 0.505, and a BUY bound is a ceiling.
    expect(data.priceProtection.estimate.bound).toBe('CEILING');
    expect(data.priceProtection.estimate.effective).toBe('0.505');
    expect(data.priceProtection.estimate.binding).toBe('SLIPPAGE');
    expect(data.policy.decision).toBe('APPROVAL_REQUIRED');
    expect(data.policy.approveWith).toBe(`--approve ${data.policy.approvalToken}`);
    // Risk limits are owner-authenticated: reported as unavailable, never guessed.
    expect(data.riskLimits.available).toBe(false);
    expect(data.riskLimits.tracking).toBe('B1');

    // No execution was created and the only signature was the login challenge.
    expect(result.fetches.some((call) => call.url.endsWith('/executions'))).toBe(false);
    expect(signatures(result.signerRuns)).toEqual(['PERSONAL_MESSAGE']);
  });

  it('binds its token to the exact intent, so it cannot be carried onto another', async () => {
    const fifty = await previewToken();
    const hundred = await previewToken({ size: { buyAmount: '100' } });
    const looser = await previewToken({ maxSlippageBps: 300 });

    expect(fifty).not.toBe(hundred);
    expect(fifty).not.toBe(looser);
    // Reproducible: the same intent previews to the same token every time.
    expect(await previewToken()).toBe(fifty);
  });

  it('still answers under a read-only policy, and reports the refusal instead of throwing', async () => {
    const result = await invoke(['order', 'preview', '--policy', 'read-only', '--input', input()], {
      env: CONFIGURED_ENV,
      routes: READ_ROUTES,
    });
    const data = result.envelope.data as { policy: { decision: string; reason: string } };

    expect(result.envelope.ok).toBe(true);
    expect(data.policy.decision).toBe('DENIED');
    expect(data.policy.reason).toBe('READ_ONLY');
    // Read-only reads. It does not read the allowance for a write it will refuse.
    expect(result.fetches.some((call) => call.url.endsWith('/allowance'))).toBe(false);
  });

  it('reports a delegated-auto order as allowed by scope, naming what was checked', async () => {
    const result = await invoke(
      ['order', 'preview', '--input', input()],
      { ...withPolicy({ mode: 'delegated-auto', scope: SCOPE }), routes: READ_ROUTES },
    );
    const data = result.envelope.data as { policy: { decision: string; scopeChecks: string[] } };

    expect(data.policy.decision).toBe('ALLOWED_BY_SCOPE');
    expect(data.policy.scopeChecks.join(' ')).toMatch(/effectiveBuyCapacity/u);
  });
});

describe('order execute under the interactive policy', () => {
  it('refuses without an approval, before anything is created or signed', async () => {
    const result = await invoke(
      ['order', 'execute', '--input', input({ referenceQuoteId: QUOTE_ID })],
      { env: CONFIGURED_ENV, routes: WRITE_ROUTES },
    );

    expect(result.envelope.error?.code).toBe('POLICY_DENIED');
    expect(result.exit).toBe(EXIT_CODES.POLICY);
    // The message carries the token that WOULD authorize it, so the caller has
    // somewhere to go without a second round trip.
    expect(result.envelope.error?.message).toMatch(/--approve apv1_/u);
    expect(result.fetches.some((call) => call.url.endsWith('/executions'))).toBe(false);
    expect(signatures(result.signerRuns)).not.toContain('TRANSACTION');
  });

  it('refuses an approval that names a different order', async () => {
    const otherIntent = await previewToken({ size: { buyAmount: '100' } });
    const result = await invoke(
      ['order', 'execute', '--approve', otherIntent, '--input', input({ referenceQuoteId: QUOTE_ID })],
      { env: CONFIGURED_ENV, routes: WRITE_ROUTES },
    );

    expect(result.envelope.error?.code).toBe('POLICY_DENIED');
    expect(result.envelope.error?.message).toMatch(/does not match this intent/u);
    expect(result.fetches.some((call) => call.url.endsWith('/executions'))).toBe(false);
  });

  it('places the order the approval names, and signs exactly one transaction', async () => {
    const token = await previewToken();
    const result = await invoke(
      [
        'order',
        'execute',
        '--approve',
        token,
        '--input',
        input({ referenceQuoteId: QUOTE_ID, idempotencyKey: 'idem-1' }),
      ],
      { env: CONFIGURED_ENV, routes: WRITE_ROUTES },
    );
    const data = result.envelope.data as {
      placed: boolean;
      executionId: string;
      idempotencyKey: string;
      execution: { status: string; enforcedWorstPrice: string; terminal: boolean };
      policy: { basis: string; signatures: { granted: number; used: number } };
    };

    expect(result.exit).toBe(EXIT_CODES.OK);
    expect(data.placed).toBe(true);
    expect(data.executionId).toBe(EXECUTION_ID);
    expect(data.idempotencyKey).toBe('idem-1');
    // SUBMITTED is not a fill, and the result must not round it up to one.
    expect(data.execution.status).toBe('SUBMITTED');
    expect(data.execution.terminal).toBe(false);
    expect(data.execution.enforcedWorstPrice).toBe('0.5050');
    expect(data.policy.basis).toBe('INTERACTIVE_APPROVAL');
    // One approved order buys exactly one signature, and it was spent.
    expect(data.policy.signatures).toMatchObject({ granted: 1, used: 1 });
    expect(signatures(result.signerRuns)).toEqual(['PERSONAL_MESSAGE', 'TRANSACTION']);

    const create = result.fetches.find((call) => call.url.endsWith('/executions'));
    expect(create?.body).toMatchObject({
      accountId: ACCOUNT_ID,
      marketId: MARKET_ID,
      side: 'BUY',
      size: { buyAmount: '50' },
      referenceQuoteId: QUOTE_ID,
      maxSlippageBps: 100,
    });
    // The key travels in the header, never in the body.
    expect(create?.body).not.toHaveProperty('idempotencyKey');
  });

  it('refuses outright under read-only, without minting a quote or reaching the API', async () => {
    const token = await previewToken();
    const result = await invoke(
      [
        'order',
        'execute',
        '--policy',
        'read-only',
        '--approve',
        token,
        '--input',
        input({ referenceQuoteId: QUOTE_ID }),
      ],
      { env: CONFIGURED_ENV, routes: WRITE_ROUTES },
    );

    expect(result.envelope.error?.code).toBe('POLICY_DENIED');
    expect(result.envelope.error?.details).toMatchObject({ policy: 'read-only' });
    expect(result.exit).toBe(EXIT_CODES.POLICY);
    // Not one request, not one signature: the refusal is local and total.
    expect(result.fetches).toHaveLength(0);
    expect(result.signerRuns).toHaveLength(0);
  });
});

describe('--policy may only narrow', () => {
  it('refuses to widen an interactive configuration to delegated-auto', async () => {
    const result = await invoke(
      ['order', 'execute', '--policy', 'delegated-auto', '--input', input({ referenceQuoteId: QUOTE_ID })],
      { env: CONFIGURED_ENV, routes: WRITE_ROUTES },
    );

    expect(result.envelope.error?.code).toBe('CONFIG_INVALID');
    expect(result.envelope.error?.message).toMatch(/may only narrow/u);
    expect(result.fetches).toHaveLength(0);
  });

  it('lets a delegated-auto machine be narrowed to read-only for one invocation', async () => {
    const result = await invoke(
      ['order', 'execute', '--policy', 'read-only', '--input', input({ referenceQuoteId: QUOTE_ID })],
      { ...withPolicy({ mode: 'delegated-auto', scope: SCOPE }), routes: WRITE_ROUTES },
    );

    expect(result.envelope.error?.code).toBe('POLICY_DENIED');
    expect(result.fetches).toHaveLength(0);
  });

  it('refuses a delegated-auto configuration that states no scope', async () => {
    const result = await invoke(['describe'], withPolicy({ mode: 'delegated-auto' }));

    expect(result.envelope.error?.code).toBe('CONFIG_INVALID');
    expect(result.envelope.error?.message).toMatch(/authorizes nothing/u);
  });
});

describe('order execute under a delegated-auto scope', () => {
  const delegated = (extra: Record<string, unknown> = {}, scope: unknown = SCOPE) => ({
    ...withPolicy({ mode: 'delegated-auto', scope }),
    routes: { ...WRITE_ROUTES, ...(extra.routes as object | undefined) },
  });

  it('places an in-scope order with no per-order approval', async () => {
    const result = await invoke(
      ['order', 'execute', '--input', input({ referenceQuoteId: QUOTE_ID })],
      delegated(),
    );
    const data = result.envelope.data as { policy: { basis: string; scopeChecks: string[] } };

    expect(result.exit).toBe(EXIT_CODES.OK);
    expect(data.policy.basis).toBe('DELEGATED_AUTO');
    expect(data.policy.scopeChecks.length).toBeGreaterThan(0);
    expect(signatures(result.signerRuns)).toEqual(['PERSONAL_MESSAGE', 'TRANSACTION']);
    // Every delegated-auto result carries the warning, because an unattended
    // write policy is the setting an operator must never discover from a trade
    // confirmation.
    expect(result.envelope.meta?.warnings?.join(' ')).toMatch(/delegated-auto/u);
  });

  it('refuses an order over the per-order ceiling', async () => {
    const result = await invoke(
      ['order', 'execute', '--input', input({ referenceQuoteId: QUOTE_ID, size: { buyAmount: '120' } })],
      delegated(),
    );

    expect(result.envelope.error?.code).toBe('POLICY_DENIED');
    expect(result.envelope.error?.details).toMatchObject({
      violation: 'the order budget exceeds the per-order ceiling',
      maxBuyAmount: '100',
    });
    expect(result.fetches.some((call) => call.url.endsWith('/executions'))).toBe(false);
  });

  it('refuses an order for an account the scope does not name', async () => {
    const stranger = `0x${'f'.repeat(63)}9`;
    const result = await invoke(
      ['order', 'execute', '--input', input({ referenceQuoteId: QUOTE_ID, accountId: stranger })],
      delegated(),
    );

    expect(result.envelope.error?.details).toMatchObject({
      violation: 'the account is not in the scope',
    });
    // Nothing was read either: the allowance of an account this delegation does
    // not name is none of this invocation's business.
    expect(result.fetches.some((call) => call.url.includes('/allowance'))).toBe(false);
  });

  it('refuses a SELL when the scope allows only BUY', async () => {
    const result = await invoke(
      [
        'order',
        'execute',
        '--input',
        input({
          referenceQuoteId: QUOTE_ID,
          side: 'SELL',
          size: { sellShares: '10' },
          positionId: POSITION_ID,
        }),
      ],
      delegated(),
    );

    expect(result.envelope.error?.details).toMatchObject({ violation: 'the SELL side is not in the scope' });
  });

  it('refuses a slippage budget looser than the scope allows', async () => {
    const result = await invoke(
      ['order', 'execute', '--input', input({ referenceQuoteId: QUOTE_ID, maxSlippageBps: 900 })],
      delegated(),
    );

    expect(result.envelope.error?.details).toMatchObject({
      violation: 'the slippage budget exceeds the scope',
    });
  });

  it('refuses once the delegation window has closed', async () => {
    const result = await invoke(
      ['order', 'execute', '--input', input({ referenceQuoteId: QUOTE_ID })],
      delegated({}, { ...SCOPE, notAfter: '2026-08-11T00:00:00.000Z' }),
    );

    expect(result.envelope.error?.details).toMatchObject({
      violation: 'the delegation window has closed',
    });
    expect(result.fetches.some((call) => call.url.endsWith('/executions'))).toBe(false);
  });

  it('refuses a locally-allowed order the server has no capacity for', async () => {
    // The scope permits 100. The exchange says 30 is spendable. Local policy
    // narrows the server's limits; it can never widen them.
    const result = await invoke(['order', 'execute', '--input', input({ referenceQuoteId: QUOTE_ID })], {
      ...withPolicy({ mode: 'delegated-auto', scope: SCOPE }),
      routes: {
        ...WRITE_ROUTES,
        [`GET /agent-api/v1/predict/accounts/${ACCOUNT_ID}/allowance`]: {
          status: 200,
          body: {
            apiAllowance: { limit: '1000.00', reserved: '0.00', deployed: '970.00', available: '30.00' },
            accountSpendableBalance: '30.00',
            effectiveBuyCapacity: '30.00',
          },
        },
      },
    });

    expect(result.envelope.error?.code).toBe('POLICY_DENIED');
    expect(result.envelope.error?.details).toMatchObject({
      violation: 'the combined budget exceeds the account’s effective buy capacity',
      effectiveBuyCapacity: '30.00',
    });
    expect(result.fetches.some((call) => call.url.endsWith('/executions'))).toBe(false);
  });
});

describe('a wait that runs out is ambiguous, not failed', () => {
  it('exits AMBIGUOUS, keeps the execution id, and says never to resubmit', async () => {
    const token = await previewToken();
    const result = await invoke(
      [
        'order',
        'execute',
        '--approve',
        token,
        '--input',
        input({ referenceQuoteId: QUOTE_ID, waitFor: 'TERMINAL', timeoutMs: 1_000 }),
      ],
      {
        env: CONFIGURED_ENV,
        routes: {
          ...WRITE_ROUTES,
          // Never reaches a terminal status, which is precisely the case a
          // caller must not mistake for a failure.
          [`GET ${EXECUTIONS_PATH}/${EXECUTION_ID}`]: submitted(EXECUTION_ID, 'PENDING_FILL'),
        },
      },
    );
    const data = result.envelope.data as {
      executionId: string;
      execution: { timedOut: boolean; terminal: boolean; status: string };
      reconciliation: { reason: string; command: string; neverDo: string };
    };

    // ok, because these are facts. Non-zero, because it is not done.
    expect(result.envelope.ok).toBe(true);
    expect(result.exit).toBe(EXIT_CODES.AMBIGUOUS);
    expect(data.execution.timedOut).toBe(true);
    expect(data.execution.terminal).toBe(false);
    expect(data.executionId).toBe(EXECUTION_ID);
    expect(data.reconciliation.reason).toBe('WAIT_TIMED_OUT');
    expect(data.reconciliation.command).toContain(EXECUTION_ID);
    expect(data.reconciliation.neverDo).toMatch(/second order/u);
    // Exactly one execution was created. A timeout must never resubmit.
    expect(result.fetches.filter((call) => call.url.endsWith('/executions'))).toHaveLength(1);
    expect(signatures(result.signerRuns).filter((type) => type === 'TRANSACTION')).toHaveLength(1);
  }, 15_000);
});

describe('order get and order reconcile', () => {
  it('reads one execution and reports the authoritative terminal facts', async () => {
    const result = await invoke(['order', 'get', '--executionId', EXECUTION_ID], {
      env: CONFIGURED_ENV,
      routes: { 'POST /agent-api/v1/auth': AUTH_OK, [`GET ${EXECUTIONS_PATH}/${EXECUTION_ID}`]: filled() },
    });
    const data = result.envelope.data as {
      execution: {
        terminal: boolean;
        status: string;
        fill: { filledShares: string } | null;
        remainingAllowance: string | null;
      };
    };

    expect(result.exit).toBe(EXIT_CODES.OK);
    expect(data.execution.terminal).toBe(true);
    expect(data.execution.status).toBe('FILLED');
    expect(data.execution.fill?.filledShares).toBe('100');
    expect(data.execution.remainingAllowance).toBe('925.00');
    // A read signs nothing but the session challenge.
    expect(signatures(result.signerRuns)).toEqual(['PERSONAL_MESSAGE']);
  });

  it('resolves an ambiguous outcome without placing or cancelling anything', async () => {
    const result = await invoke(['order', 'reconcile', '--executionId', EXECUTION_ID], {
      env: CONFIGURED_ENV,
      routes: { 'POST /agent-api/v1/auth': AUTH_OK, [`GET ${EXECUTIONS_PATH}/${EXECUTION_ID}`]: filled() },
    });
    const data = result.envelope.data as { resolved: boolean; execution: { terminal: boolean } };

    expect(result.exit).toBe(EXIT_CODES.OK);
    expect(data.resolved).toBe(true);
    expect(data.execution.terminal).toBe(true);
    expect(result.fetches.some((call) => call.method === 'POST' && call.url.endsWith('/executions'))).toBe(
      false,
    );
    expect(signatures(result.signerRuns)).not.toContain('TRANSACTION');
  });

  it('reports its own timeout as unresolved rather than as an error', async () => {
    const result = await invoke(
      ['order', 'reconcile', '--executionId', EXECUTION_ID, '--timeoutMs', '1000'],
      {
        env: CONFIGURED_ENV,
        routes: {
          'POST /agent-api/v1/auth': AUTH_OK,
          [`GET ${EXECUTIONS_PATH}/${EXECUTION_ID}`]: submitted(EXECUTION_ID, 'PENDING_FILL'),
        },
      },
    );
    const data = result.envelope.data as { resolved: boolean; reconciliation: { reason: string } };

    expect(result.envelope.ok).toBe(true);
    expect(result.exit).toBe(EXIT_CODES.AMBIGUOUS);
    expect(data.resolved).toBe(false);
    expect(data.reconciliation.reason).toBe('WAIT_TIMED_OUT');
  }, 15_000);
});

describe('order execute-many is never atomic', () => {
  const SECOND_MARKET = `0x${'e'.repeat(63)}5`;
  const legs = (overrides: Record<string, unknown>[] = [{}, {}]) =>
    overrides.map((override, index) => ({
      ...BUY,
      size: { buyAmount: index === 0 ? '10' : '20' },
      referenceQuoteId: QUOTE_ID,
      idempotencyKey: `idem-${String(index)}`,
      ...override,
    }));

  it('reports each leg independently when one of them fails', async () => {
    const result = await invoke(
      [
        'order',
        'execute-many',
        '--input',
        JSON.stringify({ orders: legs([{}, { marketId: SECOND_MARKET }]), failurePolicy: 'CONTINUE' }),
      ],
      {
        ...withPolicy({
          mode: 'delegated-auto',
          scope: { ...SCOPE, markets: [MARKET_ID, SECOND_MARKET] },
        }),
        routes: {
          ...READ_ROUTES,
          [`POST ${EXECUTIONS_PATH}`]: created(),
          [submitPath()]: submitted(),
        },
      },
    );
    const data = result.envelope.data as {
      atomic: boolean;
      legs: number;
      summary: { succeeded: number; failed: number; skipped: number };
      results: { index: number; status: string; executionId?: string }[];
    };

    expect(data.atomic).toBe(false);
    expect(data.legs).toBe(2);
    // Both legs hit the same stubbed routes, so both succeed — the point of this
    // assertion is that each carries its OWN execution and result row.
    expect(data.summary).toMatchObject({ succeeded: 2, failed: 0, skipped: 0 });
    expect(data.results.map((leg) => leg.index)).toEqual([0, 1]);
    expect(result.fetches.filter((call) => call.method === 'POST' && call.url.endsWith('/executions')))
      .toHaveLength(2);
    // One permit per approved leg, both spent, none left over.
    const policy = (result.envelope.data as { policy: { signatures: unknown } }).policy;
    expect(policy.signatures).toMatchObject({ granted: 2, used: 2, unused: 0 });
  });

  it('carries a failed leg’s exit class, and marks an unlaunched leg SKIPPED', async () => {
    const result = await invoke(
      ['order', 'execute-many', '--input', JSON.stringify({ orders: legs(), failurePolicy: 'STOP' })],
      {
        ...withPolicy({ mode: 'delegated-auto', scope: SCOPE }),
        routes: {
          ...READ_ROUTES,
          [`POST ${EXECUTIONS_PATH}`]: {
            status: 422,
            body: {
              error: {
                code: 'QUOTE_EXPIRED',
                message: 'the reference quote has expired; re-quote and retry',
                retryable: false,
              },
            },
          },
        },
      },
    );
    const data = result.envelope.data as {
      summary: { succeeded: number; failed: number; skipped: number };
      results: { index: number; status: string; error?: { code: string }; detail?: string }[];
    };

    // Still `ok`: the batch ran and every leg has an answer. The exit code is
    // the failing leg's own class — QUOTE_EXPIRED is UNAVAILABLE, not a generic
    // rejection — so a caller's retry logic does not have to branch on how the
    // order happened to be submitted.
    expect(result.envelope.ok).toBe(true);
    expect(result.exit).toBe(EXIT_CODES.UNAVAILABLE);
    expect(data.summary).toMatchObject({ succeeded: 0, failed: 1, skipped: 1 });
    expect(data.results[0]).toMatchObject({
      status: 'FAILED',
      error: { code: 'QUOTE_EXPIRED', source: 'SERVER', retryable: false },
    });
    expect(data.results[1]?.status).toBe('SKIPPED');
    expect(data.results[1]?.detail).toMatch(/safe to resubmit/u);
  });

  it('refuses the whole batch when one leg is out of scope, before any leg runs', async () => {
    const result = await invoke(
      [
        'order',
        'execute-many',
        '--input',
        JSON.stringify({ orders: legs([{}, { size: { buyAmount: '500' } }]) }),
      ],
      { ...withPolicy({ mode: 'delegated-auto', scope: SCOPE }), routes: WRITE_ROUTES },
    );

    expect(result.envelope.error?.code).toBe('POLICY_DENIED');
    expect(result.exit).toBe(EXIT_CODES.POLICY);
    // Not one leg was placed. A batch authorized leg-by-leg would have traded
    // the first one before discovering the second was refused.
    expect(result.fetches.some((call) => call.method === 'POST' && call.url.endsWith('/executions'))).toBe(
      false,
    );
    expect(signatures(result.signerRuns)).not.toContain('TRANSACTION');
  });

  it('sums the legs against the cumulative ceiling, not just each against its own', async () => {
    const result = await invoke(
      [
        'order',
        'execute-many',
        '--input',
        JSON.stringify({
          orders: legs([{ size: { buyAmount: '90' } }, { size: { buyAmount: '90' } }]),
        }),
      ],
      { ...withPolicy({ mode: 'delegated-auto', scope: SCOPE }), routes: WRITE_ROUTES },
    );

    // Each leg is inside the 100 per-order ceiling; together they exceed 150.
    expect(result.envelope.error?.details).toMatchObject({
      violation: 'the combined budget exceeds the cumulative ceiling',
      cumulativeBuyAmount: '180',
    });
  });
});

describe('the write plane keeps its secrets', () => {
  it('prints no session token and no signature on either stream', async () => {
    const token = await previewToken();
    const result = await invoke(
      ['order', 'execute', '--approve', token, '--input', input({ referenceQuoteId: QUOTE_ID })],
      { env: CONFIGURED_ENV, routes: WRITE_ROUTES },
    );

    expect(result.envelope.ok).toBe(true);
    for (const stream of [result.stdout, result.stderr]) {
      expect(stream).not.toContain('session-token-that-must-never-be-printed');
      expect(stream).not.toContain('fake-personal-message-signature');
      expect(stream).not.toContain('c3BvbnNvcmVkLWJ5dGVz');
    }
    expect(result.writes).toBe(1);
  });
});
