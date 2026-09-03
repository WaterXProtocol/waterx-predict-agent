/**
 * The one call that answers "may this agent trade", and the claim it exists to
 * stop this package from making.
 *
 * The failure being pinned here happened. An agent holding only the library read
 * the installation report, saw that `waterx-predict` was absent from PATH, read
 * the rule saying an approval token is required for a write, and warned its user
 * that the order would probably be refused with `POLICY_DENIED`. It then placed
 * the order successfully and had to retract the warning — because `POLICY_DENIED`
 * is the CLI's own error code, enforced inside the CLI's process, and never
 * appears on this API's wire at all.
 *
 * So most of what is asserted below is about what this report must NOT say.
 */
import { describe, expect, it } from 'vitest';

import type {
  ListAgentAccountsResponseBody,
  PredictAgentAccountSummary,
  PredictEffectiveLimitsResponseBody,
} from '../src/contract.ts';
import { diagnose, type DiagnosableClient } from '../src/diagnosis.ts';
import { describeInstallation } from '../src/installation.ts';

const AGENT = `0x${'ab'.repeat(32)}`;

/** A PATH with nothing on it, so `waterx-predict` is genuinely absent. */
const NO_CLI = { PATH: '/nonexistent-directory-for-this-test' } as const;

function account(
  overrides: Partial<PredictAgentAccountSummary> = {},
): PredictAgentAccountSummary {
  return {
    accountId: '0xacct',
    ownerAddress: '0xowner',
    isSuspended: false,
    policyVersion: 1,
    delegation: {
      mayPlaceOrder: true,
      mayRequestClose: true,
      checkedAt: '2026-09-02T08:00:00.000Z',
    },
    grantedAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

const LIMITS = { limits: { maxOrderNotional: '25' } } as unknown as
  PredictEffectiveLimitsResponseBody;

/**
 * A hand-counted double rather than a mock.
 *
 * `authenticate` is the one call whose COUNT is asserted — this method is the
 * single place in the client allowed to open a session on its own, so "did it,
 * and only once" is part of the contract rather than an implementation detail.
 */
function stub(
  accounts: PredictAgentAccountSummary[],
  overrides: Partial<DiagnosableClient> = {},
): DiagnosableClient & { authenticated: () => number; limitReads: () => number } {
  let authenticated = 0;
  let limitReads = 0;
  return {
    baseUrl: 'https://api-testnet.waterx.app',
    deployment: 'testnet',
    agentWallet: AGENT,
    isAuthenticated: () => false,
    authenticate: async (): Promise<unknown> => {
      authenticated += 1;
      return await Promise.resolve({});
    },
    listAuthorizedAccounts: async (): Promise<ListAgentAccountsResponseBody> =>
      await Promise.resolve({ accounts }),
    getEffectiveLimits: async (): Promise<PredictEffectiveLimitsResponseBody> => {
      limitReads += 1;
      return await Promise.resolve(LIMITS);
    },
    ...overrides,
    authenticated: () => authenticated,
    limitReads: () => limitReads,
  };
}

describe('the write gate', () => {
  it('says a delegated agent may trade even with no CLI anywhere on PATH', async () => {
    // THE regression. Absence of the CLI is not evidence about whether a write
    // is admitted, and this report must never let it read as though it were.
    const report = await diagnose(stub([account()]), { env: NO_CLI });

    expect(report.writes.permitted).toBe(true);
    expect(report.writes.status).toBe('DELEGATED');
    expect(report.ready).toBe(true);
    expect(report.installation.surfaces.find((s) => s.id === 'cli')?.present).toBe(false);
  });

  it('names the on-chain delegation as the gate, never the execution policy', async () => {
    const report = await diagnose(stub([account()]), { env: NO_CLI });

    expect(report.writes.gatedBy).toBe('ON_CHAIN_DELEGATION');
    // `POLICY_DENIED` is not in `PredictAgentErrorCode`, so the gate itself must
    // never name it — not as a status, not as a refusal it could arrive as, and
    // not in the sentence a caller will quote to a user.
    const gate = JSON.stringify(report.writes);
    expect(gate).not.toContain('POLICY_DENIED');
    expect(gate).not.toContain('approval');
    expect(report.writes.refusesWith).not.toContain('POLICY_DENIED');

    // It appears exactly once in the whole report, in the offline statement, and
    // only to say it does not apply here. Naming it in order to rule it out is
    // the point — a reader who has met the term in the CLI's documentation needs
    // to be told which surface it belongs to, not left to infer it.
    const detail = report.installation.writes.detail;
    expect(detail).toContain('POLICY_DENIED is not a code this API returns');
    expect(detail).toContain('do not apply here');
  });

  it('reports a refusal with the codes it would actually arrive as', async () => {
    const report = await diagnose(
      stub([account({ delegation: { mayPlaceOrder: false, mayRequestClose: false, checkedAt: 'x' } })]),
      { env: NO_CLI },
    );

    expect(report.writes.permitted).toBe(false);
    expect(report.writes.status).toBe('DELEGATION_MISSING');
    expect(report.writes.refusesWith).toContain('DELEGATION_PERMISSION_DENIED');
  });

  it('keeps "we could not check" out of "you may not trade"', async () => {
    // A null permission means the chain read failed. Reporting that as a refusal
    // sends an owner to re-sign a grant they already made.
    const report = await diagnose(
      stub([account({ delegation: { mayPlaceOrder: null, mayRequestClose: null, checkedAt: 'x' } })]),
      { env: NO_CLI },
    );

    expect(report.writes.permitted).toBeUndefined();
    expect(report.writes.status).toBe('DELEGATION_UNKNOWN');
    expect(report.ready).toBe(false);
    expect(report.writes.refusesWith).toEqual([]);
  });

  it('treats two ready accounts as a choice, not as a barrier', async () => {
    const report = await diagnose(
      stub([account(), account({ accountId: '0xsecond' })]),
      { env: NO_CLI },
    );

    expect(report.writes.status).toBe('AMBIGUOUS_ACCOUNT');
    // A write WOULD be admitted; what is missing is which account, and that is
    // the operator's answer rather than another signature from the owner.
    expect(report.writes.permitted).toBe(true);
    expect(report.ready).toBe(false);
    expect(report.nextStep.actor).toBe('AGENT_OPERATOR');
  });

  it('reports a suspension as the owner\'s, not as a missing delegation', async () => {
    const report = await diagnose(stub([account({ isSuspended: true })]), { env: NO_CLI });

    expect(report.writes.status).toBe('SUSPENDED');
    expect(report.nextStep.actor).toBe('ACCOUNT_OWNER');
  });
});

describe('the six requirements', () => {
  it('leaves none of them UNCHECKED, which is the difference from the offline report', async () => {
    const offline = describeInstallation({ env: NO_CLI });
    expect(offline.unchecked).toHaveLength(3);

    const report = await diagnose(stub([account()]), { env: NO_CLI });

    expect(report.requirements.filter((entry) => entry.state === 'UNCHECKED')).toHaveLength(0);
    expect(report.requirements.every((entry) => entry.state === 'SATISFIED')).toBe(true);
  });

  it('does not report a configured caller\'s own setup as missing', async () => {
    // A client exists, so its endpoint, wallet and signer are present by
    // construction. Reading MISSING off an unset environment variable is the
    // false negative that makes a caller distrust the rest of the report.
    const report = await diagnose(stub([account()]), { env: NO_CLI });

    for (const id of ['deployment', 'agentWallet', 'signer']) {
      expect(report.requirements.find((entry) => entry.id === id)?.state, id).toBe('SATISFIED');
    }
  });

  it('keeps the delegation UNCHECKED when the chain read failed', async () => {
    const report = await diagnose(
      stub([account({ delegation: { mayPlaceOrder: null, mayRequestClose: null, checkedAt: 'x' } })]),
      { env: NO_CLI },
    );

    const delegation = report.requirements.find((entry) => entry.id === 'delegation');
    expect(delegation?.state).toBe('UNCHECKED');
    expect(delegation?.unresolved).toMatch(/not a refusal/iu);
  });
});

describe('the authorization link', () => {
  it('is built and offered whenever the owner still has to act', async () => {
    const report = await diagnose(stub([]), { env: NO_CLI, label: 'my-bot' });

    expect(report.authorizationUrl).toBe(
      `https://testnet.waterx.app/agent/authorize?agent=${AGENT}&label=my-bot`,
    );
  });

  it('is withheld once there is nothing to authorize', async () => {
    const report = await diagnose(stub([account()]), { env: NO_CLI });

    expect(report.authorizationUrl).toBeUndefined();
  });

  it('is withheld for a deployment nobody paired a console with', async () => {
    // A link to the wrong console is worse than no link.
    const report = await diagnose(
      stub([], { deployment: undefined, baseUrl: 'https://predict.internal' }),
      { env: NO_CLI },
    );

    expect(report.authorizationUrl).toBeUndefined();
  });

  it('uses a console the caller named for a private deployment', async () => {
    const report = await diagnose(
      stub([], { deployment: undefined, baseUrl: 'https://predict.internal' }),
      { env: NO_CLI, consoleBaseUrl: 'https://console.internal/' },
    );

    expect(report.authorizationUrl).toBe(
      `https://console.internal/agent/authorize?agent=${AGENT}`,
    );
  });
});

describe('the session and the mandate', () => {
  it('opens a session when none is held, and says that it did', async () => {
    const client = stub([account()]);
    const report = await diagnose(client, { env: NO_CLI });

    expect(client.authenticated()).toBe(1);
    expect(report.authenticatedHere).toBe(true);
  });

  it('does not re-authenticate a client that already has a session', async () => {
    const client = stub([account()], { isAuthenticated: () => true });
    const report = await diagnose(client, { env: NO_CLI });

    expect(client.authenticated()).toBe(0);
    expect(report.authenticatedHere).toBe(false);
  });

  it('reads the mandate in the same call, because it is the next question', async () => {
    const report = await diagnose(stub([account()]), { env: NO_CLI });

    expect(report.limits).toBe(LIMITS);
  });

  it('skips the mandate when asked to', async () => {
    const client = stub([account()]);
    const report = await diagnose(client, { env: NO_CLI, includeLimits: false });

    expect(client.limitReads()).toBe(0);
    expect(report.limits).toBeUndefined();
  });

  it('reports a failed limits read rather than failing the diagnosis', async () => {
    // The diagnosis already succeeded. Throwing here would tell a caller that a
    // working, authorized agent is broken.
    const report = await diagnose(
      stub([account()], {
        getEffectiveLimits: async () => await Promise.reject(new Error('rate limited')),
      }),
      { env: NO_CLI },
    );

    expect(report.ready).toBe(true);
    expect(report.limits).toBeUndefined();
    expect(report.limitsError).toBe('rate limited');
  });
});
