/**
 * `doctor`, and the discipline of SKIP.
 *
 * The failure mode this guards against is a green report on a broken machine:
 * checks that never ran being counted as passes, so an operator concludes the
 * setup is fine and the first thing that actually breaks is a trade. A check
 * that could not run says so, and a failing report fails the command.
 */
import { describe, expect, it } from 'vitest';

import { EXIT_CODES } from '../src/index.ts';
import { ACCOUNT_ID, ALLOWANCE_OK, AUTH_OK, CONFIGURED_ENV, invoke } from './harness.ts';

interface Requirement {
  id: string;
  state: 'SATISFIED' | 'MISSING' | 'UNCHECKED';
  suppliedBy: string;
  evidence: string;
  ownerAuthenticated: boolean;
}

interface Report {
  checks: { id: string; status: string; code?: string; summary: string }[];
  failed: number;
  skipped: number;
  requirements: Requirement[];
  missing: Requirement[];
  unchecked: Requirement[];
  nextStep: { actor: string; action: string };
  checkedAt: string;
}

const MARKETS_OK = { status: 200, body: { markets: [{ marketId: 'm1' }] } } as const;

const ACCOUNTS_PATH = 'GET /agent-api/v1/predict/accounts';

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

const listing = (...accounts: unknown[]) => ({ status: 200, body: { accounts } });

/** The routes a fully working, fully authorized setup answers. */
const WORKING = {
  'POST /agent-api/v1/auth': AUTH_OK,
  'GET /agent-api/v1/predict/markets': MARKETS_OK,
  [`GET /agent-api/v1/predict/accounts/${ACCOUNT_ID}/allowance`]: ALLOWANCE_OK,
  [ACCOUNTS_PATH]: listing(account()),
} as const;

const statusOf = (report: Report, id: string): string | undefined =>
  report.checks.find((check) => check.id === id)?.status;

const stateOf = (report: Report, id: string): string | undefined =>
  report.requirements.find((requirement) => requirement.id === id)?.state;

describe('doctor', () => {
  it('passes every check on a working setup, and skips only what does not apply', async () => {
    const result = await invoke(['doctor', '--accountId', ACCOUNT_ID], {
      env: CONFIGURED_ENV,
      routes: {
        'POST /agent-api/v1/auth': AUTH_OK,
        'GET /agent-api/v1/predict/markets': MARKETS_OK,
        [`GET /agent-api/v1/predict/accounts/${ACCOUNT_ID}/allowance`]: ALLOWANCE_OK,
      },
    });
    const report = result.envelope.data as Report;

    expect(result.exit).toBe(EXIT_CODES.OK);
    expect(report.failed).toBe(0);
    expect(statusOf(report, 'config')).toBe('PASS');
    expect(statusOf(report, 'signer')).toBe('PASS');
    expect(statusOf(report, 'authentication')).toBe('PASS');
    expect(statusOf(report, 'market-catalog')).toBe('PASS');
    expect(statusOf(report, 'account-allowance')).toBe('PASS');
    // Truthful: this build signs no transactions, so there is no write path to check.
    expect(statusOf(report, 'write-plane')).toBe('SKIP');
  });

  it('skips the network checks rather than failing them when nothing is configured', async () => {
    const result = await invoke(['doctor']);
    const report = result.envelope.data as Report | undefined;
    const details = (result.envelope.error?.details as { report: Report }).report;
    const actual = report ?? details;

    expect(result.envelope.ok).toBe(false);
    expect(statusOf(actual, 'config')).toBe('FAIL');
    expect(statusOf(actual, 'api-reachable')).toBe('SKIP');
    expect(statusOf(actual, 'authentication')).toBe('SKIP');
    expect(result.fetches).toHaveLength(0);
  });

  it('fails the command when a check fails, instead of hiding it in a green exit', async () => {
    const result = await invoke(['doctor']);

    expect(result.exit).not.toBe(EXIT_CODES.OK);
    expect(result.exit).toBe(EXIT_CODES.CONFIG);
    expect(result.envelope.error?.code).toBe('NOT_CONFIGURED');
  });

  it('reports the failing check’s own code, so the exit code matches the real cause', async () => {
    const result = await invoke(['doctor'], {
      env: CONFIGURED_ENV,
      routes: {
        'POST /agent-api/v1/auth': {
          status: 401,
          body: {
            error: { code: 'SIGNATURE_INVALID', message: 'bad signature', retryable: false },
          },
        },
      },
    });
    const report = (result.envelope.error?.details as { report: Report }).report;

    expect(result.envelope.error?.code).toBe('SIGNATURE_INVALID');
    expect(result.envelope.error?.source).toBe('SERVER');
    // Exit 4 is what an ordinary command would have exited with. Not 70.
    expect(result.exit).toBe(EXIT_CODES.AUTH);
    // The host answered, so reachability passed even though authentication did not.
    expect(statusOf(report, 'api-reachable')).toBe('PASS');
    expect(statusOf(report, 'authentication')).toBe('FAIL');
    expect(statusOf(report, 'market-catalog')).toBe('SKIP');
  });

  it('says why the allowance check did not run when no account is known', async () => {
    const result = await invoke(['doctor'], {
      env: CONFIGURED_ENV,
      routes: {
        'POST /agent-api/v1/auth': AUTH_OK,
        'GET /agent-api/v1/predict/markets': MARKETS_OK,
      },
    });
    const report = result.envelope.data as Report;

    expect(statusOf(report, 'account-allowance')).toBe('SKIP');
    // It points at another check rather than at a flag. The account id is
    // something the server answers for, so a person who has not named one is not
    // missing a setting — and telling them to pass `--accountId` would put back
    // the 66-character copy-paste the onboarding work removed.
    const summary = report.checks.find((check) => check.id === 'account-allowance')?.summary ?? '';
    expect(summary).not.toMatch(/--accountId/u);
    const referenced = summary.match(/`([a-z-]+)`/u)?.[1];
    expect(report.checks.map((check) => check.id)).toContain(referenced);
    expect(result.exit).toBe(EXIT_CODES.OK);
  });

  it('resolves the account nobody named, from what the owner granted', async () => {
    // The id is not configuration. Asking for it was the friction removed by
    // `listAuthorizedAccounts`, and a `doctor` that demanded one would be the
    // last place still asking.
    const result = await invoke(['doctor'], { env: CONFIGURED_ENV, routes: WORKING });
    const report = result.envelope.data as Report;

    expect(statusOf(report, 'account-identity')).toBe('PASS');
    expect(statusOf(report, 'account-allowance')).toBe('PASS');
    expect(
      report.checks.find((check) => check.id === 'account-identity')?.summary,
    ).toContain('no id supplied');
  });

  it('refuses to pick when more than one account is ready', async () => {
    // Choosing between two authorized accounts is choosing whose money trades.
    const second = `0x${'b2'.repeat(32)}`;
    const result = await invoke(['doctor'], {
      env: CONFIGURED_ENV,
      routes: { ...WORKING, [ACCOUNTS_PATH]: listing(account(), account({ accountId: second })) },
    });
    const report = (result.envelope.data ??
      (result.envelope.error?.details as { report: Report }).report) as Report;

    expect(statusOf(report, 'account-identity')).toBe('FAIL');
    expect(statusOf(report, 'account-allowance')).toBe('SKIP');
  });

  it('does not claim to have reached a server it never contacted', async () => {
    const result = await invoke(['doctor'], {
      env: { ...CONFIGURED_ENV, WATERX_PREDICT_TOKEN: 'a-supplied-token-value' },
      routes: { 'GET /agent-api/v1/predict/markets': MARKETS_OK },
    });
    const report = result.envelope.data as Report;

    expect(statusOf(report, 'api-reachable')).toBe('SKIP');
    expect(statusOf(report, 'authentication')).toBe('SKIP');
    // The catalog read is the request that actually exercised the token.
    expect(statusOf(report, 'market-catalog')).toBe('PASS');
    expect(result.signerRuns).toHaveLength(0);
  });

  it('counts skips, so a mostly-skipped report cannot read as a healthy one', async () => {
    const report = (await invoke(['doctor'])).envelope.error?.details as { report: Report };
    expect(report.report.skipped).toBeGreaterThan(0);
  });
});

/**
 * The half of "why can I not trade" that no local check reaches.
 *
 * A check says what happened; a requirement says who fixes it. The distinction
 * is the whole point for the reader who is not a person: `signer FAIL — no
 * signer command is configured` is a sentence to parse, and a requirement with
 * `suppliedBy` and `supplyWith` is an action to take.
 */
describe('doctor: what is missing, and whose it is to supply', () => {
  it('reports nothing outstanding when the owner has granted everything', async () => {
    const result = await invoke(['doctor', '--accountId', ACCOUNT_ID], {
      env: { ...CONFIGURED_ENV, WATERX_PREDICT_ENVIRONMENT: 'testnet' },
      routes: WORKING,
    });
    const report = result.envelope.data as Report;

    expect(report.missing).toEqual([]);
    expect(report.unchecked).toEqual([]);
    expect(report.nextStep).toEqual({ actor: 'NOBODY', action: '' });
    expect(stateOf(report, 'delegation')).toBe('SATISFIED');
    expect(stateOf(report, 'authorizedAccount')).toBe('SATISFIED');
  });

  it('never reports an owner-supplied fact as missing on a request that failed', async () => {
    // The listing was never read, so nothing is known about what an owner
    // granted. MISSING here sends a person to sign a delegation they may
    // already have signed, after which they conclude the product is broken.
    const result = await invoke(['doctor', '--accountId', ACCOUNT_ID], {
      env: CONFIGURED_ENV,
      routes: {
        'POST /agent-api/v1/auth': AUTH_OK,
        'GET /agent-api/v1/predict/markets': MARKETS_OK,
        [`GET /agent-api/v1/predict/accounts/${ACCOUNT_ID}/allowance`]: ALLOWANCE_OK,
        [ACCOUNTS_PATH]: { status: 503, body: { code: 'UNAVAILABLE', message: 'upstream' } },
      },
    });
    const report = result.envelope.data as Report;

    for (const id of ['authorizedAccount', 'delegation', 'riskProfile']) {
      expect(stateOf(report, id), id).toBe('UNCHECKED');
    }
    expect(report.missing.map((requirement) => requirement.id)).not.toContain('delegation');
  });

  it('keeps an unreadable chain permission unchecked rather than missing', async () => {
    // `mayPlaceOrder: null` is a FAILED chain read, not a refusal — the same
    // distinction `describeOnboarding` refuses to collapse, for the same money.
    const result = await invoke(['doctor', '--accountId', ACCOUNT_ID], {
      env: CONFIGURED_ENV,
      routes: {
        ...WORKING,
        [ACCOUNTS_PATH]: listing(
          account({ delegation: { mayPlaceOrder: null, mayRequestClose: null, checkedAt: null } }),
        ),
      },
    });
    const report = result.envelope.data as Report;

    expect(stateOf(report, 'delegation')).toBe('UNCHECKED');
    // The mandate itself is real: the listing is built from the owner's own
    // risk profiles, so a row existing is evidence one was written.
    expect(stateOf(report, 'riskProfile')).toBe('SATISFIED');
  });

  it('sends the owner, not the operator, when nothing has been granted', async () => {
    const result = await invoke(['doctor', '--accountId', ACCOUNT_ID], {
      env: { ...CONFIGURED_ENV, WATERX_PREDICT_ENVIRONMENT: 'testnet' },
      routes: { ...WORKING, [ACCOUNTS_PATH]: listing() },
    });
    const report = result.envelope.data as Report;

    expect(report.missing.map((requirement) => requirement.id)).toEqual([
      'authorizedAccount',
      'delegation',
      'riskProfile',
    ]);
    expect(report.nextStep.actor).toBe('ACCOUNT_OWNER');
  });

  it('does not turn an outstanding grant into a broken machine', async () => {
    // Configuration and signer are sound and the owner has not signed yet. That
    // is not a doctor failure: reporting it as one conflates "your setup is
    // wrong" with "your owner has not signed yet", and they are different
    // actions by different people.
    const result = await invoke(['doctor', '--accountId', ACCOUNT_ID], {
      env: { ...CONFIGURED_ENV, WATERX_PREDICT_ENVIRONMENT: 'testnet' },
      routes: { ...WORKING, [ACCOUNTS_PATH]: listing() },
    });
    const report = result.envelope.data as Report;

    expect(result.exit).toBe(EXIT_CODES.OK);
    expect(report.failed).toBe(0);
    expect(report.missing.length).toBeGreaterThan(0);
  });

  it('names the operator gaps ahead of the owner gaps', async () => {
    // Nothing is configured, so nothing was asked of any server. The four local
    // requirements are missing and the three owner-side ones are unchecked —
    // and an operator cannot fix an owner's step by trying harder anyway.
    const details = (await invoke(['doctor'])).envelope.error?.details as { report: Report };
    const report = details.report;

    expect(report.missing.map((requirement) => requirement.id)).toEqual([
      'deployment',
      'agentWallet',
      'signer',
    ]);
    expect(report.unchecked).toHaveLength(3);
    expect(report.nextStep.actor).toBe('AGENT_OPERATOR');
    expect(report.requirements.every((requirement) => requirement.evidence.length > 0)).toBe(true);
  });
});
