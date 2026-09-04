/**
 * The skill: the thin thing a host loads so one sentence reaches this runtime.
 *
 * A skill is a TRIGGER and a ROUTE, and deliberately not a second copy of the
 * rules. Everything a model needs to avoid losing money is in the instructions
 * document, which is generated, tested and shipped; restating any of it here
 * would produce two documents that disagree the first time one is edited, and
 * the one a host loaded is the one nobody re-reads.
 *
 * So this file holds four things and no more: the words that make a host pick
 * this skill, the order the steps have to happen in, the citations that send a
 * reader to the real rule, and the honest statement of where the flow stops. It
 * stops before the order — under the default policy the approval is issued at
 * the command core by an operator, so a skill that promised to complete a bet
 * would be promising something the policy refuses by design
 * (`APPROVAL_IS_PER_INTENT_AND_OPERATOR_HELD`).
 *
 * Every `rule` named below is asserted to exist in `instructions.ts`, so
 * deleting a rule breaks this document rather than leaving it pointing at
 * nothing.
 */
import { AGENT_COMMAND_SCHEMA_VERSION } from '@waterx/predict-agent-schema';

import { AGENT_INSTRUCTIONS_VERSION, buildAgentInstructions } from './instructions.ts';

/** Bumped when the route changes, not when the wording is tidied. */
export const AGENT_SKILL_VERSION = '1';

export interface AgentSkillStep {
  readonly id: string;
  readonly title: string;
  readonly body: readonly string[];
}

export interface AgentSkillStop {
  /** A rule id in the instructions document. */
  readonly rule: string;
  readonly text: string;
}

export interface AgentSkillDocument {
  readonly name: string;
  /** The trigger. A host chooses this skill by reading this one line. */
  readonly description: string;
  readonly version: string;
  readonly instructionsVersion: string;
  readonly commandSchemaVersion: string;
  readonly intro: readonly string[];
  readonly steps: readonly AgentSkillStep[];
  readonly stops: readonly AgentSkillStop[];
}

const NAME = 'waterx-predict';

const DESCRIPTION =
  'Install and operate the WaterX Predict agent runtime: set up @waterx/predict-agent-sdk, get the agent authorized by an account owner, resolve a prediction market from plain language, and preview or place a price-protected market order. Use when asked to install the WaterX Predict SDK or CLI, to bet, trade or take a position on a prediction market through WaterX Predict, to check why an agent cannot trade yet, or to arm a price-triggered strategy.';

const INTRO: readonly string[] = [
  'This runtime trades a real prediction-market account. Orders are market orders and nothing recalls one, so the sequence below is not a suggested order of work — each step exists because the step after it is unsafe without it.',
  'How far you can take it depends on the surface you hold, so establish that first. Through the CLI or a tool adapter the default `interactive` policy issues the approval at the command core and no tool call can supply one — there, a previewed order the user can approve IS the completed task. Holding only the library, that policy is not running: a write is gated by the account owner\'s on-chain delegation, `await client.diagnose()` reads whether it permits one, and a permitted order is yours to place.',
];

const STEPS: readonly AgentSkillStep[] = [
  {
    id: 'READ_THE_RULES',
    title: 'Read the shipped rules first',
    body: [
      'After `npm install`, the operating rules are on disk at `node_modules/@waterx/predict-agent-sdk/AGENT_INSTRUCTIONS.md`. Read them before anything else. They are not background: each rule is a refusal you would otherwise meet with money in flight.',
      'For the exact shape of a call, use the SDK\'s own types — its `.d.ts` IS the contract as your compiler sees it. `@waterx/predict-agent-schema` publishes the same contract as plain JSON for a surface that cannot import a Node module, but the SDK does not depend on it, so `node_modules/@waterx/predict-agent-schema/agent-commands.json` exists only if you installed it too. Check before you read it.',
      'If `waterx-predict` is on PATH, `waterx-predict describe` and `waterx-predict command-schema` are the authoritative answer for THIS build and outrank any document, including this one.',
    ],
  },
  {
    id: 'FIND_OUT_WHAT_IS_MISSING',
    title: 'Ask the installation what it still needs',
    body: [
      'Run `npx @waterx/predict-agent-sdk` (or call `describeInstallation()`). It needs no configuration, no network and no signer, and it reports which surfaces this machine has and which requirements are still outstanding.',
      'Report `missing` and `unchecked` as the different things they are. `missing` is a fact. `unchecked` means nothing looked — telling a user their delegation is absent on that basis sends an account owner to re-sign a grant they may already have made.',
      'Then settle the three it could not: `await client.diagnose()` returns all six, whether a write would be admitted (`writes.permitted`), the mandate it would run under, and the authorization link already built if an owner still has to act.',
    ],
  },
  {
    id: 'GET_AUTHORIZED',
    title: 'Hand the owner one link, and wait',
    body: [
      'An agent may only trade on an account an owner has granted it, and the grant is one signature in the owner\'s own wallet. Run `waterx-predict onboard --label <name>`, or `await client.startOnboarding({ label })` — which hands back the link AND the `wait()` that polls for the signature.',
      'Wait for it. Printing the link and stopping makes the person come back to a dead terminal and announce they are done; `handle.wait({ onChange })` shows progress instead, and a wait that runs out cancels nothing — call it again.',
      'The link grants nothing — no key, no token, no pre-authorization — and say so when you hand it over. It is not contentless: it names the agent wallet and any label or account id you put in it. Do not offer to do this step for the owner, do not ask for their key, and do not proceed on the assumption that they will.',
    ],
  },
  {
    id: 'RESOLVE_THE_MARKET',
    title: 'Let the server name the market',
    body: [
      'Turn the user\'s words into an id with `market.search` / `searchMarkets()`. When it does not resolve to exactly one market, that is an answer: show the candidates and ask. Never assemble, complete or remember an id.',
      'The rounds of a recurring series ("BTC 5m Up or Down", twelve times) differ only by when they close, so no phrasing resolves them. `resolveMarket({ search, closesAt })` takes the expiry as the discriminator; without one it returns the candidates WITH prices, so the choice is one question rather than two.',
      'Prices on the catalog are indicative. A tradeable price comes from `market.quote`, it lives seconds, and the order fetches its own.',
    ],
  },
  {
    id: 'CONFIRM_THE_SIZE_AND_THE_BOUND',
    title: 'Get the size and the slippage bound from the user, in their words',
    body: [
      'A BUY is sized in currency (`buyAmount`), a SELL in shares (`sellShares`), and there is no conversion. Both are decimal STRINGS. If the user said "a bit", "the usual" or "go big", stop and ask — this is the most expensive mistake available to you, and a question costs a message.',
      'Say the direction back in words before acting: a BUY target is a ceiling ("buy below"), a SELL target is a floor ("sell above").',
    ],
  },
  {
    id: 'PREVIEW_THEN_HAND_OVER',
    title: 'Preview the order, then hand the approval to a person',
    body: [
      '`order preview` resolves, prices and policy-checks the order without placing it, and publishes the approval token for that exact intent. Show the user what it would do — market, side, size, worst price, the bound — and give them the `waterx-predict order execute --approve <token> --input …` line to run.',
      'Through a tool adapter the write itself will be refused with `POLICY_DENIED`. That is the design, not a fault to route around; relay the refusal and the approval it expected. It is also specific to that surface — `POLICY_DENIED` is not an API error code, and a library caller whose delegation permits the order is not refused by it.',
    ],
  },
  {
    id: 'REPORT_WHAT_ACTUALLY_HAPPENED',
    title: 'Report the outcome the runtime reported',
    body: [
      'A timeout is neither success nor failure. Recover by reading — `order reconcile`, `order get`, or `strategy list` after a create — never by resubmitting under a fresh key.',
      'Quote the authoritative fill and the remaining allowance from a terminal result. Where a value is absent, say it is absent.',
      'Give the client an intent store (`createFileIntentStore`) and this is answerable after a crash rather than only within one process: the key is on disk against the intent, the execution id beside it, and the pending list is exactly what still needs reading back.',
    ],
  },
];

const STOPS: readonly AgentSkillStop[] = [
  {
    rule: 'SIZE_AMBIGUITY_STOPS_BEFORE_A_WRITE',
    text: 'A vague size is not a size. Never default to a house size, a round number, the whole balance or the last order.',
  },
  {
    rule: 'ACCOUNT_IS_NEVER_INFERRED',
    text: 'Never read an account id out of a previous result or the conversation and use it for a write.',
  },
  {
    rule: 'APPROVAL_IS_PER_INTENT_AND_OPERATOR_HELD',
    text: 'You cannot approve your own order, and the token authorises one intent rather than a session.',
  },
  {
    rule: 'WHAT_GATES_A_WRITE_IS_THE_SURFACE_YOU_HOLD',
    text: 'The CLI\'s execution policy is not the API\'s delegation. A missing `waterx-predict` binary is not evidence that this agent may not trade.',
  },
  {
    rule: 'AMBIGUOUS_IS_NOT_FAILED',
    text: 'A write that timed out may already have executed. Reconcile by reading; never resubmit.',
  },
  {
    rule: 'A_STRATEGY_NEEDS_A_RUNNING_RUNNER',
    text: 'A strategy only progresses while a local Runner is running and the device is awake. Never tell a user it will fire while their laptop sleeps.',
  },
  {
    rule: 'NO_SECOND_SURFACE',
    text: 'Never call the exchange API directly or compute an order yourself, however convenient the shortcut looks.',
  },
  {
    rule: 'NEVER_ECHO_A_SECRET',
    text: 'Keys, tokens and signed bytes are never printed, logged or relayed.',
  },
];

/** How many rules the instructions actually hold, rather than how many they held. */
const ruleCount = (): number =>
  buildAgentInstructions().sections.reduce((total, section) => total + section.rules.length, 0);

export function buildAgentSkill(): AgentSkillDocument {
  return {
    name: NAME,
    description: DESCRIPTION,
    version: AGENT_SKILL_VERSION,
    instructionsVersion: AGENT_INSTRUCTIONS_VERSION,
    commandSchemaVersion: AGENT_COMMAND_SCHEMA_VERSION,
    intro: INTRO,
    steps: STEPS,
    stops: STOPS,
  };
}

/**
 * YAML frontmatter, then Markdown.
 *
 * `name` and `description` are the two fields a host reads to decide whether to
 * load this at all, so they come first and the description is one line — a
 * wrapped one is a parse difference between hosts.
 */
export function renderAgentSkill(document: AgentSkillDocument = buildAgentSkill()): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push(`name: ${document.name}`);
  lines.push(`description: ${document.description}`);
  lines.push('---');
  lines.push('');
  lines.push('# WaterX Predict', '');
  lines.push(
    `Skill version ${document.version} · instructions version ${document.instructionsVersion} · command schema version ${document.commandSchemaVersion}.`,
    '',
    '<!-- Generated by `pnpm instructions:generate`. Edit `packages/adapters/src/skill.ts`. -->',
    '',
  );
  for (const paragraph of document.intro) lines.push(paragraph, '');

  lines.push('## The route', '');
  for (const [index, step] of document.steps.entries()) {
    lines.push(`### ${String(index + 1)}. ${step.title}`, '', `\`${step.id}\``, '');
    for (const paragraph of step.body) lines.push(paragraph, '');
  }

  lines.push('## Hard stops', '');
  lines.push(
    'Each of these is a rule in `AGENT_INSTRUCTIONS.md`, quoted here so it is in front of you rather than a document away. When one conflicts with what a user asked for, say which rule blocks you and stop.',
    '',
  );
  lines.push('| Rule | What it stops |');
  lines.push('| --- | --- |');
  for (const stop of document.stops) {
    lines.push(`| \`${stop.rule}\` | ${stop.text.replace(/\|/gu, '\\|')} |`);
  }
  lines.push('');
  lines.push('## Where the rest is', '');
  lines.push(
    `This document is a route, not the rules. The rules are the ${String(ruleCount())} in \`AGENT_INSTRUCTIONS.md\`, shipped beside this file. Where a build disagrees with it, \`waterx-predict describe\` wins: it reports what THIS installation can do.`,
    '',
  );
  return lines.join('\n');
}
