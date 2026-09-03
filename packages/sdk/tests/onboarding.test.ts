/**
 * The onboarding decision, which is the one place this SDK tells a HUMAN what to
 * do. Every assertion here is about not sending the wrong person to do the wrong
 * thing: an owner asked to re-sign a delegation they already signed concludes the
 * product is broken, and an operator told "not authorized" when an RPC blipped
 * tears down a working strategy.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ListAgentAccountsResponseBody, PredictAgentAccountSummary } from '../src/contract.ts';
import {
  buildAuthorizationUrl,
  describeOnboarding,
  PREDICT_AGENT_CONSOLE_ENDPOINTS,
  startOnboarding,
  waitForAuthorization,
} from '../src/onboarding.ts';

const AGENT = '0xagent';

function account(overrides: Partial<PredictAgentAccountSummary> = {}): PredictAgentAccountSummary {
  return {
    accountId: '0xacct',
    ownerAddress: '0xowner',
    isSuspended: false,
    policyVersion: 1,
    delegation: { mayPlaceOrder: true, mayRequestClose: true, checkedAt: '2026-08-01T00:00:00.000Z' },
    grantedAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-02T00:00:00.000Z',
    ...overrides,
  };
}

const listing = (...accounts: PredictAgentAccountSummary[]): ListAgentAccountsResponseBody => ({
  accounts,
});

describe('describeOnboarding', () => {
  it('is READY only when a mandate, an unsuspended profile and a signed delegation all exist', () => {
    const state = describeOnboarding(listing(account()));

    expect(state.status).toBe('READY');
    expect(state.account?.accountId).toBe('0xacct');
    expect(state.nextStep.actor).toBe('NOBODY');
  });

  it('sends an empty list to the OWNER, not the operator', () => {
    const state = describeOnboarding(listing());

    expect(state.status).toBe('NOT_ONBOARDED');
    // The operator cannot fix this by retrying, and saying so is the difference
    // between a 30-second onboarding and a support ticket.
    expect(state.nextStep.actor).toBe('ACCOUNT_OWNER');
  });

  it('separates "the owner never signed" from "we could not check"', () => {
    const missing = describeOnboarding(
      listing(account({ delegation: { mayPlaceOrder: false, mayRequestClose: false, checkedAt: 'x' } })),
    );
    const unknown = describeOnboarding(
      listing(account({ delegation: { mayPlaceOrder: null, mayRequestClose: null, checkedAt: 'x' } })),
    );

    expect(missing.status).toBe('DELEGATION_MISSING');
    expect(missing.nextStep.actor).toBe('ACCOUNT_OWNER');
    // null is a failed chain read. Asking the owner to sign again would have them
    // authorize an agent that is already authorized.
    expect(unknown.status).toBe('DELEGATION_UNKNOWN');
    expect(unknown.nextStep.actor).toBe('AGENT_OPERATOR');
  });

  it('reports a suspension as a suspension even when the delegation is also absent', () => {
    // Worst-first: the owner deliberately turned this agent off, and no amount of
    // re-signing changes that. Reporting DELEGATION_MISSING here would send them
    // through a flow that cannot fix their problem.
    const state = describeOnboarding(
      listing(
        account({
          isSuspended: true,
          delegation: { mayPlaceOrder: false, mayRequestClose: false, checkedAt: 'x' },
        }),
      ),
    );

    expect(state.status).toBe('SUSPENDED');
  });

  it('refuses to choose between two authorized accounts', () => {
    const state = describeOnboarding(listing(account(), account({ accountId: '0xother' })));

    // Same rule as market resolution: an identity the caller did not name is one
    // this SDK must not invent — here it would be whose money gets traded.
    expect(state.status).toBe('AMBIGUOUS');
    expect(state.account).toBeUndefined();
    expect(state.accounts).toHaveLength(2);
  });

  it('honours a named account instead of substituting a ready one', () => {
    const state = describeOnboarding(listing(account({ accountId: '0xother' })), {
      accountId: '0xacct',
    });

    expect(state.status).toBe('NOT_ONBOARDED');
    expect(state.account).toBeUndefined();
  });
});

describe('buildAuthorizationUrl', () => {
  it('names the agent and carries nothing that authorizes anything', () => {
    const url = new URL(
      buildAuthorizationUrl({
        consoleBaseUrl: PREDICT_AGENT_CONSOLE_ENDPOINTS.testnet,
        agentWallet: AGENT,
        label: 'my bot',
      }),
    );

    expect(url.origin).toBe('https://testnet.waterx.app');
    expect(url.pathname).toBe('/agent/authorize');
    expect(url.searchParams.get('agent')).toBe(AGENT);
    expect(url.searchParams.get('label')).toBe('my bot');
    // Everything the link can do, the owner does with their own wallet. A token
    // in here would make a pasteable link a bearer credential.
    expect([...url.searchParams.keys()].sort()).toEqual(['agent', 'label']);
  });

  it('survives a base URL with a trailing slash', () => {
    const url = buildAuthorizationUrl({
      consoleBaseUrl: 'https://console.example.com/',
      agentWallet: AGENT,
    });

    expect(url).toBe('https://console.example.com/agent/authorize?agent=0xagent');
  });
});

describe('waitForAuthorization', () => {
  it('returns as soon as the owner has signed', async () => {
    const listAuthorizedAccounts = vi
      .fn()
      .mockResolvedValueOnce(listing())
      .mockResolvedValueOnce(listing(account()));

    const result = await waitForAuthorization({ listAuthorizedAccounts }, { pollIntervalMs: 1 });

    expect(result.status).toBe('READY');
    expect(result.timedOut).toBe(false);
    expect(listAuthorizedAccounts).toHaveBeenCalledTimes(2);
  });

  it('keeps waiting through a failed chain read', async () => {
    // The whole point of a poll is riding out the transient. Treating a null
    // permission as terminal would abort an onboarding over an RPC blip.
    const listAuthorizedAccounts = vi
      .fn()
      .mockResolvedValueOnce(
        listing(account({ delegation: { mayPlaceOrder: null, mayRequestClose: null, checkedAt: 'x' } })),
      )
      .mockResolvedValueOnce(listing(account()));

    const result = await waitForAuthorization({ listAuthorizedAccounts }, { pollIntervalMs: 1 });

    expect(result.status).toBe('READY');
  });

  it('stops on AMBIGUOUS, which more waiting cannot resolve', async () => {
    const listAuthorizedAccounts = vi
      .fn()
      .mockResolvedValue(listing(account(), account({ accountId: '0xother' })));

    const result = await waitForAuthorization({ listAuthorizedAccounts }, { pollIntervalMs: 1 });

    expect(result.status).toBe('AMBIGUOUS');
    expect(listAuthorizedAccounts).toHaveBeenCalledTimes(1);
  });

  it('times out with the last state rather than throwing', async () => {
    // The owner may sign a minute later. A throw here would push a caller into a
    // catch block to recover a fact that is not a failure.
    const listAuthorizedAccounts = vi.fn().mockResolvedValue(listing());

    const result = await waitForAuthorization(
      { listAuthorizedAccounts },
      { timeoutMs: 0, pollIntervalMs: 1 },
    );

    expect(result.timedOut).toBe(true);
    expect(result.status).toBe('NOT_ONBOARDED');
  });

  it('reports each state change once, not each poll', async () => {
    const onChange = vi.fn();
    const listAuthorizedAccounts = vi
      .fn()
      .mockResolvedValueOnce(listing())
      .mockResolvedValueOnce(listing())
      .mockResolvedValueOnce(listing(account()));

    await waitForAuthorization({ listAuthorizedAccounts }, { pollIntervalMs: 1, onChange });

    expect(onChange.mock.calls.map(([state]) => state.status)).toEqual(['NOT_ONBOARDED', 'READY']);
  });
});

/**
 * The half that was routinely skipped.
 *
 * Every piece of this existed and was exported. What did not exist was the thing
 * that makes the poll the obvious next step rather than a fourth import, and the
 * cost of that omission is measurable: an agent builds the link out of three
 * modules, prints it, and stops — leaving a person to sign in another window and
 * come back to a dead terminal to announce that they did.
 */
describe('startOnboarding', () => {
  const poller = (
    ...responses: ListAgentAccountsResponseBody[]
  ): {
    agentWallet: string;
    deployment: 'testnet';
    listAuthorizedAccounts: () => Promise<ListAgentAccountsResponseBody>;
    calls: number;
  } => {
    let index = 0;
    const client = {
      agentWallet: AGENT,
      deployment: 'testnet' as const,
      calls: 0,
      listAuthorizedAccounts: async (): Promise<ListAgentAccountsResponseBody> => {
        client.calls += 1;
        const next = responses[Math.min(index, responses.length - 1)];
        index += 1;
        return await Promise.resolve(next ?? listing());
      },
    };
    return client;
  };

  it('hands back the link and the state in one call', async () => {
    const handle = await startOnboarding(poller(listing()), { label: 'my-bot' });

    expect(handle.url).toBe(
      `https://testnet.waterx.app/agent/authorize?agent=${AGENT}&label=my-bot`,
    );
    expect(handle.state.status).toBe('NOT_ONBOARDED');
    expect(handle.ready).toBe(false);
  });

  it('hands back a wait that resolves once the grants land', async () => {
    const client = poller(listing(), listing(account()));

    const handle = await startOnboarding(client);
    const result = await handle.wait({ pollIntervalMs: 0 });

    expect(result.status).toBe('READY');
    expect(result.timedOut).toBe(false);
  });

  it('reports each state change once, so a terminal can show progress', async () => {
    const client = poller(listing(), listing(), listing(account()));
    const seen: string[] = [];

    const handle = await startOnboarding(client);
    await handle.wait({ pollIntervalMs: 0, onChange: (state) => seen.push(state.status) });

    expect(seen).toEqual(['NOT_ONBOARDED', 'READY']);
  });

  it('says so immediately when the owner has already signed', async () => {
    const handle = await startOnboarding(poller(listing(account())));

    expect(handle.ready).toBe(true);
    expect(handle.state.account?.accountId).toBe('0xacct');
  });

  it('carries an account narrowing into the link AND into the wait', async () => {
    const client = poller(listing(account({ accountId: '0xother' })));

    const handle = await startOnboarding(client, { accountId: '0xacct' });
    const result = await handle.wait({ pollIntervalMs: 0, timeoutMs: 0 });

    expect(handle.url).toContain('account=0xacct');
    // The other account is ready, and it is NOT silently substituted.
    expect(result.status).toBe('NOT_ONBOARDED');
  });

  it('refuses to guess a console for a deployment nobody paired one with', async () => {
    // A link to the wrong console sends an owner somewhere else to sign.
    await expect(
      startOnboarding({ ...poller(listing()), deployment: undefined }),
    ).rejects.toThrow(TypeError);
  });

  it('uses a console the caller named for a private deployment', async () => {
    const handle = await startOnboarding(
      { ...poller(listing()), deployment: undefined },
      { consoleBaseUrl: 'https://console.internal/' },
    );

    expect(handle.url).toBe(`https://console.internal/agent/authorize?agent=${AGENT}`);
  });
});
