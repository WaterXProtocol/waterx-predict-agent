/**
 * `onboard` — the one command addressed to a HUMAN.
 *
 * Everything else in this CLI answers an agent. This answers the person standing
 * between an agent and its first trade, and its whole job is to make that person
 * do the smallest possible amount of work: open one link, sign once.
 *
 * What it will not do, and why the list is short but absolute: it does not sign a
 * delegation, write a risk profile, raise a limit or pick an account. The first
 * three are owner-authenticated by construction (ADR-0003) — a runtime that could
 * grant its own authority would make the authority meaningless — and the fourth
 * is the same refusal `market search` makes about an ambiguous market, one level
 * up: choosing between two authorized accounts is choosing whose money is traded.
 *
 * The link is safe to paste anywhere. It names the agent wallet and carries no
 * token, no secret and no pre-authorization; everything it can do, the owner does
 * with their own wallet in their own session.
 */
import {
  buildAuthorizationUrl,
  describeOnboarding,
  PREDICT_AGENT_CONSOLE_ENDPOINTS,
  PREDICT_AGENT_ENDPOINTS,
  waitForAuthorization,
  type OnboardingState,
} from '@waterx/predict-agent-sdk';

import { CliError } from '../errors.ts';
import type { CommandContext } from '../context.ts';

/** Long enough for a person to find a wallet and read a screen. */
const DEFAULT_WAIT_MS = 10 * 60 * 1_000;

/**
 * The console paired with a known API deployment.
 *
 * Derived only for deployments this build can name. A private or preview API has
 * no paired console, and inventing a hostname would send an owner to a page that
 * cannot grant anything — so that case is an error naming the setting to fill in,
 * never a guess.
 */
function consoleUrlFor(context: CommandContext): string {
  const explicit = context.input.consoleUrl;
  if (typeof explicit === 'string' && explicit !== '') return explicit;
  if (context.config.consoleUrl !== undefined) return context.config.consoleUrl;

  const baseUrl = context.config.baseUrl;
  for (const [name, apiUrl] of Object.entries(PREDICT_AGENT_ENDPOINTS)) {
    if (baseUrl === apiUrl) {
      return PREDICT_AGENT_CONSOLE_ENDPOINTS[name as keyof typeof PREDICT_AGENT_CONSOLE_ENDPOINTS];
    }
  }
  throw new CliError(
    'NOT_CONFIGURED',
    `No console is paired with ${baseUrl ?? 'the configured API'}, so there is no link an owner could open. Set WATERX_PREDICT_CONSOLE_URL (or \`consoleUrl\` in the config file), or pass --consoleUrl.`,
    { baseUrl, known: Object.values(PREDICT_AGENT_CONSOLE_ENDPOINTS) },
  );
}

/** What a caller should do with a state, said once and reused by both paths. */
function render(
  state: OnboardingState,
  authorizationUrl: string,
  agentWallet: string,
  timedOut: boolean,
): unknown {
  const ready = state.status === 'READY';
  return {
    status: state.status,
    ready,
    timedOut,
    agentWallet,
    /** Present whatever the state: a READY agent may still need a second account authorized. */
    authorizationUrl,
    accountId: state.account?.accountId ?? null,
    nextStep: state.nextStep,
    accounts: state.accounts.map((account) => ({
      accountId: account.accountId,
      ownerAddress: account.ownerAddress,
      isSuspended: account.isSuspended,
      policyVersion: account.policyVersion,
      delegation: account.delegation,
      grantedAt: account.grantedAt,
    })),
    caveats: [
      'The link carries no token and no pre-authorization. It names this agent wallet, and the owner grants — or does not — with their own wallet.',
      'This runtime cannot sign a delegation, write a risk profile or raise a limit. Those are owner-authenticated by construction (ADR-0003).',
      '`DELEGATION_UNKNOWN` means the on-chain read FAILED. It is not a refusal, and asking the owner to sign again would have them authorize an agent that may already be authorized.',
      'A timed-out wait is not a failure: the owner may sign a minute later. Run this again rather than starting over.',
    ],
  };
}

export async function runtimeOnboard(context: CommandContext): Promise<unknown> {
  const agentWallet = context.config.agentWallet;
  if (agentWallet === undefined) {
    throw new CliError(
      'NOT_CONFIGURED',
      'No agent wallet is configured, so there is no address for an owner to authorize. Set WATERX_PREDICT_AGENT_WALLET (or `agentWallet` in the config file) to the address this runtime signs as.',
    );
  }
  const authorizationUrl = buildAuthorizationUrl({
    consoleBaseUrl: consoleUrlFor(context),
    agentWallet,
    ...(typeof context.input.label === 'string' ? { label: context.input.label } : {}),
    ...(typeof context.input.accountId === 'string' ? { accountId: context.input.accountId } : {}),
  });
  const scope =
    typeof context.input.accountId === 'string' ? { accountId: context.input.accountId } : {};

  const client = await context.client();

  // Announced BEFORE the first read, and on stderr: a human waiting on this needs
  // the link now, and stdout carries one JSON document that must stay parseable.
  context.diagnostic(
    `Authorize this agent by opening:\n  ${authorizationUrl}\nThe page asks the account owner to pick an account, set the limits and sign once.\n`,
  );

  if (context.input.wait !== true) {
    const state = describeOnboarding(await client.listAuthorizedAccounts(context.signal()), scope);
    return render(state, authorizationUrl, agentWallet, false);
  }

  const timeoutMs = typeof context.input.timeoutMs === 'number' ? context.input.timeoutMs : DEFAULT_WAIT_MS;
  const result = await waitForAuthorization(client, {
    ...scope,
    timeoutMs,
    signal: context.signal(),
    // Progress on stderr as it changes, so a person watching a terminal is not
    // staring at nothing for ten minutes.
    onChange: (state) => {
      context.diagnostic(
        state.status === 'READY'
          ? 'Authorized. This agent may now trade on the account below.\n'
          : `Waiting — ${state.status}: ${state.nextStep.action}\n`,
      );
    },
  });
  return render(result, authorizationUrl, agentWallet, result.timedOut);
}
