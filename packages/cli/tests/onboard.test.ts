/**
 * `onboard` and `account list` — the path a person walks before an agent trades.
 *
 * What is protected here is not a data shape. It is that the CLI sends the right
 * person to do the right thing: an owner asked to re-sign a delegation they
 * already signed concludes the product is broken, and an operator told "not
 * authorized" when an RPC blipped tears down a working strategy. And that the
 * link this prints stays a link — never a credential, never a pre-authorization.
 */
import { describe, expect, it } from 'vitest';

import { EXIT_CODES } from '../src/index.ts';
import { AGENT_WALLET, AUTH_OK, ACCOUNT_ID, CONFIGURED_ENV, invoke } from './harness.ts';

const ACCOUNTS_PATH = 'GET /agent-api/v1/predict/accounts';

/** The console the harness's base URL is NOT paired with, so it must be given. */
const CONSOLE_ENV = { ...CONFIGURED_ENV, WATERX_PREDICT_CONSOLE_URL: 'https://console.test.invalid' };

const listing = (...accounts: unknown[]) => ({ status: 200, body: { accounts } });

const account = (overrides: Record<string, unknown> = {}) => ({
  accountId: ACCOUNT_ID,
  ownerAddress: `0x${'e'.repeat(63)}4`,
  isSuspended: false,
  policyVersion: 2,
  delegation: { mayPlaceOrder: true, mayRequestClose: true, checkedAt: '2026-08-01T00:00:00.000Z' },
  grantedAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-02T00:00:00.000Z',
  ...overrides,
});

describe('onboard', () => {
  it('prints a link that names the agent and authorizes nothing', async () => {
    const result = await invoke(['onboard', '--label', 'momentum-bot'], {
      env: CONSOLE_ENV,
      routes: { 'POST /agent-api/v1/auth': AUTH_OK, [ACCOUNTS_PATH]: listing() },
    });

    const data = result.envelope.data as { authorizationUrl: string; status: string };
    const url = new URL(data.authorizationUrl);
    expect(url.origin).toBe('https://console.test.invalid');
    expect(url.pathname).toBe('/agent/authorize');
    expect(url.searchParams.get('agent')).toBe(AGENT_WALLET);
    // Nothing else may ride along. A token here would turn a link someone pastes
    // into a chat into a bearer credential.
    expect([...url.searchParams.keys()].sort()).toEqual(['agent', 'label']);
    // The human-facing copy goes to stderr; stdout stays one parseable document.
    expect(result.writes).toBe(1);
    expect(result.stderr).toContain(data.authorizationUrl);
  });

  it('reports NOT_ONBOARDED and points at the OWNER', async () => {
    const result = await invoke(['onboard'], {
      env: CONSOLE_ENV,
      routes: { 'POST /agent-api/v1/auth': AUTH_OK, [ACCOUNTS_PATH]: listing() },
    });

    const data = result.envelope.data as {
      status: string;
      ready: boolean;
      nextStep: { actor: string };
    };
    expect(result.exit).toBe(EXIT_CODES.OK);
    expect(data.status).toBe('NOT_ONBOARDED');
    expect(data.ready).toBe(false);
    // An operator cannot fix this by retrying, and saying so is the difference
    // between a 30-second onboarding and a support ticket.
    expect(data.nextStep.actor).toBe('ACCOUNT_OWNER');
  });

  it('hands back the account id nobody had to copy', async () => {
    const result = await invoke(['onboard'], {
      env: CONSOLE_ENV,
      routes: { 'POST /agent-api/v1/auth': AUTH_OK, [ACCOUNTS_PATH]: listing(account()) },
    });

    const data = result.envelope.data as { status: string; accountId: string; ready: boolean };
    expect(data.status).toBe('READY');
    expect(data.ready).toBe(true);
    expect(data.accountId).toBe(ACCOUNT_ID);
  });

  it('does not send the owner to re-sign when the CHAIN READ failed', async () => {
    const result = await invoke(['onboard'], {
      env: CONSOLE_ENV,
      routes: {
        'POST /agent-api/v1/auth': AUTH_OK,
        [ACCOUNTS_PATH]: listing(
          account({
            delegation: { mayPlaceOrder: null, mayRequestClose: null, checkedAt: 'x' },
          }),
        ),
      },
    });

    const data = result.envelope.data as { status: string; nextStep: { actor: string } };
    expect(data.status).toBe('DELEGATION_UNKNOWN');
    expect(data.nextStep.actor).toBe('AGENT_OPERATOR');
  });

  it('refuses to choose between two authorized accounts', async () => {
    const result = await invoke(['onboard'], {
      env: CONSOLE_ENV,
      routes: {
        'POST /agent-api/v1/auth': AUTH_OK,
        [ACCOUNTS_PATH]: listing(account(), account({ accountId: `0x${'f'.repeat(63)}5` })),
      },
    });

    const data = result.envelope.data as { status: string; accountId: string | null };
    expect(data.status).toBe('AMBIGUOUS');
    expect(data.accountId).toBeNull();
  });

  it('refuses before any network when no console is paired with the API', async () => {
    const result = await invoke(['onboard'], {
      env: CONFIGURED_ENV,
      routes: { 'POST /agent-api/v1/auth': AUTH_OK, [ACCOUNTS_PATH]: listing() },
    });

    expect(result.envelope.ok).toBe(false);
    expect(result.envelope.error?.code).toBe('NOT_CONFIGURED');
    // A guessed hostname would send an owner to a page that cannot grant
    // anything, so nothing is attempted at all.
    expect(result.fetches).toHaveLength(0);
  });

  it('refuses when there is no agent wallet for an owner to authorize', async () => {
    const withoutWallet: Record<string, string | undefined> = {
      ...CONSOLE_ENV,
      WATERX_PREDICT_AGENT_WALLET: undefined,
    };

    const result = await invoke(['onboard'], {
      env: withoutWallet,
      routes: { 'POST /agent-api/v1/auth': AUTH_OK, [ACCOUNTS_PATH]: listing() },
    });

    expect(result.envelope.error?.code).toBe('NOT_CONFIGURED');
    expect(result.fetches).toHaveLength(0);
  });
});

describe('account list', () => {
  it('reads the accounts without being given an account id', async () => {
    const result = await invoke(['account', 'list'], {
      env: CONFIGURED_ENV,
      routes: { 'POST /agent-api/v1/auth': AUTH_OK, [ACCOUNTS_PATH]: listing(account()) },
    });

    const data = result.envelope.data as { accounts: unknown[]; count: number };
    expect(result.exit).toBe(EXIT_CODES.OK);
    expect(data.count).toBe(1);
    // The whole point: the id an agent could not discover arrives from the server.
    expect(result.fetches.some((call) => call.url.endsWith('/predict/accounts'))).toBe(true);
  });

  it('passes a null delegation through instead of reading it as a denial', async () => {
    const result = await invoke(['account', 'list'], {
      env: CONFIGURED_ENV,
      routes: {
        'POST /agent-api/v1/auth': AUTH_OK,
        [ACCOUNTS_PATH]: listing(
          account({ delegation: { mayPlaceOrder: null, mayRequestClose: null, checkedAt: 'x' } }),
        ),
      },
    });

    const data = result.envelope.data as {
      accounts: { delegation: { mayPlaceOrder: boolean | null } }[];
    };
    expect(data.accounts[0]?.delegation.mayPlaceOrder).toBeNull();
  });

  it('reports an empty list as an answer, not an error', async () => {
    const result = await invoke(['account', 'list'], {
      env: CONFIGURED_ENV,
      routes: { 'POST /agent-api/v1/auth': AUTH_OK, [ACCOUNTS_PATH]: listing() },
    });

    expect(result.envelope.ok).toBe(true);
    expect((result.envelope.data as { count: number }).count).toBe(0);
  });
});
