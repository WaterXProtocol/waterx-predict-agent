/**
 * `doctor`'s answer to "what is missing, and who fixes it".
 *
 * The checks say what happened. This says what to do about it, and the
 * difference matters most to the reader who is not a person: a check that reads
 * `signer FAIL — no signer command is configured` is a sentence an agent has to
 * parse into an action, while a requirement carries the supplier, the reason and
 * the ways to supply it as fields.
 *
 * The list itself lives in the SDK (`AGENT_REQUIREMENTS`), which is deliberate.
 * The same six facts are what `describeInstallation()` reports before anything
 * is configured, so an agent that has only the library and an operator running
 * `doctor` are answered from one list rather than two that drift. All this file
 * does is settle them with what a configured CLI additionally knows — which is
 * three more of them, because it can authenticate.
 *
 * What it does NOT do is turn an owner's outstanding grant into a `doctor`
 * failure. A machine whose configuration and signer are sound, waiting on a
 * delegation nobody has signed yet, is not a broken machine; reporting it as one
 * conflates "your setup is wrong" with "your owner has not signed yet", and
 * those are different actions by different people. The exit code keeps meaning
 * the first thing, and `nextStep` says the second.
 */
import {
  AGENT_REQUIREMENTS,
  type OnboardingState,
  type RequirementId,
  type ResolvedRequirement,
} from '@waterx/predict-agent-sdk';

import type { ResolvedConfig } from './config.ts';
import { describeSigner } from './signer.ts';

/** Why the three owner-side requirements could not be settled, when they could not. */
export type AuthorizationUnknown = string;

const settled = (
  requirement: (typeof AGENT_REQUIREMENTS)[number],
  state: ResolvedRequirement['state'],
  evidence: string,
  unresolved?: string,
): ResolvedRequirement =>
  unresolved === undefined
    ? { ...requirement, state, evidence }
    : { ...requirement, state, evidence, unresolved };

/**
 * The three a local configuration settles, and the three an authenticated read
 * does.
 *
 * `onboarding` is `undefined` when no listing was obtained — no client, or the
 * call failed. That produces `UNCHECKED`, never `MISSING`: the three facts
 * behind it are an owner's, and reporting one absent on no evidence sends a
 * person to re-sign a grant they may already have made.
 */
export function resolveRequirements(
  config: ResolvedConfig,
  onboarding: OnboardingState | undefined,
  unknownBecause: AuthorizationUnknown | undefined,
): ResolvedRequirement[] {
  const signer = describeSigner(config);

  const local: Partial<Record<RequirementId, { supplied: boolean; evidence: string }>> = {
    deployment: {
      supplied: config.baseUrl !== undefined,
      evidence:
        config.baseUrl === undefined
          ? 'Neither a deployment name nor a host is configured.'
          : config.environment === undefined
            ? `A host is configured${config.configPath === null ? ' from the environment' : ` from ${config.configPath}`}, with no deployment name — treated as production.`
            : // The normal case: a name, and the host resolved from it. Nobody
              // typed a hostname, which is the point.
              `Deployment \`${config.environment}\`.`,
    },
    agentWallet: {
      supplied: config.agentWallet !== undefined,
      evidence:
        config.agentWallet === undefined
          ? 'No agent wallet address is configured.'
          : 'An agent wallet address is configured.',
    },
    signer: {
      supplied: signer.configured,
      evidence: signer.configured
        ? 'An external signer command is configured; no key enters this process.'
        : 'No signer command is configured.',
    },
  };

  return AGENT_REQUIREMENTS.map((requirement) => {
    const known = local[requirement.id];
    if (known !== undefined) {
      return settled(requirement, known.supplied ? 'SATISFIED' : 'MISSING', known.evidence);
    }

    if (onboarding === undefined) {
      return settled(
        requirement,
        'UNCHECKED',
        unknownBecause ?? 'The authorized-account listing was not read.',
        'Run `waterx-predict onboard` once the configuration above is complete.',
      );
    }

    const { accounts, status } = onboarding;

    // Nothing listed means the owner has written no mandate for this agent, and
    // the delegation and the risk profile go with it: the listing is built FROM
    // the owner's risk profiles, so an empty one is not a partial answer.
    if (accounts.length === 0) {
      return settled(
        requirement,
        'MISSING',
        'The server listed no account for this agent, so nothing has been granted to it yet.',
      );
    }

    if (requirement.id === 'riskProfile') {
      return settled(
        requirement,
        'SATISFIED',
        `The owner has written a mandate on ${String(accounts.length)} account(s); \`account risk-limits\` reads the effective figures.`,
      );
    }

    if (requirement.id === 'delegation') {
      if (accounts.some((account) => account.delegation.mayPlaceOrder === true)) {
        return settled(requirement, 'SATISFIED', 'An on-chain delegation permits this agent to place orders.');
      }
      // A null permission is a FAILED chain read. Calling that missing is how an
      // owner is asked to sign a grant they already signed, and how they
      // conclude the product is broken.
      if (accounts.some((account) => account.delegation.mayPlaceOrder === null)) {
        return settled(
          requirement,
          'UNCHECKED',
          'The on-chain delegation could not be read. That is not a refusal.',
          'Retry before asking the owner for anything.',
        );
      }
      return settled(
        requirement,
        'MISSING',
        'The mandate exists but no on-chain delegation does. Only the owner can sign one.',
      );
    }

    // authorizedAccount: answerable exactly when the runtime can name one
    // without a person choosing. Two ready accounts is not a gap in what the
    // owner granted — it is a decision about whose money trades, and this
    // runtime does not make it.
    if (status === 'READY') {
      return settled(requirement, 'SATISFIED', 'One authorized account resolved, with no id copied by hand.');
    }
    return settled(
      requirement,
      'MISSING',
      `${status}: ${onboarding.nextStep.action}`,
    );
  });
}
