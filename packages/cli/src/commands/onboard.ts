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
 * The link confers no authority: it names the agent wallet and carries no
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
import { qrLines } from '../qr.ts';
import { CLI_NAME } from '../version.ts';
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
export function pairedConsoleUrl(context: CommandContext): string | undefined {
  const explicit = context.input.consoleUrl;
  if (typeof explicit === 'string' && explicit !== '') return explicit;
  if (context.config.consoleUrl !== undefined) return context.config.consoleUrl;

  const baseUrl = context.config.baseUrl;
  for (const [name, apiUrl] of Object.entries(PREDICT_AGENT_ENDPOINTS)) {
    if (baseUrl === apiUrl) {
      return PREDICT_AGENT_CONSOLE_ENDPOINTS[name as keyof typeof PREDICT_AGENT_CONSOLE_ENDPOINTS];
    }
  }
  return undefined;
}

function consoleUrlFor(context: CommandContext): string {
  const paired = pairedConsoleUrl(context);
  if (paired !== undefined) return paired;
  const baseUrl = context.config.baseUrl;
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
  direct: boolean,
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
      ...(direct
        ? [
            'Direct mode (ADR-0013): the on-chain delegation is the whole grant. The page’s limits step writes to the agent API, which this mode does not use — if that step fails after the wallet signed, the agent is still authorized, and its spending ceiling is this runtime’s execution policy.',
          ]
        : []),
    ],
  };
}

const DIRECT_POLL_MS = 15_000;

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

  // Announced before ANY request, and on stderr. The link is built from the
  // agent address and the console URL, both of which are local — so an
  // authentication failure must not take it down with it. An operator whose
  // session is broken still needs the link they came here for, and the owner
  // they send it to can sign long before that gets fixed.
  //
  // stdout stays one JSON document, which is why this goes to stderr.
  context.diagnostic(
    context.config.mode === 'direct'
      ? `Authorize this agent by opening:\n  ${authorizationUrl}\nThe account owner picks an account and signs the delegation once. That signature is the whole grant in direct mode.\n`
      : `Authorize this agent by opening:\n  ${authorizationUrl}\nThe page asks the account owner to pick an account, set the limits and sign once.\n`,
  );

  // The code, under the link rather than instead of it: whoever is at this
  // terminal may be the one who signs, and a link they can click beats a code
  // they cannot. `--qr` is for the case this arrangement is actually built for
  // — the owner is somewhere else, with their wallet on a phone (ADR-0024).
  if (context.wantsQr) {
    const drawn = qrLines(authorizationUrl);
    if (drawn === undefined) {
      context.diagnostic('The link is too long to draw as a QR code here. Send it as text.\n');
    } else {
      // One line at a time: a diagnostic is truncated past 2000 characters,
      // which is a sensible cap for a sentence and would cut a code in half.
      context.diagnostic('\n');
      for (const line of drawn) context.diagnostic(`${line}\n`);
      context.diagnostic('  Scan it with the phone the owner\u2019s wallet is on.\n');
    }
  }

  // The page opens by ITSELF, and the link is printed first so a machine with
  // no browser loses nothing. Four things stop it, and each says which in one
  // line rather than silently doing nothing (ADR-0024):
  //
  //   - `--no-open`, for this run;
  //   - the environment says not to, or this host cannot;
  //   - this exact link was already opened here — `onboard --wait` is run again
  //     constantly, and a five-minute wait should not end in twenty tabs;
  //   - the opener failed, which is reported and stepped over. The link is
  //     above and just as valid; failing the command because a window did not
  //     appear would throw away the answer the caller asked for.
  //
  // `--open` overrides the memory: it is the "I am here, open it now" button.
  const browser = context.browser;
  const refusal = browser.suppressed
    ? '--no-open'
    : browser.refusedBecause !== undefined
      ? browser.refusedBecause
      : browser.open === undefined
        ? 'this build has no way to open a browser'
        : !browser.forced && browser.openedRecently(authorizationUrl)
          ? 'already opened here \u2014 `--open` opens it again'
          : undefined;
  if (refusal !== undefined) {
    context.diagnostic(`Not opening a browser (${refusal}).\n`);
  } else if (browser.open !== undefined) {
    try {
      browser.open(authorizationUrl);
      browser.remember(authorizationUrl);
      context.diagnostic('Opening it in your browser. `--no-open` is how a person here says not to.\n');
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : 'the opener failed';
      context.diagnostic(`Not opening a browser (${reason}). Open the link above yourself.\n`);
    }
  }
  if (!context.wantsQr) {
    // Named where an agent reads, not only in `--help`: an option nothing
    // mentions is one nobody can relay (ADR-0024).
    context.diagnostic('If the owner is not at this machine, `onboard --qr` draws the link as a code they can scan.\n');
  }

  const client = await context.client();

  /**
   * Where to go from here (ADR-0022).
   *
   * Until the grant lands, the command to run next is this one WITH `--wait`:
   * it prints the link, waits for the owner and adopts the account. It is the
   * AGENT's command even though the signature is the owner's — the two attach
   * to different people, and a screen that named only the owner is where one
   * real session stopped without ever producing a link.
   */
  const pointOnward = (status: string): void => {
    if (status !== 'READY') context.pointTo(`${CLI_NAME} onboard --wait`);
  };

  if (context.input.wait !== true) {
    const state = describeOnboarding(await client.listAuthorizedAccounts(context.signal()), scope);
    pointOnward(state.status);
    return render(state, authorizationUrl, agentWallet, false, context.config.mode === 'direct');
  }

  const timeoutMs = typeof context.input.timeoutMs === 'number' ? context.input.timeoutMs : DEFAULT_WAIT_MS;
  const result = await waitForAuthorization(client, {
    ...scope,
    timeoutMs,
    // The public delegation listing starts fresh chain reads on every call and
    // allows 300 an hour per IP. Every 15 s stays inside it with room for the
    // person running other commands.
    ...(context.config.mode === 'direct' ? { pollIntervalMs: DIRECT_POLL_MS } : {}),
    // Wide enough for the wait itself, plus one slow read at its end. The
    // default request deadline would otherwise end a long wait early, as an
    // error, while the owner was still signing.
    signal: context.signal(timeoutMs + 30_000),
    // Progress on stderr as it changes, so a person watching a terminal is not
    // staring at nothing for ten minutes.
    onChange: (state) => {
      context.diagnostic(
        state.status === 'READY'
          ? // "May now trade" is false under a read-only policy, which is the
            // default on mainnet (ADR-0017) — and the moment after the owner
            // signs is exactly when the operator's own choice is due
            // (ADR-0025). Two separate permissions, said as two.
            context.config.policy.mode === 'read-only'
            ? 'Authorized. This runtime still places no order: its execution policy is read-only, which is the operator\u2019s to change. Run `waterx-predict next` \u2014 it shows the three modes and what each allows.\n'
            : 'Authorized. This agent may now trade on the account below.\n'
          : context.config.mode === 'direct' && state.status === 'NOT_ONBOARDED'
            ? 'Waiting — NOT_ONBOARDED: the owner opens the link, picks an account and signs the delegation.\n'
            : `Waiting — ${state.status}: ${state.nextStep.action}\n`,
      );
    },
  });
  // A wait that ran out is not a refusal: the owner may sign a minute later,
  // and resuming means calling this again.
  pointOnward(result.status);
  return render(result, authorizationUrl, agentWallet, result.timedOut, context.config.mode === 'direct');
}
