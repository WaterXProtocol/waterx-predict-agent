/**
 * `waterx-predict policy` — what this runtime may sign, and the three modes it
 * could be in. And `policy set`, the one command that changes it.
 *
 * Why this exists at all: before it, nothing in this package could turn writes
 * on. `next` ended its READY answer with "the operator sets
 * WATERX_PREDICT_POLICY=interactive" — an `export` a tool host cannot perform
 * (ADR-0020 removed exactly that advice everywhere else), and `configure`
 * deliberately refuses to write the policy. So the documented loop — run
 * `next`, do the one thing it says, run it again — ended one step short of a
 * trade, with no command anywhere that closed the gap (ADR-0021).
 *
 * Two commands rather than one, because they have different readers and
 * different rights:
 *
 * - `policy` is a READ, so `next` may suggest it. A relaying agent then hands
 *   its operator three options with what each allows, instead of the single
 *   mode a sentence happened to name. Choosing is the person's part, and a
 *   decision needs all of its options in front of it.
 * - `policy set` is a WRITE, and a person's. It decides what may be signed with
 *   real funds, which is the one thing an agent must not widen for itself
 *   (ADR-0003, ADR-0017, ADR-0020).
 *
 * The three are not neutral radio buttons, and this module does not render them
 * as such: they are listed in rank order, each saying what it allows, because
 * `delegated-auto` is the one where this process signs against real money with
 * nobody watching. Hiding it leaves the people who need it unable to find it;
 * flattening it nudges everyone toward it.
 */
import { CliError } from '../errors.ts';
import { POLICY_STRICTNESS, type PolicyMode } from '../policy.ts';
import type { CommandContext } from '../context.ts';

/** One mode, as something a person can choose between. */
export interface PolicyChoice {
  readonly mode: PolicyMode;
  readonly current: boolean;
  /** What it allows, in the terms the decision is actually made in. */
  readonly means: string;
  /** What it costs — the reason not to take it. Empty for none. */
  readonly costs: string;
  /**
   * The command that takes it, printed unwrapped and never assembled by the
   * caller: a command split across a terminal wrap is one nobody can copy.
   */
  readonly command: string;
  /** Present when it cannot be taken yet. */
  readonly requires?: string;
}

const MEANS: Readonly<Record<PolicyMode, { means: string; costs: string }>> = {
  'read-only': {
    means: 'Reads and previews. No order is placed, and nothing is ever signed.',
    costs: 'This runtime cannot trade at all. Everything else still works: search, quotes, previews, positions.',
  },
  interactive: {
    means:
      'One previewed order per approval. `order preview` issues a token; `order execute --approve <token> --approver <name>` spends it once, within ten minutes.',
    costs:
      'A person is in the loop for every order — which is the point. An agent still cannot sign on its own: the approval is the human half, and no tool call can supply it.',
  },
  'delegated-auto': {
    means:
      'This runtime signs without asking, inside a scope written down beforehand: which accounts, which sides, per-order and cumulative ceilings, a slippage bound and an expiry.',
    costs:
      'It signs against real money with nobody watching. Anything the scope does not name is refused, and the cumulative budget is counted across invocations — but inside those ceilings there is no second pair of eyes.',
  },
};

const isWider = (from: PolicyMode, to: PolicyMode): boolean =>
  POLICY_STRICTNESS.indexOf(to) > POLICY_STRICTNESS.indexOf(from);

const setCommand = (mode: PolicyMode, from: PolicyMode): string =>
  `waterx-predict policy set --mode ${mode}${isWider(from, mode) ? ' --yes' : ''}`;

/**
 * The scope a delegated-auto policy must carry before it authorizes anything.
 * Named where the option is offered, rather than left for the refusal.
 */
const SCOPE_REQUIREMENT =
  'a `policy.scope` in the config file first: accounts, sides, maxBuyAmount and maxCumulativeBuyAmount for BUY, maxSellShares for SELL, maxSlippageBps, maxLegs and notAfter. An auto-approving policy with no stated ceilings is refused.';

/**
 * Break prose to a width a terminal holds, so it does not wrap mid-sentence.
 *
 * A COMMAND never goes through this: a command split across a wrap is one
 * nobody can copy, which is the rule the authorization link is already under
 * (ADR-0024).
 */
const wrap = (text: string, width: number): string[] => {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line === '') line = word;
    else if (`${line} ${word}`.length > width) {
      lines.push(line);
      line = word;
    } else line = `${line} ${word}`;
  }
  if (line !== '') lines.push(line);
  return lines;
};

/**
 * The width a line may reach, indent included. Derived rather than guessed at:
 * the prose is wrapped to what is left after the mode's column, so the whole
 * screen fits an 80-column terminal by construction.
 */
const TERMINAL_WIDTH = 80;

/**
 * The choosing screen, as lines.
 *
 * Rendered rather than only serialized: the person making this decision is at a
 * terminal, and the agent relaying it should be able to pass the screen on
 * VERBATIM instead of paraphrasing three descriptions of what may be signed
 * with real money (ADR-0026). A pure function, so what it says is a tested
 * claim rather than a string typed into a diagnostic.
 */
export const renderChooser = (input: {
  readonly current: PolicyMode;
  readonly source: string;
  readonly realFunds: boolean;
  readonly configFile: string | null;
  readonly choices: readonly PolicyChoice[];
}): string[] => {
  const lines: string[] = [
    '',
    `  policy     ${input.current}${input.realFunds ? ' \u2014 on mainnet, where an order spends real funds' : ''}`,
    `  chosen by  ${input.source === 'DEFAULT' ? 'nobody: this is the default' : input.source.toLowerCase().replace(/_/gu, ' ')}`,
    ...(input.configFile === null ? [] : [`  file       ${input.configFile}`]),
    '',
    "  Pick one. This is a person's decision, not the agent's:",
    '',
  ];
  for (const choice of input.choices) {
    const head = `  ${choice.current ? '\u2192' : ' '} ${choice.mode.padEnd(15)}`;
    const pad = ' '.repeat(head.length);
    const width = TERMINAL_WIDTH - pad.length;
    const [first, ...rest] = wrap(choice.means, width);
    lines.push(`${head}${first ?? ''}`);
    for (const line of rest) lines.push(`${pad}${line}`);
    for (const line of wrap(`costs: ${choice.costs}`, width)) lines.push(`${pad}${line}`);
    if (choice.requires !== undefined) {
      for (const line of wrap(`needs ${choice.requires}`, width)) lines.push(`${pad}${line}`);
    }
    // Unwrapped, always, and on a line of its own: this is what gets copied.
    lines.push(`${pad}${choice.command}`);
    lines.push('');
  }
  return lines;
};

export const policyChoices = (current: PolicyMode, hasScope: boolean): PolicyChoice[] =>
  POLICY_STRICTNESS.map((mode) => ({
    mode,
    current: mode === current,
    ...MEANS[mode],
    command: setCommand(mode, current),
    ...(mode === 'delegated-auto' && !hasScope ? { requires: SCOPE_REQUIREMENT } : {}),
  }));

/** The chooser. Reports; changes nothing. */
export function runtimePolicy(context: CommandContext): Promise<unknown> {
  const policy = context.config.policy;
  // Not one of the choices: taking one is the operator's, and the commands that
  // take a wider mode carry `--yes` — which `pointTo` refuses anyway (ADR-0022).
  context.pointTo('waterx-predict next');
  const realFunds = context.config.network === 'mainnet' || context.config.deploymentSource === 'DEFAULT';
  const choices = policyChoices(policy.mode, policy.hasConfiguredScope);
  // The screen, one line per call: a diagnostic is truncated past 2000
  // characters, which would cut the third option off the bottom (ADR-0026).
  for (const line of renderChooser({
    current: policy.mode,
    source: policy.source,
    realFunds,
    configFile: context.configFile?.path ?? null,
    choices,
  })) {
    // No trailing newline: the diagnostic writer adds one, and a second would
    // double-space the whole screen.
    context.diagnostic(line);
  }
  return Promise.resolve({
    current: {
      mode: policy.mode,
      source: policy.source,
      // The scope itself is the operator's document; what belongs here is
      // whether one exists, because that is what decides which options are open.
      hasScope: policy.hasConfiguredScope,
      scopeExpiresAt: policy.scope?.notAfter ?? null,
    },
    realFunds,
    configFile: context.configFile?.path ?? null,
    who: 'AGENT_OPERATOR',
    why:
      policy.mode === 'read-only'
        ? 'This runtime places no order in read-only. The three modes below are the choice, and it is the operator’s.'
        : 'These are the modes this runtime can be in. Narrowing takes effect immediately and needs no confirmation.',
    choices,
  });
}

/** The setter. A person runs it. */
export async function runtimePolicySet(context: CommandContext): Promise<unknown> {
  const requested = (context.input as { mode: PolicyMode }).mode;
  const policy = context.config.policy;
  const file = context.configFile;
  if (file === undefined) {
    throw new CliError(
      'NOT_CONFIGURED',
      'This machine has nowhere to keep a config file, so there is nowhere to record a policy. Set WATERX_PREDICT_CONFIG to a path this user can write.',
    );
  }

  // Refused where the option cannot be taken, rather than at the first order.
  if (requested === 'delegated-auto' && !policy.hasConfiguredScope) {
    throw new CliError(
      'NOT_CONFIGURED',
      `\`delegated-auto\` needs ${SCOPE_REQUIREMENT} Write the scope into ${file.path}, then set the mode.`,
      { configFile: file.path },
    );
  }

  const widening = isWider(policy.mode, requested);
  if (widening && !context.confirmed) {
    throw new CliError(
      'POLICY_DENIED',
      `Widening the execution policy from \`${policy.mode}\` to \`${requested}\` is a person’s decision, so it needs \`--yes\`: ${setCommand(requested, policy.mode)}. ${
        requested === 'delegated-auto'
          ? 'Under delegated-auto this runtime signs orders with nobody watching, inside the configured scope.'
          : 'Under interactive it signs one previewed order per human approval.'
      }`,
      { from: policy.mode, to: requested, confirmWith: setCommand(requested, policy.mode) },
    );
  }

  const raw = file.read();
  let existing: Record<string, unknown> = {};
  if (raw !== null && raw.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CliError(
        'CONFIG_INVALID',
        `The config file at ${file.path} is not valid JSON, so it cannot be edited safely. Fix or move it aside first.`,
        { file: file.path },
      );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CliError('CONFIG_INVALID', `The config file at ${file.path} must be a JSON object.`, {
        file: file.path,
      });
    }
    existing = { ...(parsed as Record<string, unknown>) };
  }

  // The scope is untouched. It is the operator's document, and rewriting it
  // from a mode change would silently reset a budget that is counted against it.
  const held = (existing['policy'] ?? {}) as Record<string, unknown>;
  const changed = held['mode'] !== requested;
  if (changed) {
    file.write(`${JSON.stringify({ ...existing, policy: { ...held, mode: requested } }, null, 2)}\n`);
  }

  context.pointTo('waterx-predict next');
  // The environment beats the file (`config.ts`), so a write it will shadow
  // must not report as a policy that now applies.
  const shadowed = policy.source === 'ENVIRONMENT' || policy.source === 'FLAG';
  return {
    configFile: file.path,
    mode: requested,
    previous: policy.mode,
    changed,
    widened: widening,
    ...(shadowed
      ? {
          shadowedBy: policy.source,
          warning: `The policy in force comes from ${
            policy.source === 'FLAG' ? 'the --policy flag' : 'WATERX_PREDICT_POLICY'
          }, which beats the config file. Until that is unset, this runtime keeps running as \`${policy.mode}\`.`,
        }
      : {}),
    ...(widening && (context.config.network === 'mainnet' || context.config.deploymentSource === 'DEFAULT')
      ? {
          realFunds:
            'This deployment is mainnet. From here an order spends real funds, under the approvals this mode requires.',
        }
      : {}),
  };
}
