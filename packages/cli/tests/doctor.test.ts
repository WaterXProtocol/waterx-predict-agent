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

interface Report {
  checks: { id: string; status: string; code?: string; summary: string }[];
  failed: number;
  skipped: number;
  checkedAt: string;
}

const MARKETS_OK = { status: 200, body: { markets: [{ marketId: 'm1' }] } } as const;

const statusOf = (report: Report, id: string): string | undefined =>
  report.checks.find((check) => check.id === id)?.status;

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
    expect(
      report.checks.find((check) => check.id === 'account-allowance')?.summary,
    // The flag it names must be one that exists: flag names are the schema's
    // field names, so `--account-id` would be rejected as unknown.
    ).toMatch(/--accountId/u);
    expect(result.exit).toBe(EXIT_CODES.OK);
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
