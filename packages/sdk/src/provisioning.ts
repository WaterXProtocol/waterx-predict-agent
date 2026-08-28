/**
 * What must exist before this runtime may trade, who supplies each one, and how
 * an installation finds out which of them it is still missing.
 *
 * This is the answer to the question every caller asks first and no published
 * surface could answer: `npm install` succeeded, so what now? Six facts stand
 * between a fresh install and an order, they are supplied by two different
 * people, and three of them are knowable without a network — which is the whole
 * reason this can run with no configuration at all.
 *
 * Two of them are deliberately NOT on the list, because a person supplying them
 * would be a design failure rather than a step: the API hostname, which the SDK
 * already ships (`PREDICT_AGENT_ENDPOINTS`), and the account id, which the
 * server answers for (`listAuthorizedAccounts`). Asking a human to copy either
 * one out of a browser is friction with no security value — the whole of the
 * onboarding work was removing exactly that.
 *
 * Three states, and the third is the load-bearing one. `MISSING` is a fact:
 * nothing supplied this and nothing will until someone does. `UNCHECKED` means
 * this installation could not evaluate it — a delegation cannot be read without
 * a base URL, a signer and a session, and reporting it as missing would be a
 * claim about a server nobody talked to. Collapsing UNCHECKED into MISSING is
 * how an owner gets asked to re-sign a grant they already signed, and how they
 * conclude the product is broken (`describeOnboarding` refuses the same
 * collapse for the same reason).
 *
 * The two owner-authenticated requirements are here to be REPORTED, never
 * attempted. A delegation and a risk profile are written through an owner
 * session (ADR-0003), and an agent runtime that could provision its own mandate
 * would be an agent runtime with no mandate. Listing them as ordinary missing
 * configuration would invite exactly that.
 *
 * `packages/e2e/src/gaps.ts` holds the same idea scoped to a test run: it is a
 * superset, carrying the three gaps only a harness has (an owner address to
 * check attribution against, a Runner somebody started, a restart command). The
 * overlap is deliberate and the direction is one way — that harness ships to
 * nobody, and this list is the one a consumer can reach.
 */
import type { OnboardingActor } from './onboarding.ts';

/** The half of {@link OnboardingActor} that can supply something. */
export type RequirementSupplier = Exclude<OnboardingActor, 'NOBODY'>;

export const REQUIREMENT_IDS = [
  'deployment',
  'agentWallet',
  'signer',
  'authorizedAccount',
  'delegation',
  'riskProfile',
] as const;

export type RequirementId = (typeof REQUIREMENT_IDS)[number];

/**
 * `UNCHECKED` is not a soft `MISSING`. It says this caller had no way to look,
 * and it is the only honest answer for anything behind an authenticated read.
 */
export type RequirementState = 'SATISFIED' | 'MISSING' | 'UNCHECKED';

export interface AgentRequirement {
  readonly id: RequirementId;
  readonly title: string;
  readonly suppliedBy: RequirementSupplier;
  /**
   * True when supplying it needs an owner-authenticated session. Nothing in
   * this package may attempt one, and automation that did would be defeating
   * the control rather than implementing it.
   */
  readonly ownerAuthenticated: boolean;
  /** Why nothing trades without it. */
  readonly why: string;
  /** The concrete ways to supply it, most direct first. */
  readonly supplyWith: readonly string[];
  /** What settles it, so a caller can verify rather than believe. */
  readonly settledBy: string;
}

export interface ResolvedRequirement extends AgentRequirement {
  readonly state: RequirementState;
  /**
   * What the state was decided from, in one line.
   *
   * A bare `MISSING` is unactionable and, worse, arguable: a caller who passed
   * a signer to the constructor and reads `MISSING` concludes the report is
   * wrong rather than that it was looking at the environment.
   */
  readonly evidence: string;
  /** Present on `UNCHECKED`: what stopped this caller from looking. */
  readonly unresolved?: string;
}

/**
 * The six, in the order they have to arrive.
 *
 * Ordering is not presentation. An agent wallet with no base URL authenticates
 * nowhere, and an owner cannot grant a delegation to an agent whose address
 * nobody has yet. A list that read best-first would have people opening an
 * authorization link before they had an address to put in it.
 */
export const AGENT_REQUIREMENTS: readonly AgentRequirement[] = [
  {
    id: 'deployment',
    title: 'Which deployment this is',
    suppliedBy: 'AGENT_OPERATOR',
    ownerAuthenticated: false,
    why: 'Testnet or production — the difference between practice money and real money. Nobody should be typing a hostname for it: the SDK ships every host it talks to, and a host that differs from the intended one by a hyphen is a silent failure. What cannot be supplied for you is WHICH network, because a default would either break a production caller or point a first experiment at real funds.',
    supplyWith: [
      "new PredictAgentClient({ deployment: 'testnet', signer })",
      'WATERX_PREDICT_ENVIRONMENT=testnet (the CLI resolves the host from it)',
      'A private or preview deployment has no name: pass `baseUrl` / WATERX_PREDICT_BASE_URL',
    ],
    settledBy: 'A client that authenticates, and the console URL `runtime.onboard` prints.',
  },
  {
    id: 'agentWallet',
    title: 'Agent wallet address',
    suppliedBy: 'AGENT_OPERATOR',
    ownerAuthenticated: false,
    why: 'The address this agent authenticates as, and the one an owner grants the delegation to. It is what the authorization link carries.',
    supplyWith: [
      'The address of the keypair behind the signer passed to PredictAgentClient',
      'WATERX_PREDICT_AGENT_WALLET=0x… (the CLI, which never holds the key itself)',
    ],
    settledBy: 'An authenticated session. The private key behind it appears nowhere, here or anywhere else.',
  },
  {
    id: 'signer',
    title: 'A signer for that wallet',
    suppliedBy: 'AGENT_OPERATOR',
    ownerAuthenticated: false,
    why: 'Authentication signs a challenge and an order signs sponsored transaction bytes. Without a signer the client cannot open a session, let alone trade.',
    supplyWith: [
      'PredictAgentClientOptions.signer — a Sui Keypair satisfies it structurally',
      'WATERX_PREDICT_SIGNER_COMMAND=/path/to/signer (the CLI spawns it; no key enters that process)',
    ],
    settledBy: 'A session that opens. `runtime.doctor` settles it as the `signer` and `authentication` checks.',
  },
  {
    id: 'authorizedAccount',
    title: 'An account this agent may trade on',
    suppliedBy: 'ACCOUNT_OWNER',
    ownerAuthenticated: true,
    why: 'Orders are placed on an account, and this agent may only use one an owner has granted it. It is never chosen here and never carried over from a previous session.',
    supplyWith: [
      'The owner authorizes this agent at the console link — after which listAuthorizedAccounts() answers, and nobody copies an id anywhere',
    ],
    settledBy: 'listAuthorizedAccounts() returning it, or `runtime.onboard` reporting READY.',
  },
  {
    id: 'delegation',
    title: 'An on-chain delegation to the agent wallet',
    suppliedBy: 'ACCOUNT_OWNER',
    ownerAuthenticated: true,
    why: 'The on-chain permission for this wallet to act for that account. This is the one irreducibly human step: the owner signs it with their own wallet, and no tooling here may do it for them (ADR-0003).',
    supplyWith: ['The owner signs it in their own session, at the authorization link'],
    settledBy: 'delegation.mayPlaceOrder === true on the account. `null` means the chain read FAILED — that is UNKNOWN, not a refusal.',
  },
  {
    id: 'riskProfile',
    title: "The owner's risk profile for this agent",
    suppliedBy: 'ACCOUNT_OWNER',
    ownerAuthenticated: true,
    why: 'The mandate every write is checked against: allowance, per-order size, rolling windows, in-flight cap. Absent, the server refuses each write with NO_RISK_PROFILE.',
    supplyWith: ['The owner sets the limits in the same authorized session as the delegation'],
    settledBy: 'account.risk-limits reporting limits rather than an absence. This agent may read them and can never raise them.',
  },
];

/** By id, for a caller resolving one requirement rather than the list. */
export const requirementFor = (id: RequirementId): AgentRequirement => {
  const found = AGENT_REQUIREMENTS.find((requirement) => requirement.id === id);
  /* c8 ignore next 2 -- unreachable while RequirementId is derived from the list */
  if (found === undefined) throw new Error(`No requirement is declared for ${id}.`);
  return found;
};

/**
 * The one thing to do next.
 *
 * Worst-first by supplier, not by list order: an operator cannot fix an owner's
 * step by trying harder, so an operator gap is always reported ahead of an owner
 * gap even when the owner's comes first in the sequence. An installation with no
 * base URL is told to set a base URL, not to go and find its account owner.
 */
export function nextStepFor(resolved: readonly ResolvedRequirement[]): {
  actor: OnboardingActor;
  action: string;
} {
  const missing = resolved.filter((requirement) => requirement.state === 'MISSING');
  const operator = missing.find((requirement) => requirement.suppliedBy === 'AGENT_OPERATOR');
  if (operator !== undefined) {
    return {
      actor: 'AGENT_OPERATOR',
      action: `Supply the ${operator.title}: ${operator.supplyWith[0] ?? ''}`,
    };
  }
  const owner = missing[0];
  if (owner !== undefined) {
    return {
      actor: 'ACCOUNT_OWNER',
      action: `${owner.title} is the owner's to supply: ${owner.supplyWith[0] ?? ''}`,
    };
  }
  const unchecked = resolved.filter((requirement) => requirement.state === 'UNCHECKED');
  if (unchecked.length > 0) {
    return {
      actor: 'AGENT_OPERATOR',
      // Deliberately not "you are ready". Everything locally knowable is
      // supplied and the rest was never looked at; saying ready here is how a
      // caller reports an agent as onboarded before an owner has granted it
      // anything.
      action: `Local setup is complete. ${String(unchecked.length)} requirement(s) need an authenticated read — run \`waterx-predict onboard\`, or call listAuthorizedAccounts().`,
    };
  }
  return { actor: 'NOBODY', action: '' };
}
