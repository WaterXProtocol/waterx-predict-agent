/**
 * `next` — where does this agent stand, and what is the one thing to do now?
 *
 * The command an agent host loops on: run it, do what it says, run it again.
 * That loop is only safe if three things hold, and this module exists to hold
 * them rather than to be convenient:
 *
 * 1. **Every suggestion is a command in the contract.** A suggestion carries the
 *    contract name, the argv and the classification the contract gives it — never
 *    free text a model has to turn into an action. A host that executes what it
 *    is told can then only ever execute something `command-schema` describes,
 *    under the same policy, validation and approval as if it had chosen it. And
 *    every suggestion is one the AGENT may run: none of them is a write.
 *
 * 1b. **A step the agent may run itself is marked as such.** Setting up a
 *    runtime is not the same as trading it: creating an agent wallet that holds
 *    nothing and telling this runtime which wallet it is are both reversible,
 *    cost nothing, and authorize nothing. A host that had to relay those to a
 *    person could never finish its own setup — two real hosts stopped exactly
 *    there — so they come back as `agentSteps`, separate from the person's
 *    steps and never mixed into them (ADR-0020).
 *
 * 2. **A person's step stops the loop, and says so as data.** The owner's grant,
 *    the operator's choice of network, the user's choice of account: none of
 *    these is the agent's to supply. `stop: true` and `handOver` carry who must
 *    act and what to tell them, rather than a sentence a host might skim past. An
 *    agent runtime that could supply its own mandate would have no mandate
 *    (ADR-0003).
 *
 * 3. **Nothing new is offered beside something unsettled.** A non-terminal
 *    execution, or a Runner job whose order has an unknown outcome, outranks
 *    every later state. Offering a fresh order next to an order of unknown
 *    outcome is how the same position gets opened twice, so the ORDER of the
 *    checks is a safety property, and it lives in `decideNext` where a test pins
 *    it.
 *
 * It is read-only. The one signature it can ask for is the login challenge, the
 * same personal message `doctor` and `onboard` sign; it places nothing, cancels
 * nothing, and sends the Runner nothing but a `strategy.list`.
 *
 * Every degraded state is an ANSWER, not an error: an unconfigured machine, an
 * unreachable API, an owner who has not signed. The exit code is 0 whenever an
 * answer was produced, and `state` says whether this agent may trade — a host
 * that treated "you are not set up yet" as a crash would never reach the step
 * that sets it up.
 */
import {
  buildAuthorizationUrl,
  describeOnboarding,
  isTerminalExecutionStatus,
  nextStepFor,
  PREDICT_AGENT_ENDPOINTS,
  type OnboardingState,
  type PredictEffectiveLimitsResponseBody,
  type PredictExecutionSummary,
  type PredictPositionSummary,
  type PredictTradingBlocker,
  type ResolvedRequirement,
} from '@waterx/predict-agent-sdk';
import { getCommand, type AgentCommandClassification } from '@waterx/predict-agent-schema';

import { isDirectClient, toEnvelopeError } from '../client.ts';
import { exposureNotes, type ExposureNote } from './exposure.ts';
import type { CommandContext } from '../context.ts';
import { CliError } from '../errors.ts';
import { ENV_KEYS } from '../config.ts';
import { resolveRequirements } from '../requirements.ts';
import { KEYSTORE_LAYOUT, KEYSTORE_SIGNER_COMMAND, type KeystoreProbe } from '../keystore-probe.ts';
import { isRunnerRefusal } from '../runner-ipc.ts';
import { CLI_VERSION } from '../version.ts';
import { pairedConsoleUrl } from './onboard.ts';

/* ── The answer ──────────────────────────────────────────────────────────── */

/**
 * Where this agent stands, worst-first.
 *
 * The order of this list is the order `decideNext` checks in, and it is not
 * presentation: a later state is never reported while an earlier one holds.
 */
export const NEXT_STATES = [
  /** Something only the operator can configure is absent. Nothing was sent. */
  'SETUP_INCOMPLETE',
  /** Configured, but no session opened: unreachable, or the challenge was refused. */
  'SESSION_FAILED',
  /** A read that settles authorization failed. Not a refusal — retry. */
  'AUTHORIZATION_UNKNOWN',
  /** The owner has not granted this agent anything, or has suspended it. */
  'AWAITING_OWNER',
  /** More than one account is ready; choosing one is choosing whose money trades. */
  'ACCOUNT_CHOICE_NEEDED',
  /** An account read failed, so "nothing is unsettled" cannot be claimed. */
  'ACCOUNT_UNREADABLE',
  /** An execution on this account has not reached a terminal state. */
  'UNSETTLED_EXECUTION',
  /** A Runner job's order has an unknown outcome, or live jobs sit on a Runner that is not driving. */
  'STRATEGY_NEEDS_ATTENTION',
  /** The owner's limits would refuse a new order right now. */
  'TRADING_BLOCKED',
  /** Nothing stands in the way. What to trade is the user's to say. */
  'READY',
] as const;

export type NextState = (typeof NEXT_STATES)[number];

/**
 * Who has to act before anything moves. `AGENT` is the only one that does not
 * stop the loop: the other two are people, and an agent that "helps" by acting
 * for them is acting with an authority nobody gave it.
 */
export type NextActor = 'AGENT' | 'AGENT_OPERATOR' | 'ACCOUNT_OWNER';

export interface NeededValue {
  /** An input field of the suggested command. Asserted by a test. */
  readonly field: string;
  /** Why the agent may not fill it in itself. */
  readonly why: string;
}

export interface NextSuggestion {
  /** A command name in the contract. Asserted by a test for every state. */
  readonly command: string;
  /**
   * The values already known, as the command's input. What a tool host sends:
   * it calls the command by name with this object, plus `needsFromUser`.
   */
  readonly input: Readonly<Record<string, string | true>>;
  /**
   * Everything after the binary name, carrying only values already known. Typed
   * flags where the command takes them, `--input <json>` where its input is
   * structured and has no top-level fields to flag.
   */
  readonly argv: readonly string[];
  /** For a person: `waterx-predict …`, with `<field>` where a value is still needed. */
  readonly invocation: string;
  /** Always `read`: `next` never hands an agent a write. */
  readonly classification: AgentCommandClassification;
  readonly why: string;
  /** Present when the user must choose values before this can run. */
  readonly needsFromUser?: readonly NeededValue[];
}

/** A setting only the operator can supply, and how. */
export interface NeededSetting {
  readonly requirement: string;
  readonly title: string;
  readonly supplyWith: readonly string[];
  readonly why: string;
}

/** One thing the operator runs, in order. */
export interface SetupStep {
  readonly run: string;
  readonly why: string;
}

/**
 * One thing the AGENT may run itself, in order.
 *
 * Kept a different type from `SetupStep` on purpose: the distinction is who is
 * allowed to act, and two lists that looked alike would be merged by the first
 * host in a hurry. Every one of these must be reversible, must move no funds and
 * must grant no authority — `safeBecause` is where that is argued, per step, so
 * a reviewer can check the claim rather than trust the list.
 */
export interface AgentSetupStep {
  readonly run: string;
  /** The contract command, when this step is one. Absent for the signer binary. */
  readonly command?: string;
  readonly why: string;
  readonly safeBecause: string;
}

/** What to tell the person who must act. Present exactly when `stop` is true. */
export interface HandOver {
  readonly to: Exclude<NextActor, 'AGENT'>;
  readonly message: string;
  /**
   * The operator's remaining steps as commands, in order, from what this
   * machine actually has. Present when there is a concrete path to give.
   */
  readonly steps?: readonly SetupStep[];
  /** The link an owner opens. It names this agent and grants nothing by itself. */
  readonly authorizationUrl?: string;
  readonly settings?: readonly NeededSetting[];
}

export interface NextAnswer {
  readonly state: NextState;
  readonly headline: string;
  readonly actor: NextActor;
  /** True when the loop must hand over to a person before doing anything else. */
  readonly stop: boolean;
  readonly handOver?: HandOver;
  /**
   * Setup steps the agent may run itself, in order, before asking again.
   *
   * Present whenever this machine has any. They are the agent's even when `stop`
   * is true: the person's step and these are independent, and doing these first
   * is usually what shortens the person's list.
   */
  readonly agentSteps?: readonly AgentSetupStep[];
  /**
   * What the agent may run, first one first. When `stop` is true these are what
   * it may run AFTER handing over — waiting for the person, or asking again.
   */
  readonly suggestions: readonly NextSuggestion[];
  /**
   * What the account is carrying, whatever state this is (ADR-0023).
   *
   * Rides on every state and changes none of them: a position nothing can price
   * matters whether this runtime is READY or halfway through setup. Absent when
   * there is nothing to say.
   */
  readonly notes?: readonly ExposureNote[];
}

/* ── The facts it is decided from ─────────────────────────────────────────── */

export type WritePosture =
  /** `--policy read-only`, or a configuration that says so. */
  | 'REFUSED'
  /** Interactive: a person approves each previewed order. */
  | 'NEEDS_APPROVAL'
  /** Delegated-auto, and the scope is still open. */
  | 'WITHIN_SCOPE'
  /** Delegated-auto, and its `notAfter` has passed. */
  | 'SCOPE_EXPIRED';

export interface StrategyGlance {
  readonly jobId: string;
  readonly state: string;
  readonly terminal: boolean;
}

export type RunnerGlance =
  | {
      readonly status: 'ANSWERED';
      readonly driving: boolean;
      readonly strategies: readonly StrategyGlance[];
    }
  /** No runtime directory, token or socket: there is no Runner here, which is normal. */
  | { readonly status: 'ABSENT' }
  /** Something is there and could not be read. Reported, never guessed through. */
  | { readonly status: 'UNREADABLE'; readonly code: string };

export type SessionFact =
  | { readonly ok: true }
  /**
   * `message` is the server's (or the signer's) own sentence, relayed rather
   * than interpreted: a deployment with the agent API switched off refuses the
   * login with a code that means something else, and only its message says so.
   */
  | { readonly ok: false; readonly code: string; readonly message: string };

export type AccountFact =
  | {
      /** Null in direct mode: there is no server-side mandate to read (ADR-0013). */
      readonly limits: PredictEffectiveLimitsResponseBody | null;
      readonly unsettled: readonly PredictExecutionSummary[];
      /**
       * The positions themselves, not a count. They were always fetched; what
       * was missing was anything that read them (ADR-0023).
       */
      readonly positions: readonly PredictPositionSummary[];
    }
  | { readonly failed: string };

export interface NextFacts {
  readonly requirements: readonly ResolvedRequirement[];
  /** The configured agent wallet, compared against the keystore's. */
  readonly agentWallet?: string;
  /** Where that wallet is written, as a phrase: " (from …)". */
  readonly agentWalletFrom?: string;
  /** Present when the keystore is, or could be, this runtime's signer. */
  readonly keystore?: KeystoreProbe;
  readonly writes: WritePosture;
  /** Read-only only because nothing was configured on mainnet (ADR-0017). */
  readonly readOnlyByDefault?: boolean;
  /** Direct mode (ADR-0013): the grant is the on-chain delegation alone. */
  readonly direct?: boolean;
  /** Absent when no session was attempted, because the local setup is incomplete. */
  readonly session?: SessionFact;
  /** Absent when the listing was not read; `failed` when the read failed. */
  readonly onboarding?: OnboardingState | { readonly failed: string };
  readonly authorizationUrl?: string;
  /** The account the caller named, if any. Carried into every re-ask. */
  readonly namedAccountId?: string;
  /** Present exactly when the onboarding state is READY. */
  readonly account?: AccountFact;
  /**
   * This invocation's clock, for the age of an unsettled order. Injected rather
   * than read here so `decideNext` stays pure; `new Date()` when absent.
   */
  readonly now?: Date;
  /**
   * Direct mode: the account this agent was trading on, against the one now
   * authorized. `CONFLICT` stops the loop — a different account is whose money
   * trades, and only someone naming it may switch.
   */
  readonly adoption?:
    | { readonly status: 'ADOPTED_NOW' | 'UNCHANGED' | 'SWITCHED_BY_NAME'; readonly accountId: string }
    | { readonly status: 'CONFLICT'; readonly adopted: string; readonly authorized: string }
    | { readonly status: 'UNRECORDED'; readonly reason: string };
  readonly runner?: RunnerGlance;
}

/* ── Building suggestions ────────────────────────────────────────────────── */

const BINARY = 'waterx-predict';

/** Leaves the characters an id or a decimal is made of alone, and quotes the rest. */
const shellWord = (value: string): string =>
  /^[\w.:/@=+-]+$/u.test(value) ? value : `'${value.replace(/'/gu, `'\\''`)}'`;

/**
 * One suggestion, checked against the contract as it is built.
 *
 * A name that is not in the contract, or a write, is a bug in this module and is
 * thrown rather than rendered: a host told to run a command that does not exist
 * either fails or, worse, improvises one — and one told to run a write by a
 * command whose whole premise is "do what it says" has been told to trade.
 */
function suggest(
  command: string,
  known: Readonly<Record<string, string | true>>,
  why: string,
  needs: readonly NeededValue[] = [],
): NextSuggestion {
  const spec = getCommand(command);
  if (spec === undefined) {
    throw new CliError('INTERNAL', `\`next\` tried to suggest \`${command}\`, which is not in the command contract.`);
  }
  if (spec.classification !== 'read') {
    throw new CliError('INTERNAL', `\`next\` tried to suggest \`${command}\`, which is a write.`);
  }
  const argv: string[] = spec.cli.split(' ');
  const shown: string[] = [...argv];
  const flaggable = new Set(Object.keys(spec.input.properties ?? {}));
  const fields = [...Object.keys(known), ...needs.map((need) => need.field)];
  if (fields.every((field) => flaggable.has(field))) {
    for (const [field, value] of Object.entries(known)) {
      if (value === true) {
        argv.push(`--${field}`);
        shown.push(`--${field}`);
      } else {
        argv.push(`--${field}`, value);
        shown.push(`--${field}`, shellWord(value));
      }
    }
    for (const need of needs) shown.push(`--${need.field}`, `<${need.field}>`);
  } else {
    // A structured input (`order preview` is a oneOf) takes no typed flags, and
    // the CLI refuses one it does not declare. So the known values travel as
    // the JSON document, and the person sees where theirs go.
    argv.push('--input', JSON.stringify(known));
    const document = [
      ...Object.entries(known).map(([field, value]) => `"${field}":${JSON.stringify(value)}`),
      ...needs.map((need) => `"${need.field}":<${need.field}>`),
    ].join(',');
    shown.push('--input', `'{${document}}'`);
  }
  return {
    command,
    input: known,
    argv,
    invocation: [BINARY, ...shown].join(' '),
    classification: spec.classification,
    why,
    ...(needs.length > 0 ? { needsFromUser: needs } : {}),
  };
}

function answer(
  state: NextState,
  headline: string,
  suggestions: readonly NextSuggestion[],
  handOver?: HandOver,
  agentSteps: readonly AgentSetupStep[] = [],
): NextAnswer {
  const own = agentSteps.length > 0 ? { agentSteps } : {};
  return handOver === undefined
    ? { state, headline, actor: 'AGENT', stop: false, ...own, suggestions }
    : { state, headline, actor: handOver.to, stop: true, handOver, ...own, suggestions };
}

const scoped = (facts: NextFacts): Record<string, string> =>
  facts.namedAccountId === undefined ? {} : { accountId: facts.namedAccountId };

/** How many unsettled items get their own line. The rest are counted, and surface on the next ask. */
const MAX_PER_STATE = 3;

/** Blockers only the owner can clear. The rest clear on their own as the window rolls. */
const OWNER_BLOCKERS: ReadonlySet<PredictTradingBlocker> = new Set([
  'NO_RISK_PROFILE',
  'SUSPENDED',
  'NO_BUY_CAPACITY',
]);

/** Runner states whose order may have left the process with no recorded outcome. */
const OUTCOME_UNKNOWN_STATES: ReadonlySet<string> = new Set(['UNKNOWN_PENDING', 'RECONCILING']);

const readyAccounts = (onboarding: OnboardingState): string[] =>
  onboarding.accounts
    .filter((row) => !row.isSuspended && row.delegation.mayPlaceOrder === true)
    .map((row) => row.accountId);

/* ── The decision ────────────────────────────────────────────────────────── */

/**
 * Facts in, one answer out. Pure, so the order of the checks can be tested
 * without a server — the order is the part that keeps money safe.
 */
export function decideNext(facts: NextFacts): NextAnswer {
  // The state is decided first and the notes are attached to whatever comes
  // back: they must never be able to change which state applies (ADR-0023).
  const decided = decide(facts);
  const account = facts.account;
  if (account === undefined || 'failed' in account) return decided;
  const notes = exposureNotes(account.positions, account.unsettled, facts.now ?? new Date());
  return notes.length === 0 ? decided : { ...decided, notes };
}

function decide(facts: NextFacts): NextAnswer {
  // 1. Local setup. Operator gaps come first even when an owner gap exists too:
  //    an owner cannot grant anything to an agent whose address nobody has.
  const gaps = facts.requirements.filter(
    (requirement) => requirement.state === 'MISSING' && requirement.suppliedBy === 'AGENT_OPERATOR',
  );
  const keystoreIssues = keystoreBlockers(facts);
  if (gaps.length > 0 || keystoreIssues.length > 0 || facts.session === undefined) {
    const titles = [...gaps.map((gap) => gap.title), ...keystoreIssues];
    const { operator, agent } = setupSteps(facts, gaps);
    // A person is only in the way while a step is theirs. When every remaining
    // step is the agent's, stopping would strand a host that can finish its own
    // setup — which is exactly what happened before `agentSteps` existed.
    const needsPerson = operator.length > 0 || agent.length === 0;
    return answer(
      'SETUP_INCOMPLETE',
      `This runtime is not set up yet${titles.length > 0 ? `: ${titles.join('; ')}` : ''}. Nothing was sent.${
        needsPerson || agent.length === 0 ? '' : ' Run the steps in agentSteps, then ask again.'
      }`,
      [
        suggest(
          'runtime.next',
          scoped(facts),
          needsPerson ? 'Once the operator has done the steps, ask again.' : 'After the steps above, ask again.',
        ),
      ],
      needsPerson
        ? {
            to: 'AGENT_OPERATOR',
            message: `Ask the operator to do these steps. Do not do them yourself — the wallet, its passphrase and the network are theirs. Unless they name a network, this runtime uses production (mainnet), where orders spend real funds.${
              agent.length > 0 ? ' The steps in `agentSteps` are yours to run, and doing them first shortens this list.' : ''
            }`,
            ...(operator.length > 0 ? { steps: operator } : {}),
            settings: gaps.map((gap) => ({
              requirement: gap.id,
              title: gap.title,
              supplyWith: gap.supplyWith,
              why: gap.why,
            })),
          }
        : undefined,
      agent,
    );
  }

  // 2. A session that did not open. `doctor` names which check fails and why —
  //    unless the cause is the keystore agent on this machine, which only the
  //    operator can start.
  if (!facts.session.ok) {
    const signerDown =
      facts.keystore?.configuredAsSigner === true &&
      (facts.session.code === 'SIGNER_FAILED' || facts.session.code === 'SIGNER_UNAVAILABLE');
    return answer(
      'SESSION_FAILED',
      `Configured, but no session opened — ${facts.session.code}: ${facts.session.message} Nothing else was read.`,
      [
        suggest(
          'runtime.doctor',
          scoped(facts),
          'Runs every check in order and names the first that fails, with the code a fix keys on.',
        ),
      ],
      signerDown
        ? {
            to: 'AGENT_OPERATOR',
            message:
              'The keystore signer did not answer. Its agent is probably not running — a socket file can outlive the process that made it. Ask the operator to start it again.',
            steps: [agentStep(facts.keystore?.agent === 'SOCKET_PRESENT')],
          }
        : undefined,
    );
  }

  // 3. The authorized-account listing did not come back. That is NOT evidence
  //    that nothing is granted, and saying so would send an owner to re-sign.
  const onboarding = facts.onboarding;
  if (onboarding === undefined || 'failed' in onboarding) {
    return answer(
      'AUTHORIZATION_UNKNOWN',
      `Could not read what the owner has granted${onboarding === undefined ? '' : ` (${onboarding.failed})`}. That is not a refusal.`,
      [suggest('runtime.next', scoped(facts), 'Ask again before asking the owner for anything.')],
    );
  }

  // 4. The owner's step, in the owner's terms.
  const link = facts.authorizationUrl;
  const waitForOwner = suggest(
    'runtime.onboard',
    { ...scoped(facts), wait: true },
    'After handing the link over, wait here for the owner. It prints the same link, polls until the grant lands, and a wait that runs out cancels nothing — run it again.',
  );
  switch (onboarding.status) {
    case 'NOT_ONBOARDED':
    case 'DELEGATION_MISSING':
      return answer(
        'AWAITING_OWNER',
        `The account owner has not authorized this agent yet (${onboarding.status}). Send them the link, then run the step below while they sign.`,
        [waitForOwner],
        {
          to: 'ACCOUNT_OWNER',
          message:
            link === undefined
              ? 'The owner has to authorize this agent in their own wallet, and no console is paired with this deployment to send them to. Ask the operator for the console URL (WATERX_PREDICT_CONSOLE_URL).'
              : facts.direct === true
                ? 'Send the owner this link. They pick an account and sign the delegation once in their own wallet; that signature is the whole grant in direct mode. If the page then fails to save limits, the grant has still landed — this runtime bounds spending with its own execution policy. The link carries no token; never ask for their key. If they are not at this machine, `waterx-predict onboard --qr` draws it as a code they can scan.'
                : 'Send the owner this link. They pick an account, set the limits and sign once in their own wallet. The link carries no token and grants nothing by itself; never ask for their key. If they are not at this machine, `waterx-predict onboard --qr` draws it as a code they can scan.',
          ...(link === undefined ? {} : { authorizationUrl: link }),
        },
        // The signature is the owner's; the command is this agent's. Those are
        // two halves of one step that attach to different people, and a screen
        // that named only the first is where a real session stopped — having
        // produced no link at all, because it never ran the command that prints
        // one (ADR-0022).
        link === undefined
          ? []
          : [
              {
                run: `${BINARY} onboard --wait`,
                command: 'runtime.onboard',
                why: 'Prints the link again, opens the page on THIS machine (which is the operator\u2019s call, not yours \u2014 do not pass `--no-open`), and polls until the owner\u2019s grant lands — then adopts the account it was granted on. A wait that runs out cancels nothing: run it again.',
                safeBecause:
                  'It reads. It signs the login challenge and nothing else, grants nothing, and cannot make the owner\u2019s decision for them — only notice when they have made it.',
              },
            ],
      );
    case 'SUSPENDED':
      return answer(
        'AWAITING_OWNER',
        'The owner has suspended this agent. Only they can lift it, and re-signing a delegation will not.',
        [waitForOwner],
        {
          to: 'ACCOUNT_OWNER',
          message:
            'Tell the owner this agent is suspended on their account. Lifting it is their decision, made in their own session.',
          ...(link === undefined ? {} : { authorizationUrl: link }),
        },
      );
    case 'DELEGATION_UNKNOWN':
      return answer(
        'AUTHORIZATION_UNKNOWN',
        'The on-chain delegation could not be read. That is not a refusal.',
        [
          suggest(
            'runtime.next',
            scoped(facts),
            'Ask again before asking the owner for anything — they may already have signed.',
          ),
        ],
      );
    case 'AMBIGUOUS': {
      const candidates = readyAccounts(onboarding);
      return answer(
        'ACCOUNT_CHOICE_NEEDED',
        `${String(candidates.length)} accounts are authorized. Which one trades is the user's decision.`,
        [
          suggest('runtime.next', {}, 'Ask again with the account the user chose.', [
            {
              field: 'accountId',
              why: `One of ${candidates.join(', ')}. Choosing between them is choosing whose money trades; never carry one over from an earlier answer.`,
            },
          ]),
        ],
        {
          to: 'AGENT_OPERATOR',
          message: `Ask the user which account this agent should trade on: ${candidates.join(', ')}.`,
        },
      );
    }
    case 'READY':
      break;
  }

  if (facts.adoption?.status === 'CONFLICT') {
    const { adopted, authorized } = facts.adoption;
    return answer(
      'ACCOUNT_CHOICE_NEEDED',
      `This agent was trading on ${adopted}, and the account authorized now is ${authorized}. Switching is the user's decision.`,
      [
        suggest('runtime.next', {}, 'Ask again with the account the user chose.', [
          {
            field: 'accountId',
            why: `${authorized} is authorized now; ${adopted} is where this agent traded before. Taking up a different account moves someone else's money, so it is never done without being named.`,
          },
        ]),
      ],
      {
        to: 'AGENT_OPERATOR',
        message: `Confirm with the user that this agent should now trade on ${authorized} instead of ${adopted}, then name it (--accountId or WATERX_PREDICT_ACCOUNT_ID).`,
      },
    );
  }

  const accountId = onboarding.account?.accountId;
  const account = facts.account;
  if (accountId === undefined || account === undefined || 'failed' in account) {
    return answer(
      'ACCOUNT_UNREADABLE',
      `The account is authorized, but its state could not be read${account !== undefined && 'failed' in account ? ` (${account.failed})` : ''}, so nothing can be said about what is still in flight.`,
      [
        suggest(
          'runtime.next',
          scoped(facts),
          'Ask again. No order is suggested until the account has been read, because an unread account may be holding an unsettled one.',
        ),
      ],
    );
  }
  const onAccount = { accountId };

  // 5. Anything in flight, before anything new.
  if (account.unsettled.length > 0) {
    const shown = account.unsettled.slice(0, MAX_PER_STATE);
    return answer(
      'UNSETTLED_EXECUTION',
      `${String(account.unsettled.length)} execution(s) on this account have not settled. Read them to an outcome before placing anything new.`,
      shown.map((execution) =>
        suggest(
          'order.reconcile',
          { executionId: execution.executionId },
          `${execution.side} on ${execution.marketId} is ${execution.status}. Reconciling reads it to a terminal state and is safe to repeat; resubmitting would be a second order.`,
        ),
      ),
    );
  }

  // 6. The Runner: an order of unknown outcome, or live jobs nothing advances.
  const runner = facts.runner;
  if (runner?.status === 'ANSWERED') {
    const live = runner.strategies.filter((job) => !job.terminal);
    const unknown = live.filter((job) => OUTCOME_UNKNOWN_STATES.has(job.state));
    if (unknown.length > 0) {
      return answer(
        'STRATEGY_NEEDS_ATTENTION',
        `${String(unknown.length)} strategy job(s) have an order of unknown outcome. The Runner settles them from the server; arm nothing that overlaps until it has.`,
        unknown.slice(0, MAX_PER_STATE).map((job) =>
          suggest(
            'strategy.get',
            { jobId: job.jobId },
            `Job ${job.jobId} is ${job.state}. Its openSideEffects say what may have left the Runner unanswered.`,
          ),
        ),
      );
    }
    if (!runner.driving && live.length > 0) {
      return answer(
        'STRATEGY_NEEDS_ATTENTION',
        `${String(live.length)} live strategy job(s) are held by a Runner that is not driving. They are armed and asleep: nothing will trigger them.`,
        [
          suggest(
            'strategy.list',
            onAccount,
            'The reply names the Runner and what it is missing. Ask again once the operator has acted.',
          ),
        ],
        {
          to: 'AGENT_OPERATOR',
          message:
            'Tell the operator their Runner is not driving, so armed strategies will never trigger. Configuring it, or cancelling the jobs, is theirs to decide.',
        },
      );
    }
  }

  // 7. The owner's limits. Direct mode has none to read; its ceiling is the
  //    execution policy, already reflected in `facts.writes`.
  const blockers = account.limits?.blockers ?? [];
  if (blockers.length > 0) {
    const ownerOnly = blockers.some((blocker) => OWNER_BLOCKERS.has(blocker));
    const suggestions: NextSuggestion[] = [
      suggest(
        'account.risk-limits',
        onAccount,
        ownerOnly
          ? 'Shows the mandate and what is blocking it. This agent can read its limits and can never raise them.'
          : 'The window is rolling. Read the usage, and ask again once it has moved; nothing needs to be granted.',
      ),
    ];
    // A capacity blocker does not stop a SELL, so an agent holding positions
    // still has something to look at.
    if (account.positions.length > 0 && blockers.every((blocker) => blocker === 'NO_BUY_CAPACITY')) {
      suggestions.push(
        suggest(
          'account.positions',
          onAccount,
          'There is no buying capacity, but positions are held. A SELL is sized in shares from here, and what to sell is the user\'s to say.',
        ),
      );
    }
    return answer(
      'TRADING_BLOCKED',
      `A new order would be refused right now: ${blockers.join(', ')}.`,
      suggestions,
      ownerOnly
        ? {
            to: 'ACCOUNT_OWNER',
            message: `Tell the owner what blocks this agent (${blockers.join(', ')}). Funding the account, lifting a suspension or writing a risk profile is theirs to do.`,
          }
        : undefined,
    );
  }

  // 8. Ready. What to trade, how much and how carefully are the user's words.
  //
  //    …except when nothing may be signed yet. The grant has landed and this
  //    runtime still places no order, so the next thing to put in front of the
  //    operator is that choice — not a market to browse (ADR-0025).
  const suggestions: NextSuggestion[] = [];
  if (facts.writes === 'REFUSED') {
    // The chooser, not a mode. Naming one of the three in a sentence is how an
    // operator ends up taking the middle option without being shown the other
    // two, and `next` is read by an agent that relays exactly what it is given
    // (ADR-0021). First, so it is also what `meta.nextCommand` points at.
    suggestions.push(
      suggest(
        'runtime.policy',
        {},
        'The three modes this runtime could be in, with what each allows and the command that takes it. Choosing is the operator\u2019s: relay the three, do not pick one for them.',
      ),
    );
  }
  suggestions.push(
    suggest(
      'market.search',
      { tradeable: true },
      'Turn the user\'s words into one server-resolved market. AMBIGUOUS is an answer: show the candidates and ask.',
      [{ field: 'search', why: 'What to trade is the user\'s to say.' }],
    ),
  );
  if (facts.writes === 'NEEDS_APPROVAL' || facts.writes === 'WITHIN_SCOPE') {
    suggestions.push(
      suggest(
        'order.preview',
        onAccount,
        facts.writes === 'NEEDS_APPROVAL'
          ? 'Prices and policy-checks the order without placing it. Show the user what it would do and the `order execute --approve <token> --approver <name>` line it returns; the approval is theirs to give, and no tool call can supply it.'
          : 'Prices and policy-checks the order without placing it. It executes only inside the delegated-auto scope the operator wrote down.',
        [
          { field: 'marketId', why: 'From market search. Never assembled, completed or remembered.' },
          { field: 'outcomeId', why: 'Which outcome the user means.' },
          { field: 'side', why: 'BUY or SELL, as the user said it.' },
          { field: 'size', why: 'buyAmount for a BUY, sellShares for a SELL, as decimal strings. A vague size is not a size — ask.' },
          { field: 'maxSlippageBps', why: 'The price protection is the user\'s risk to set.' },
        ],
      ),
    );
  }
  if (account.positions.length > 0) {
    suggestions.push(
      suggest(
        'account.positions',
        onAccount,
        `${String(account.positions.length)} position(s) are held. A SELL needs the positionId from here.`,
      ),
    );
  }
  if (facts.writes === 'REFUSED') {
    // Authorized, and still unable to sign. Said in the headline rather than
    // left to `facts.policy`, because the owner has just done their part and
    // the next question is the operator's: what may this thing sign?
    return answer(
      'READY',
      `Authorized on ${accountId} with nothing in flight, and it places no order yet.${
        facts.readOnlyByDefault === true
          ? ' This runtime is read-only by default on mainnet (nobody has chosen a policy).'
          : ' The execution policy is read-only.'
      } Choosing what it may sign is the operator\u2019s: \`waterx-predict policy\` lists the three modes with what each allows, and \`waterx-predict policy set --mode <mode> --yes\` takes one. Reads still work.`,
      suggestions,
    );
  }
  const posture =
    facts.writes === 'SCOPE_EXPIRED'
      ? ' The delegated-auto window has closed, so this runtime authorizes no order until the operator renews it.'
      : '';
  return answer(
    'READY',
    `Authorized on ${accountId} with nothing in flight.${posture} Ask the user what to trade.`,
    suggestions,
  );
}

/* ── The operator's path through the keystore signer ─────────────────────── */

const KEYSTORE_ASSET = `waterx-predict-agent-signer-keystore-${CLI_VERSION}.tgz`;
const npxKeystore = (subcommand: string): string => `npx --no ${KEYSTORE_LAYOUT.command} ${subcommand}`;

/**
 * The step is listed even when a socket file is there, because a socket proves
 * nothing: the file outlives the agent that made it, and this runtime will not
 * dial it to find out (`keystore-probe.ts`). A real host followed a hand-over
 * that skipped this step on a machine whose socket was a month stale, and the
 * first signature is where that would have surfaced.
 */
const agentStep = (socketPresent: boolean): SetupStep => ({
  run: npxKeystore('agent'),
  why: socketPresent
    ? 'Unlocks the keystore and stays running holding the key. A socket file is already there, which does not prove an agent is behind it — if one is running, this step is done; if it is not, every signature fails until it is.'
    : 'Unlocks the keystore once, in its own terminal, and stays running holding the key. Every signature after that goes through it; nothing else sees the passphrase.',
});

/**
 * What stops a keystore-configured signer from working, found without asking it.
 * Each is a reason not to attempt a session: the signature would fail, and the
 * failure would read as an authentication problem rather than as a step undone.
 */
function keystoreBlockers(facts: NextFacts): string[] {
  const probe = facts.keystore;
  if (probe === undefined || !probe.configuredAsSigner) return [];
  const issues: string[] = [];
  if (probe.keystore.status === 'ABSENT') issues.push('The keystore has not been created');
  if (probe.keystore.status === 'UNREADABLE') issues.push(`The keystore at ${probe.dir} cannot be read`);
  if (probe.keystore.status === 'PRESENT' && probe.agent === 'NO_SOCKET') {
    issues.push('The keystore agent is not running');
  }
  if (
    probe.keystore.status === 'PRESENT' &&
    facts.agentWallet !== undefined &&
    facts.agentWallet.toLowerCase() !== probe.keystore.address.toLowerCase()
  ) {
    // The agent refuses to sign for an address it does not hold, so this would
    // fail at the first signature — with a message about the wrong thing.
    // WHERE it is written, not just what it says: a session that met this
    // message went hunting, looked in the keystore directory, never found the
    // config file, and concluded the address was a shipped default (ADR-0027).
    issues.push(
      `The agent wallet is ${facts.agentWallet}${facts.agentWalletFrom ?? ''}, but the keystore holds ${probe.keystore.address}`,
    );
  }
  return issues;
}

/**
 * The remaining steps, split by who may run them.
 *
 * Steps already done are left out; a step that depends on one not yet done says
 * where its value comes from instead of inventing it. The split is the point:
 * `operator` is what a person must decide or type — a passphrase, a network, a
 * program to install — and `agent` is what a host may do for itself, which is
 * creating a wallet that holds nothing and telling this runtime which wallet it
 * is (ADR-0020).
 */
function setupSteps(
  facts: NextFacts,
  gaps: readonly ResolvedRequirement[],
): { operator: SetupStep[]; agent: AgentSetupStep[] } {
  const missing = new Set(gaps.map((gap) => gap.id));
  const probe = facts.keystore;
  const operator: SetupStep[] = [];
  const agent: AgentSetupStep[] = [];

  if (missing.has('deployment')) {
    operator.push({
      run: 'export WATERX_PREDICT_ENVIRONMENT=mainnet   # or testnet to practise',
      why: `\`${facts.requirements.find((row) => row.id === 'deployment')?.evidence ?? ''}\` Name a deployment this build knows, or unset it to use mainnet.`,
    });
  }

  const useKeystore = probe !== undefined && (probe.configuredAsSigner || missing.has('signer'));
  if (probe !== undefined && useKeystore) {
    if (!probe.installed) {
      operator.push({
        run: `npm install github:WaterXProtocol/waterx-predict-agent   # or <release-asset-url>/${KEYSTORE_ASSET}`,
        why: 'Installs the keystore signer beside this CLI — the repository carries both binaries (ADR-0019), and a release carries them as two artifacts. It is a separate program on purpose: this CLI never holds a key.',
      });
    }
    if (probe.keystore.status === 'UNREADABLE') {
      operator.push({
        run: `mv ${probe.dir}/${KEYSTORE_LAYOUT.keystoreFile} ${probe.dir}/${KEYSTORE_LAYOUT.keystoreFile}.unreadable`,
        why: 'The existing keystore file has no readable address. Move it aside rather than deleting it — it may still hold a key someone needs.',
      });
    }
    if (probe.keystore.status !== 'PRESENT') {
      // The agent's, and the only reason it can be: the wallet this creates is
      // new and empty, and until an owner grants it on-chain it may do exactly
      // nothing. An operator who wants the key sealed runs `init` instead, and
      // the why says so rather than hiding the choice. Listed even when the
      // binary is still to be installed: the order is the plan, and the install
      // above is the step that comes first.
      agent.push({
        run: npxKeystore('init --no-passphrase'),
        why: `Creates a NEW agent wallet and prints its address${probe.installed ? '' : ', once the signer above is installed'}. \`--no-passphrase\` keeps the key in a 0600 file with no passphrase, because an unattended host has nobody to type one and nowhere to keep a resident process holding it unlocked — the same posture as the perp agent. An operator who would rather seal it runs \`${npxKeystore('init')}\` and then \`${npxKeystore('agent --detach')}\`, and this step is theirs instead of yours.`,
        safeBecause:
          'The wallet is brand new: it holds no funds, and it can do nothing at all until the ACCOUNT OWNER grants it on-chain, which is a step only they can take. Never import an existing key here.',
      });
    }
    // A sealed keystore needs something holding it open. A passphrase-less one
    // does not, and telling anyone to start an agent for it would be asking for
    // a process that refuses to start (`keystore agent` says so).
    if (probe.keystore.status === 'PRESENT' && probe.keystore.protection !== 'NONE') {
      operator.push(agentStep(probe.agent === 'SOCKET_PRESENT'));
    }
    const address = probe.keystore.status === 'PRESENT' ? probe.keystore.address : undefined;
    const mismatched =
      address !== undefined && facts.agentWallet !== undefined && facts.agentWallet.toLowerCase() !== address.toLowerCase();
    if (missing.has('agentWallet') || missing.has('signer') || mismatched) {
      agent.push({
        run: `${BINARY} configure --fromKeystore${mismatched ? ' --replace' : ''}`,
        command: 'runtime.configure',
        why: `Writes the keystore's address and the signer command into this machine's config file${
          address === undefined ? ', once the keystore exists' : ` (${address})`
        }. It is written to a file rather than exported because a tool host runs every command in its own process, and a variable it exports is gone by the next call.`,
        safeBecause:
          'It writes exactly two settings — which wallet this runtime is, and which program signs for it — and no network, policy or account. Nothing is sent, nothing is signed, and the keystore is never opened: an address is public.',
      });
    }
    return { operator, agent };
  }

  if (missing.has('agentWallet')) {
    operator.push({
      run: `${BINARY} configure --agentWallet <the address your signer holds>`,
      why: 'A custom signer is configured, so only its operator knows which address it signs for. `configure` persists it in the config file, which an `export` in one process cannot do.',
    });
  }
  return { operator, agent };
}

/* ── Gathering the facts ─────────────────────────────────────────────────── */

/** How far back the in-flight scan looks. A non-terminal order is a recent one. */
export const EXECUTION_SCAN = 50;
const POSITION_SCAN = 50;

function writePosture(context: CommandContext): WritePosture {
  const { mode, scope } = context.config.policy;
  if (mode === 'read-only') return 'REFUSED';
  if (mode === 'interactive') return 'NEEDS_APPROVAL';
  const notAfter = scope === undefined ? Number.NaN : Date.parse(scope.notAfter);
  return Number.isNaN(notAfter) || context.now().getTime() > notAfter ? 'SCOPE_EXPIRED' : 'WITHIN_SCOPE';
}

const codeOf = (error: unknown): string => toEnvelopeError(error, 0).code;

/**
 * What the local Runner holds for this account, if there is one.
 *
 * Absence is the ordinary case — a one-shot agent has no Runner — and it is
 * decided before any dial: `openRunnerSession` refuses a missing runtime
 * directory or socket without touching the network.
 */
async function glanceAtRunner(context: CommandContext, accountId: string): Promise<RunnerGlance> {
  try {
    const session = await context.runner();
    const reply = (await session.request('strategy.list', { accountId })) as { strategies?: unknown };
    const rows = Array.isArray(reply.strategies) ? (reply.strategies as Record<string, unknown>[]) : [];
    return {
      status: 'ANSWERED',
      driving: session.driving,
      strategies: rows.map((row) => ({
        jobId: String(row['jobId']),
        state: String(row['state']),
        // Anything but an explicit true is live: a job this module cannot
        // classify is one it must not quietly drop from the picture.
        terminal: row['terminal'] === true,
      })),
    };
  } catch (error: unknown) {
    if (isRunnerRefusal(error) && error.code === 'RUNNER_UNREACHABLE') return { status: 'ABSENT' };
    // No home directory to look in, and no directory named: nowhere a Runner
    // could be listening for this CLI.
    if (error instanceof CliError && error.code === 'NOT_CONFIGURED') return { status: 'ABSENT' };
    return { status: 'UNREADABLE', code: codeOf(error) };
  }
}

async function gatherFacts(context: CommandContext): Promise<NextFacts> {
  const { config } = context;
  const named = typeof context.input.accountId === 'string' ? context.input.accountId : undefined;
  const keystore = context.probeKeystore();
  const base = {
    writes: writePosture(context),
    // One clock for the whole answer, so the age of an unsettled order is not
    // measured against a different instant than the rest of it.
    now: context.now(),
    ...(config.policy.mode === 'read-only' && config.policy.source === 'DEFAULT' ? { readOnlyByDefault: true } : {}),
    ...(config.mode === 'direct' ? { direct: true } : {}),
    ...(named === undefined ? {} : { namedAccountId: named }),
    ...(config.agentWallet === undefined
      ? {}
      : {
          agentWallet: config.agentWallet,
          agentWalletFrom:
            config.agentWalletSource === 'ENVIRONMENT'
              ? ` (from ${ENV_KEYS.agentWallet})`
              : config.configPath === null
                ? ''
                : ` (from ${config.configPath})`,
        }),
    ...(keystore === undefined ? {} : { keystore }),
  };

  const local = resolveRequirements(config, undefined, 'No session has been opened yet.');
  if (
    local.some((requirement) => requirement.state === 'MISSING' && requirement.suppliedBy === 'AGENT_OPERATOR') ||
    // A keystore step left undone means the first signature fails. Asking for
    // one anyway would only turn "start the agent" into an auth error.
    keystoreBlockers({ ...base, requirements: local }).length > 0
  ) {
    return { ...base, requirements: local };
  }

  let session: SessionFact;
  try {
    await context.client();
    session = { ok: true };
  } catch (error: unknown) {
    const refused = toEnvelopeError(error, 0);
    return { ...base, requirements: local, session: { ok: false, code: refused.code, message: refused.message } };
  }

  let onboarding: OnboardingState;
  try {
    const client = await context.client();
    onboarding = describeOnboarding(
      await client.listAuthorizedAccounts(context.signal()),
      named === undefined ? {} : { accountId: named },
    );
  } catch (error: unknown) {
    return {
      ...base,
      requirements: resolveRequirements(
        config,
        undefined,
        'The authorized-account listing could not be read. That is not evidence that nothing is granted.',
      ),
      session,
      onboarding: { failed: codeOf(error) },
    };
  }

  const settled = { ...base, requirements: resolveRequirements(config, onboarding, undefined), session, onboarding };

  if (onboarding.status !== 'READY' || onboarding.account === undefined) {
    const consoleBaseUrl = pairedConsoleUrl(context);
    const agentWallet = config.agentWallet;
    if (consoleBaseUrl === undefined || agentWallet === undefined) return settled;
    return {
      ...settled,
      authorizationUrl: buildAuthorizationUrl({
        consoleBaseUrl,
        agentWallet,
        ...(typeof context.input.label === 'string' ? { label: context.input.label } : {}),
        ...(named === undefined ? {} : { accountId: named }),
      }),
    };
  }

  const accountId = onboarding.account.accountId;
  const client = await context.client();
  if (isDirectClient(client)) {
    const adoption = adopt(context, onboarding.account.accountId, onboarding.account.ownerAddress, named);
    if (adoption.status === 'CONFLICT') return { ...settled, adoption };
    // Direct mode: what is unsettled is what this runtime's own intent journal
    // sent and has not seen settle. There is no mandate and no blocker list.
    const [unsettled, positions, runner] = await Promise.allSettled([
      client.listUnsettled(accountId, context.signal()),
      client.getPositions(accountId, { limit: POSITION_SCAN }, context.signal()),
      glanceAtRunner(context, accountId),
    ]);
    const runnerFact: RunnerGlance =
      runner.status === 'fulfilled' ? runner.value : { status: 'UNREADABLE', code: codeOf(runner.reason) };
    if (unsettled.status === 'rejected' || positions.status === 'rejected') {
      const reason = unsettled.status === 'rejected' ? unsettled.reason : (positions as PromiseRejectedResult).reason;
      return { ...settled, account: { failed: codeOf(reason) }, runner: runnerFact };
    }
    return {
      ...settled,
      account: { limits: null, unsettled: unsettled.value, positions: positions.value.positions },
      runner: runnerFact,
      adoption,
    };
  }
  // All three or nothing. A partial picture — limits without executions — is
  // exactly the one that would offer an order beside an unsettled one.
  const [limits, executions, positions, runner] = await Promise.allSettled([
    client.getEffectiveLimits(accountId, context.signal()),
    client.listExecutions(accountId, { limit: EXECUTION_SCAN }, context.signal()),
    client.getPositions(accountId, { limit: POSITION_SCAN }, context.signal()),
    glanceAtRunner(context, accountId),
  ]);
  const runnerFact: RunnerGlance =
    runner.status === 'fulfilled' ? runner.value : { status: 'UNREADABLE', code: codeOf(runner.reason) };

  if (limits.status === 'rejected' || executions.status === 'rejected' || positions.status === 'rejected') {
    const reason = [limits, executions, positions].find((result) => result.status === 'rejected');
    return {
      ...settled,
      account: { failed: reason?.status === 'rejected' ? codeOf(reason.reason) : 'UNKNOWN' },
      runner: runnerFact,
    };
  }
  return {
    ...settled,
    account: {
      limits: limits.value,
      unsettled: executions.value.executions.filter(
        (execution) => !isTerminalExecutionStatus(execution.status),
      ),
      positions: positions.value.positions,
    },
    runner: runnerFact,
  };
}

/**
 * Record — or refuse to silently change — the account direct mode trades on.
 * Naming an account (the command's `accountId`, or the configured default) is
 * the only way to move off one that was in use.
 */
function adopt(
  context: CommandContext,
  accountId: string,
  ownerAddress: string,
  namedOnCommand: string | undefined,
): NonNullable<NextFacts['adoption']> {
  const { config } = context;
  const named = namedOnCommand ?? config.defaultAccountId;
  let ledger;
  try {
    ledger = context.ledgers().adoptions;
  } catch (error: unknown) {
    return { status: 'UNRECORDED', reason: codeOf(error) };
  }
  const key = `${config.network ?? 'unknown'}:${config.agentWallet ?? ''}`;
  const record = ledger.get(key);
  const now = context.now().toISOString();
  if (record?.accountId === accountId) return { status: 'UNCHANGED', accountId };
  if (record !== undefined && named !== accountId) {
    return { status: 'CONFLICT', adopted: record.accountId, authorized: accountId };
  }
  const basis = named === accountId ? 'NAMED' : 'FIRST_SEEN';
  const namedBy = basis === 'NAMED' ? (namedOnCommand === accountId ? 'COMMAND' : 'CONFIG') : undefined;
  ledger.set(key, {
    accountId,
    ownerAddress,
    adoptedAt: now,
    basis,
    ...(namedBy === undefined ? {} : { namedBy }),
  });
  context.ledgers().audit.append(
    {
      event: 'account.adopted',
      key,
      accountId,
      basis,
      ...(namedBy === undefined ? {} : { namedBy }),
      ...(record === undefined ? {} : { previous: record.accountId }),
    },
    context.now(),
  );
  return { status: record === undefined ? 'ADOPTED_NOW' : 'SWITCHED_BY_NAME', accountId };
}

function describeAccount(account: AccountFact | undefined): unknown {
  if (account === undefined) return null;
  if ('failed' in account) return { status: 'UNREAD', reason: account.failed };
  return {
    status: 'READ',
    ...(account.limits === null
      ? { mandate: 'NONE_IN_DIRECT_MODE', blockers: [], effectiveBuyCapacity: null, unsettledSource: 'LOCAL_INTENT_JOURNAL' }
      : {
          blockers: account.limits.blockers,
          effectiveBuyCapacity: account.limits.allowance?.effectiveBuyCapacity ?? null,
        }),
    unsettledExecutions: account.unsettled.map((execution) => ({
      executionId: execution.executionId,
      status: execution.status,
    })),
    executionsScanned: EXECUTION_SCAN,
    // A count, as it always was. What the positions HOLD is in `notes`, which
    // is where a reader of this answer will actually see it (ADR-0023).
    positions: account.positions.length,
  };
}

export async function runtimeNext(context: CommandContext): Promise<unknown> {
  const facts = await gatherFacts(context);
  const decided = decideNext(facts);

  // For a person watching a terminal: the headline, who acts, and the first step.
  const first = decided.suggestions[0];
  // The pointer is the first thing here that can be run AS PRINTED — an agent
  // step before a suggestion, because those are the ones that move the setup
  // along. A suggestion carrying `<field>` is skipped by `pointTo` itself, and
  // then the fallback is `next`, which is the right answer while waiting for a
  // person (ADR-0022).
  for (const candidate of [
    ...(decided.agentSteps ?? []).map((step) => step.run),
    ...decided.suggestions.map((suggestion) => suggestion.invocation),
  ]) {
    context.pointTo(candidate);
    break;
  }
  context.diagnostic(
    [
      // Before the headline: what the account is carrying outranks what this
      // runtime is waiting for. A stale feed or a locked escrow matters in
      // every state, including the ones that read as fine (ADR-0023).
      ...(decided.notes ?? []).map((note) => `  ! ${note.says}`),
      decided.headline,
      // The agent's own steps first: they are the ones this process can act on,
      // and a person reading along should see what the host is about to do.
      ...(decided.agentSteps === undefined ? [] : ['  you may run these yourself:']),
      ...(decided.agentSteps ?? []).map((step, index) => `    ${String(index + 1)}. ${step.run}`),
      ...(decided.handOver === undefined ? [] : [`  hand over to ${decided.handOver.to}: ${decided.handOver.message}`]),
      ...(decided.handOver?.steps ?? []).map((step, index) => `    ${String(index + 1)}. ${step.run}`),
      ...(decided.handOver?.authorizationUrl === undefined ? [] : [`  ${decided.handOver.authorizationUrl}`]),
      ...(first === undefined ? [] : [`  then: ${first.invocation}`]),
      '',
    ].join('\n'),
  );

  const onboarding = facts.onboarding;
  return {
    ...decided,
    facts: {
      deployment: {
        // `DEFAULT` is production — mainnet, real funds — chosen because nobody
        // named a network (ADR-0011). A host relays that; it does not bury it.
        source: context.config.deploymentSource,
        name:
          context.config.deploymentSource === 'DEFAULT'
            ? 'production'
            : (context.config.environment ?? null),
        baseUrl: context.config.baseUrl ?? null,
        realFunds:
          context.config.network === 'mainnet' || context.config.baseUrl === PREDICT_AGENT_ENDPOINTS.production,
        mode: context.config.mode,
        network: context.config.network ?? null,
      },
      agentWallet: context.config.agentWallet ?? null,
      policy: { mode: context.config.policy.mode, writes: facts.writes },
      signer:
        facts.keystore === undefined
          ? { kind: context.config.signerCommand === undefined ? 'NONE' : 'EXTERNAL_COMMAND' }
          : {
              kind: 'KEYSTORE',
              configured: facts.keystore.configuredAsSigner,
              installed: facts.keystore.installed,
              keystore: facts.keystore.keystore,
              agent: facts.keystore.agent,
            },
      session: facts.session === undefined ? 'NOT_ATTEMPTED' : facts.session.ok ? 'OPEN' : facts.session.code,
      onboarding:
        onboarding === undefined
          ? null
          : 'failed' in onboarding
            ? { status: 'UNREAD', reason: onboarding.failed }
            : { status: onboarding.status, accounts: onboarding.accounts.length },
      accountId: onboarding !== undefined && !('failed' in onboarding) ? (onboarding.account?.accountId ?? null) : null,
      account: describeAccount(facts.account),
      ...(facts.adoption === undefined ? {} : { adoption: facts.adoption }),
      runner: facts.runner ?? null,
    },
    requirements: facts.requirements.map((requirement) => ({
      id: requirement.id,
      state: requirement.state,
      suppliedBy: requirement.suppliedBy,
      evidence: requirement.evidence,
    })),
    nextStep: nextStepFor(facts.requirements),
    caveats: [
      'When `stop` is true, relay `handOver` to that person first. Their step is theirs; do not act for them.',
      '`needsFromUser` lists what the user must choose. Never fill one in from a default, an earlier answer or the conversation.',
      'Every suggestion is a read. A write is always the previewed order a person approves — or one inside a delegated-auto scope an operator wrote down.',
      `The in-flight scan reads the newest ${String(EXECUTION_SCAN)} executions. A non-terminal order is a recent one; an older one is still reachable with \`account executions\`.`,
      'READY is not a promise of a fill: the market must be tradeable, the quote executable, and the chain decides last.',
    ],
  };
}
