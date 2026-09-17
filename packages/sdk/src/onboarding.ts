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
import type {
  ListAgentAccountsResponseBody,
  PredictAgentAccountSummary,
  PredictAgentDeployment,
} from './contract.ts';
import { isPredictAgentApiError, PredictAgentTransportError } from './errors.ts';
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
 * It GRANTS nothing. No token, no secret, no pre-authorization: everything it
 * can do, the owner does with their own wallet in their own session, so an
 * attacker who intercepts it gains the ability to ask someone to authorize an
 * address they can already see.
 *
 * It is not contentless, though, and "safe to paste anywhere" would overstate
 * it. The URL carries the agent wallet, and — when the caller supplies them —
 * a `label` of the caller's own choosing and an `accountId`. The label is
 * whatever text was passed, and an account id identifies an account. Treat both
 * the way you would treat them in any other message; what is safe here is that
 * the link confers no authority, not that it says nothing.
 */
export function buildAuthorizationUrl(options: AuthorizationUrlOptions): string {
  // Resolved RELATIVE to the console, not from its root: the path is written
  // absolute, and `new URL('/agent/authorize', base)` would drop any prefix the
  // console is served under — a console at `https://host/console` would send
  // the owner to `https://host/agent/authorize`, a page that grants nothing.
  const url = new URL(
    PREDICT_AGENT_AUTHORIZE_PATH.replace(/^\/+/, ''),
    `${options.consoleBaseUrl.replace(/\/+$/, '')}/`,
  );
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
  /**
   * Default 30 minutes.
   *
   * It was ten, on the reasoning that an owner has to find their wallet and
   * read a screen. Measured, one did: thirty-five minutes and fifty seconds
   * from link to signature, during which the wait expired twice and the agent
   * driving it had to notice and restart it — turning a step that runs itself
   * into one somebody has to supervise.
   *
   * Thirty is not a promise that nobody takes longer; it is a bound chosen so
   * that expiring is unusual rather than routine. Expiry is still not a failure
   * and still cancels nothing, so a caller that means to wait indefinitely
   * passes its own number and runs this where blocking is free.
   */
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

const DEFAULT_AUTHORIZATION_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_AUTHORIZATION_POLL_MS = 3_000;
/** The ceiling a rate-limited poll backs off to. */
const MAX_AUTHORIZATION_BACKOFF_MS = 60_000;

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
  let last: OnboardingState | undefined;
  let backoff = interval;

  for (;;) {
    options.signal?.throwIfAborted();
    let listing: ListAgentAccountsResponseBody;
    try {
      listing = await client.listAuthorizedAccounts(options.signal);
    } catch (error: unknown) {
      // A poll exists to ride out the transient. A rate limit or a dropped
      // read backs off and tries again; only a refusal that retrying cannot
      // change ends the wait. Nothing read yet means nothing to time out with.
      const transient =
        error instanceof PredictAgentTransportError || (isPredictAgentApiError(error) && error.retryable);
      if (!transient || options.signal?.aborted === true) throw error;
      if (Date.now() >= deadline) {
        if (last === undefined) throw error;
        return { ...last, timedOut: true };
      }
      // The server's own `retryAfterMs`, when it names one, is the earliest a
      // read can succeed; asking sooner only spends the quota again.
      const asked = isPredictAgentApiError(error) ? error.details?.['retryAfterMs'] : undefined;
      backoff = Math.max(
        Math.min(backoff * 2, MAX_AUTHORIZATION_BACKOFF_MS),
        typeof asked === 'number' ? asked : 0,
      );
      await sleep(Math.max(0, Math.min(backoff, deadline - Date.now())), options.signal);
      continue;
    }
    backoff = interval;
    const state = describeOnboarding(listing, describeOptions);
    last = state;
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

/* ── Starting the flow, and staying on it ─────────────────────────────────── */

/**
 * What `startOnboarding` needs: the poll, plus enough to build the link.
 *
 * Structural, like every other client shape in this package — nothing here
 * imports the client, so the onboarding module stays reachable from a caller
 * that has not constructed one.
 */
export interface OnboardingClient extends AuthorizationPoller {
  /** The address the owner is authorizing. */
  readonly agentWallet: string;
  /** The named deployment, when one was named. Undefined for a private host. */
  readonly deployment: PredictAgentDeployment | undefined;
}

export interface StartOnboardingOptions extends DescribeOnboardingOptions {
  /** A human label so an owner can tell two agents apart in their list. */
  label?: string;
  /**
   * The console to send the owner to.
   *
   * Defaults to the one paired with this client's deployment. A private
   * deployment has no pairing, and this must then be supplied: a link to the
   * wrong console is worse than being told to go and find the right one.
   */
  consoleBaseUrl?: string;
  signal?: AbortSignal;
}

export interface OnboardingHandle {
  /**
   * The link to hand the owner. It confers no authority and carries no secret,
   * but it does name the agent wallet and any `label` or `accountId` given.
   */
  readonly url: string;
  /** The state as of now, before anybody has been asked to do anything. */
  readonly state: OnboardingState;
  /** True when the owner has already signed and there is nothing to wait for. */
  readonly ready: boolean;
  /**
   * Block until the grants land, printing progress through `onChange`.
   *
   * This is the half that was routinely skipped, and skipping it is what turns a
   * signature into a conversation: the agent prints a link, stops, and the
   * person has to come back and say they are done. Running out of time is not a
   * failure and cancels nothing — the result carries `timedOut` and the last
   * state, so a caller resumes by calling again.
   */
  wait(options?: WaitForAuthorizationOptions): Promise<AuthorizationWaitResult>;
}

/**
 * Build the link, read the state, and hand back the poll — in one call.
 *
 * The three steps were already here and were already exported. What was missing
 * was that they belonged together: a caller had to reach for
 * `PREDICT_AGENT_CONSOLE_ENDPOINTS`, then `buildAuthorizationUrl`, then
 * `describeOnboarding`, then `waitForAuthorization`, and a caller who assembled
 * the first three and stopped had built an onboarding that ends in a dead
 * terminal. Handing back a `wait()` alongside the URL is what makes the poll
 * the obvious next thing rather than a fourth import.
 */
export async function startOnboarding(
  client: OnboardingClient,
  options: StartOnboardingOptions = {},
): Promise<OnboardingHandle> {
  const consoleBaseUrl =
    options.consoleBaseUrl ??
    (client.deployment === undefined
      ? undefined
      : PREDICT_AGENT_CONSOLE_ENDPOINTS[client.deployment]);
  if (consoleBaseUrl === undefined) {
    throw new TypeError(
      'This client names no deployment, so there is no console paired with it. Pass `consoleBaseUrl` for the deployment you are on — guessing one would send an owner somewhere else to sign.',
    );
  }

  const describeOptions =
    options.accountId === undefined ? {} : { accountId: options.accountId };
  const state = describeOnboarding(
    await client.listAuthorizedAccounts(options.signal),
    describeOptions,
  );
  const url = buildAuthorizationUrl({
    consoleBaseUrl,
    agentWallet: client.agentWallet,
    ...(options.label !== undefined ? { label: options.label } : {}),
    ...(options.accountId !== undefined ? { accountId: options.accountId } : {}),
  });

  return {
    url,
    state,
    ready: state.status === 'READY',
    wait: async (waitOptions: WaitForAuthorizationOptions = {}) =>
      await waitForAuthorization(client, { ...describeOptions, ...waitOptions }),
  };
}
