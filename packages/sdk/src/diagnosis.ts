/**
 * One call that answers "may this agent trade right now, and if not, who has to
 * do what" — with the write gate named correctly.
 *
 * TWO REPORTS THAT WERE HALVES OF ONE QUESTION. `describeInstallation()` runs
 * offline and therefore reports the three owner-side requirements `UNCHECKED`;
 * `describeOnboarding()` settles exactly those three but knows nothing about
 * the local half. A caller who wanted the actual answer had to obtain both,
 * reconcile them, and build the authorization link out of a third module. That
 * is three imports and a merge for the first question anybody asks, and the
 * merge is where a caller gets it wrong — reporting an agent as onboarded when
 * only the local half is satisfied, or as blocked when nothing was checked.
 *
 * WHAT ACTUALLY GATES A WRITE, because this is the correction at the centre of
 * this module. A caller holding only `@waterx/predict-agent-sdk` writes through
 * `executeMarketOrder`, which reaches the API directly. The API admits or
 * refuses that write on the strength of the account owner's ON-CHAIN
 * DELEGATION and their risk profile — `DELEGATION_REVOKED`,
 * `DELEGATION_PERMISSION_DENIED`, `RISK_LIMIT_EXCEEDED`, all of them in
 * `PredictAgentErrorCode`.
 *
 * The `interactive` execution policy, its per-intent approval token and its
 * `POLICY_DENIED` refusal are none of those. They are a guardrail enforced
 * INSIDE the `waterx-predict` command core, in that process, over its own
 * signer — `POLICY_DENIED` is not an API error code and never appears on this
 * wire. A library caller is not subject to it, and telling one that it is
 * produces the specific failure this module was written after: an agent that
 * warns its user the order will probably be refused, places it successfully,
 * and then has to retract the warning.
 *
 * So `writes.gatedBy` says `ON_CHAIN_DELEGATION`, and it says it as a checked
 * fact — `delegation.mayPlaceOrder` read from the server — rather than as an
 * inference from what is on PATH. Absence of the CLI is reported for what it
 * is: composed commands and the approval flow are out of reach. It is not
 * evidence about whether this agent may trade.
 *
 * THIS ONE OPENS A SESSION. Everywhere else in this client the first session is
 * explicit, because a read that silently authenticates is a surprise. Here the
 * question IS "am I able to talk to the server and what does it say about me",
 * so a diagnosis that refused to authenticate would answer it with an error
 * about not having authenticated. It does so only when no session is held, and
 * the report says whether it did (`authenticatedHere`).
 */
import type {
  ListAgentAccountsResponseBody,
  PredictAgentDeployment,
  PredictEffectiveLimitsResponseBody,
} from './contract.ts';
import {
  describeInstallation,
  type DescribeInstallationOptions,
  type InstallationReport,
} from './installation.ts';
import {
  buildAuthorizationUrl,
  describeOnboarding,
  type OnboardingActor,
  type OnboardingState,
  PREDICT_AGENT_CONSOLE_ENDPOINTS,
} from './onboarding.ts';
import type { RequirementId, ResolvedRequirement } from './provisioning.ts';

/**
 * Why a write would be admitted or refused, in the terms the API actually uses.
 *
 * `DELEGATION_UNKNOWN` is kept separate for the same reason
 * `describeOnboarding` keeps it separate: a failed chain read is not a refusal,
 * and sending an owner to re-sign a grant they already signed is worse than
 * saying "we could not check".
 */
export type WriteGateStatus =
  | 'DELEGATED'
  | 'NOT_ONBOARDED'
  | 'DELEGATION_MISSING'
  | 'DELEGATION_UNKNOWN'
  | 'SUSPENDED'
  | 'AMBIGUOUS_ACCOUNT';

export interface WriteGate {
  readonly status: WriteGateStatus;
  /**
   * Whether a write would be admitted. `undefined` ONLY when the chain read
   * failed — never as a stand-in for "probably not".
   */
  readonly permitted: boolean | undefined;
  /**
   * What decides it. One value today, and it is named rather than implied so
   * that a caller reading this report cannot mistake it for the CLI's
   * execution policy, which does not apply here.
   */
  readonly gatedBy: 'ON_CHAIN_DELEGATION';
  /** The API error codes a refusal would arrive as, if it is refused. */
  readonly refusesWith: readonly string[];
  readonly detail: string;
}

export interface AgentDiagnosis {
  /** The local half: deployment, wallet, signer, and which surfaces exist here. */
  readonly installation: InstallationReport;
  /** The server's half: which accounts, whose delegation, what state. */
  readonly onboarding: OnboardingState;
  /**
   * All six requirements, none of them `UNCHECKED`.
   *
   * This is the difference from `describeInstallation()` alone, and the reason
   * this call exists: the three the offline report cannot settle are settled
   * here, from the same authenticated read that produced `onboarding`.
   */
  readonly requirements: readonly ResolvedRequirement[];
  readonly writes: WriteGate;
  /** True only when a write would be admitted right now. */
  readonly ready: boolean;
  /** The link to hand the owner. Present whenever the owner still has to act. */
  readonly authorizationUrl: string | undefined;
  /**
   * The mandate this agent trades under, when there is one to read.
   *
   * Fetched because "may I trade" and "how much may I trade" are asked in the
   * same breath, and the second one cost a caller another module, another
   * script and another round trip. Absent when not READY, or when the caller
   * turned it off, or when the read itself failed — which is reported rather
   * than thrown, since a missing limits read must not turn a successful
   * diagnosis into an error.
   */
  readonly limits: PredictEffectiveLimitsResponseBody | undefined;
  readonly limitsError: string | undefined;
  /** True when this call opened the session rather than finding one. */
  readonly authenticatedHere: boolean;
  readonly nextStep: { actor: OnboardingActor; action: string };
}

/** The slice of the client a diagnosis needs. Kept narrow so it is testable. */
export interface DiagnosableClient {
  readonly baseUrl: string;
  readonly deployment: PredictAgentDeployment | undefined;
  readonly agentWallet: string;
  isAuthenticated(): boolean;
  authenticate(): Promise<unknown>;
  listAuthorizedAccounts(signal?: AbortSignal): Promise<ListAgentAccountsResponseBody>;
  getEffectiveLimits(
    accountId: string,
    signal?: AbortSignal,
  ): Promise<PredictEffectiveLimitsResponseBody>;
}

export interface DiagnoseOptions extends DescribeInstallationOptions {
  /** Narrow to one account, exactly as `describeOnboarding` does. */
  readonly accountId?: string;
  /** A human label for the authorization link, so an owner can tell agents apart. */
  readonly label?: string;
  /**
   * The console to send the owner to. Defaults to the one paired with this
   * client's deployment; a private deployment has no pairing and must pass one,
   * or no link is offered rather than a wrong one being guessed.
   */
  readonly consoleBaseUrl?: string;
  /** Read the risk profile when READY. Default `true`. */
  readonly includeLimits?: boolean;
  readonly signal?: AbortSignal;
}

/** Requirements the authenticated read settles. The offline report cannot. */
const OWNER_REQUIREMENTS: readonly RequirementId[] = [
  'authorizedAccount',
  'delegation',
  'riskProfile',
];

/**
 * The write gate, from the onboarding state.
 *
 * Every branch names the on-chain delegation as the thing that decides, and no
 * branch mentions an approval token: a library caller has no command core to
 * issue one and is not gated by one.
 */
function gateFor(state: OnboardingState): WriteGate {
  const gatedBy = 'ON_CHAIN_DELEGATION' as const;
  switch (state.status) {
    case 'READY':
      return {
        status: 'DELEGATED',
        permitted: true,
        gatedBy,
        refusesWith: [],
        detail:
          'The owner has signed an on-chain delegation for this agent wallet and the mandate is active, so `executeMarketOrder` may write. What still bounds it is the risk profile: allowance, per-order size and the rolling windows, none of which this agent can raise.',
      };
    case 'AMBIGUOUS':
      return {
        status: 'AMBIGUOUS_ACCOUNT',
        permitted: true,
        gatedBy,
        refusesWith: [],
        detail:
          'More than one authorized account is ready. A write would be admitted on any of them, so this SDK will not pick — name the account and the gate opens with no further signature.',
      };
    case 'SUSPENDED':
      return {
        status: 'SUSPENDED',
        permitted: false,
        gatedBy,
        refusesWith: ['DELEGATION_PERMISSION_DENIED'],
        detail:
          'The owner suspended this agent. Only they can lift it, and re-signing a delegation will not.',
      };
    case 'DELEGATION_UNKNOWN':
      return {
        status: 'DELEGATION_UNKNOWN',
        permitted: undefined,
        gatedBy,
        refusesWith: [],
        detail:
          'The on-chain delegation could not be read, so nothing is known either way. This is a transient condition, not a refusal — retry before telling anyone their agent is unauthorized.',
      };
    case 'DELEGATION_MISSING':
      return {
        status: 'DELEGATION_MISSING',
        permitted: false,
        gatedBy,
        refusesWith: ['DELEGATION_REVOKED', 'DELEGATION_PERMISSION_DENIED'],
        detail:
          'The mandate exists but no on-chain delegation does. The owner signs it in their own wallet; nothing here may sign it for them (ADR-0003).',
      };
    case 'NOT_ONBOARDED':
    default:
      return {
        status: 'NOT_ONBOARDED',
        permitted: false,
        gatedBy,
        refusesWith: ['DELEGATION_PERMISSION_DENIED'],
        detail:
          'No account has authorized this agent wallet, so there is no account to place an order on. One signature at the console link creates all three of the owner-side requirements at once.',
      };
  }
}

/** Settle the three owner-side requirements from what the server just said. */
function settleOwnerRequirements(
  requirements: readonly ResolvedRequirement[],
  state: OnboardingState,
  gate: WriteGate,
): readonly ResolvedRequirement[] {
  return requirements.map((requirement) => {
    if (!OWNER_REQUIREMENTS.includes(requirement.id)) return requirement;
    const { unresolved: _dropped, ...rest } = requirement;

    if (requirement.id === 'authorizedAccount') {
      return state.accounts.length > 0
        ? {
            ...rest,
            state: 'SATISFIED' as const,
            evidence: `listAuthorizedAccounts() returned ${String(state.accounts.length)} account(s).`,
          }
        : {
            ...rest,
            state: 'MISSING' as const,
            evidence: 'listAuthorizedAccounts() returned no accounts for this agent wallet.',
          };
    }

    if (requirement.id === 'delegation') {
      if (gate.permitted === undefined) {
        return {
          ...rest,
          state: 'UNCHECKED' as const,
          evidence: 'delegation.mayPlaceOrder is null — the chain read failed.',
          unresolved:
            'Not a refusal. Retry the read; only if it stays null is this worth reporting to anyone.',
        };
      }
      return gate.permitted
        ? {
            ...rest,
            state: 'SATISFIED' as const,
            evidence: 'delegation.mayPlaceOrder === true on the account this agent would trade.',
          }
        : {
            ...rest,
            state: 'MISSING' as const,
            evidence: `The delegation does not permit orders (${gate.status}).`,
          };
    }

    // riskProfile. The server withholds accounts with no mandate, so an account
    // that came back at all has one; whether its ceilings suit a given order is
    // `getEffectiveLimits`, not this.
    return state.accounts.length > 0
      ? {
          ...rest,
          state: 'SATISFIED' as const,
          evidence:
            'The account was returned with a policy version, so a risk profile exists. Its ceilings are in `getEffectiveLimits`.',
        }
      : {
          ...rest,
          state: 'MISSING' as const,
          evidence: 'No account exists yet, so no risk profile does either.',
        };
  });
}

/**
 * Everything an agent needs before its first order, in one authenticated call.
 *
 * Two round trips at most: the account listing, and — when a write would be
 * admitted — the risk profile, because the caller is about to ask for it
 * anyway.
 */
export async function diagnose(
  client: DiagnosableClient,
  options: DiagnoseOptions = {},
): Promise<AgentDiagnosis> {
  // The local half declares what this caller supplied in code. A client exists,
  // so its endpoint, its wallet and its signer are all present by construction —
  // reporting them MISSING because no environment variable is set would be the
  // exact false negative `supplied` was added to prevent.
  const installation = describeInstallation({
    ...(options.env !== undefined ? { env: options.env } : {}),
    supplied: { deployment: true, agentWallet: true, signer: true, ...options.supplied },
  });

  const authenticatedHere = !client.isAuthenticated();
  if (authenticatedHere) await client.authenticate();

  const listing = await client.listAuthorizedAccounts(options.signal);
  const onboarding = describeOnboarding(
    listing,
    options.accountId === undefined ? {} : { accountId: options.accountId },
  );
  const gate = gateFor(onboarding);
  const requirements = settleOwnerRequirements(installation.requirements, onboarding, gate);

  const consoleBaseUrl =
    options.consoleBaseUrl ??
    (client.deployment === undefined ? undefined : PREDICT_AGENT_CONSOLE_ENDPOINTS[client.deployment]);
  // Offered whenever the owner still has something to do — and withheld for a
  // private deployment nobody paired a console with, because a link to the
  // wrong console is worse than no link.
  const authorizationUrl =
    gate.permitted === true || consoleBaseUrl === undefined
      ? undefined
      : buildAuthorizationUrl({
          consoleBaseUrl,
          agentWallet: client.agentWallet,
          ...(options.label !== undefined ? { label: options.label } : {}),
          ...(options.accountId !== undefined ? { accountId: options.accountId } : {}),
        });

  let limits: PredictEffectiveLimitsResponseBody | undefined;
  let limitsError: string | undefined;
  const account = onboarding.account;
  if ((options.includeLimits ?? true) && account !== undefined) {
    try {
      limits = await client.getEffectiveLimits(account.accountId, options.signal);
    } catch (error: unknown) {
      // Reported, not thrown. The diagnosis already succeeded, and failing it
      // here would tell a caller that a working, authorized agent is broken.
      limitsError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    installation,
    onboarding,
    requirements,
    writes: gate,
    ready: gate.permitted === true && onboarding.status === 'READY',
    authorizationUrl,
    limits,
    limitsError,
    authenticatedHere,
    // The onboarding state decides this: everything local is supplied by the
    // existence of a client, so anything left is the owner's or nobody's.
    nextStep: onboarding.nextStep,
  };
}
