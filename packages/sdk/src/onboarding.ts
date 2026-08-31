/**
 * Getting an agent from "it has a keypair" to "it may trade", without asking a
 * person to copy identifiers between two windows.
 *
 * Three things must exist before a write is accepted, and only one of them can be
 * automated away:
 *
 *  - an ACCOUNT ID — the agent cannot discover it, but the server can now answer
 *    for it (`listAuthorizedAccounts`), so nobody needs to copy it;
 *  - an on-chain DELEGATION — the owner signs it with their own wallet, and no
 *    amount of tooling may do that on their behalf (ADR-0003). This is the one
 *    irreducible human step;
 *  - a RISK PROFILE — the owner's mandate, written in the same owner-authenticated
 *    session as the delegation.
 *
 * So the flow this module supports is: build a URL that names THIS agent, hand it
 * to the owner, and poll until the grants show up. The agent never signs anything
 * on the owner's behalf and never learns an id it was not granted.
 */
import type { ListAgentAccountsResponseBody, PredictAgentAccountSummary } from './contract.ts';
import { sleep } from './sleep.ts';

/**
 * The web app paired with each API deployment — where an owner signs.
 *
 * Same rule as `PREDICT_AGENT_ENDPOINTS`: a lookup, never a default. A private or
 * preview console is passed as a plain string.
 */
export const PREDICT_AGENT_CONSOLE_ENDPOINTS = {
  production: 'https://waterx.app',
  testnet: 'https://testnet.waterx.app',
} as const;

/** Where the authorization flow lives in the console. */
export const PREDICT_AGENT_AUTHORIZE_PATH = '/agent/authorize';

/**
 * Why this agent may not trade yet, or that it may.
 *
 * `DELEGATION_UNKNOWN` is deliberately NOT folded into `DELEGATION_MISSING`. A
 * null permission means the chain read failed; telling an owner to sign a grant
 * they already signed is worse than saying "we could not check" — they would
 * either sign twice or conclude the product is broken.
 *
 * `AMBIGUOUS` is a real answer, not a failure: more than one account is ready and
 * choosing between them is the operator's decision. Picking one here would be
 * this SDK deciding whose money a strategy trades.
 */
export type OnboardingStatus =
  | 'READY'
  | 'NOT_ONBOARDED'
  | 'DELEGATION_MISSING'
  | 'DELEGATION_UNKNOWN'
  | 'SUSPENDED'
  | 'AMBIGUOUS';

/** Who has to act next. An operator cannot fix an owner's step by trying harder. */
export type OnboardingActor = 'AGENT_OPERATOR' | 'ACCOUNT_OWNER' | 'NOBODY';

export interface OnboardingState {
  status: OnboardingStatus;
  /** The account to trade on. Set ONLY when `status` is `READY`. */
  account: PredictAgentAccountSummary | undefined;
  /** Every account the server listed, whatever their state. */
  accounts: PredictAgentAccountSummary[];
  /** Who must act, and what they must do. Empty action when nobody must. */
  nextStep: { actor: OnboardingActor; action: string };
}

export interface DescribeOnboardingOptions {
  /**
   * Narrow to one account. Given, an account absent from the list is
   * `NOT_ONBOARDED` rather than silently replaced by another one that happens to
   * be ready.
   */
  accountId?: string;
}

/**
 * Turn the server's answer into a decision, and a decision into an instruction.
 *
 * Ordering matters: a suspended mandate is reported as suspended even when the
 * delegation is also absent, because the owner deliberately turned this agent off
 * and re-signing a delegation would not change that.
 */
export function describeOnboarding(
  response: ListAgentAccountsResponseBody,
  options: DescribeOnboardingOptions = {},
): OnboardingState {
  const accounts =
    options.accountId === undefined
      ? response.accounts
      : response.accounts.filter((account) => account.accountId === options.accountId);

  if (accounts.length === 0) {
    return {
      status: 'NOT_ONBOARDED',
      account: undefined,
      accounts,
      nextStep: {
        actor: 'ACCOUNT_OWNER',
        action:
          'Open the authorization link, pick an account, set the limits and sign. Nothing here can do it for them.',
      },
    };
  }

  const ready = accounts.filter(
    (account) => !account.isSuspended && account.delegation.mayPlaceOrder === true,
  );
  if (ready.length === 1) {
    return {
      status: 'READY',
      account: ready[0],
      accounts,
      nextStep: { actor: 'NOBODY', action: '' },
    };
  }
  if (ready.length > 1) {
    return {
      status: 'AMBIGUOUS',
      account: undefined,
      accounts,
      nextStep: {
        actor: 'AGENT_OPERATOR',
        action: `Name one of the ${String(ready.length)} authorized accounts; this SDK will not choose whose money to trade.`,
      },
    };
  }

  // Nothing is ready. Report the most actionable reason across what we have,
  // worst-first: a suspension the owner set, then a chain read that failed, then
  // a delegation nobody signed.
  if (accounts.some((account) => account.isSuspended)) {
    return {
      status: 'SUSPENDED',
      account: undefined,
      accounts,
      nextStep: {
        actor: 'ACCOUNT_OWNER',
        action: 'The mandate is suspended. Only the owner can lift it; re-signing a delegation will not.',
      },
    };
  }
  if (accounts.some((account) => account.delegation.mayPlaceOrder === null)) {
    return {
      status: 'DELEGATION_UNKNOWN',
      account: undefined,
      accounts,
      nextStep: {
        actor: 'AGENT_OPERATOR',
        action: 'The on-chain delegation could not be read. This is not a refusal — retry before asking the owner for anything.',
      },
    };
  }
  return {
    status: 'DELEGATION_MISSING',
    account: undefined,
    accounts,
    nextStep: {
      actor: 'ACCOUNT_OWNER',
      action:
        'The mandate exists but the on-chain delegation does not. Open the authorization link and sign it.',
    },
  };
}

export interface AuthorizationUrlOptions {
  /** The console this deployment is paired with — see `PREDICT_AGENT_CONSOLE_ENDPOINTS`. */
  consoleBaseUrl: string;
  /** The wallet the owner is authorizing. The agent's own; never one it was told to use. */
  agentWallet: string;
  /** A human label so the owner can tell two agents apart in their list. */
  label?: string;
  /** Pre-select an account the owner already named. */
  accountId?: string;
}

/**
 * The link an owner opens to authorize this agent.
 *
 * It carries the agent's address and nothing else that matters: no token, no
 * secret, no pre-authorization. Everything it can do, the owner does with their
 * own wallet in their own session — so the link is safe to paste into a chat, and
 * an attacker who intercepts it gains the ability to ask someone to authorize an
 * address they can already see.
 */
export function buildAuthorizationUrl(options: AuthorizationUrlOptions): string {
  const url = new URL(PREDICT_AGENT_AUTHORIZE_PATH, `${options.consoleBaseUrl.replace(/\/+$/, '')}/`);
  url.searchParams.set('agent', options.agentWallet);
  if (options.label !== undefined) url.searchParams.set('label', options.label);
  if (options.accountId !== undefined) url.searchParams.set('account', options.accountId);
  return url.toString();
}

/** What `waitForAuthorization` needs, minus the rest of the client. */
export interface AuthorizationPoller {
  listAuthorizedAccounts(signal?: AbortSignal): Promise<ListAgentAccountsResponseBody>;
}

export interface WaitForAuthorizationOptions extends DescribeOnboardingOptions {
  /** Default 10 minutes: an owner has to find their wallet and read a screen. */
  timeoutMs?: number;
  /** Default 3 s. The owner is signing in another window; polling faster helps nobody. */
  pollIntervalMs?: number;
  signal?: AbortSignal;
  /** Called on every state CHANGE, so a caller can print progress without polling twice. */
  onChange?: (state: OnboardingState) => void;
}

export interface AuthorizationWaitResult extends OnboardingState {
  /** True when the wait ran out first. NOT a failure: the owner may still be signing. */
  timedOut: boolean;
}

const DEFAULT_AUTHORIZATION_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_AUTHORIZATION_POLL_MS = 3_000;

/**
 * Poll until the owner's grants land, then report what to trade on.
 *
 * Running out of time is NOT an error and does not cancel anything — the owner
 * may sign a minute later. The result carries `timedOut` and the last state, so a
 * caller resumes by calling again rather than by restarting an onboarding the
 * owner has half-completed.
 *
 * `DELEGATION_UNKNOWN` keeps the loop running on purpose: a failed chain read is
 * exactly the transient condition a poll exists to ride out.
 */
export async function waitForAuthorization(
  client: AuthorizationPoller,
  options: WaitForAuthorizationOptions = {},
): Promise<AuthorizationWaitResult> {
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_AUTHORIZATION_TIMEOUT_MS);
  const interval = options.pollIntervalMs ?? DEFAULT_AUTHORIZATION_POLL_MS;
  const describeOptions =
    options.accountId === undefined ? {} : { accountId: options.accountId };
  let previous: OnboardingStatus | undefined;

  for (;;) {
    options.signal?.throwIfAborted();
    const state = describeOnboarding(
      await client.listAuthorizedAccounts(options.signal),
      describeOptions,
    );
    if (state.status !== previous) {
      previous = state.status;
      options.onChange?.(state);
    }
    // AMBIGUOUS is terminal too: more waiting cannot resolve a question only the
    // operator can answer.
    if (state.status === 'READY' || state.status === 'AMBIGUOUS') {
      return { ...state, timedOut: false };
    }
    if (Date.now() >= deadline) return { ...state, timedOut: true };
    await sleep(Math.max(0, Math.min(interval, deadline - Date.now())), options.signal);
  }
}
