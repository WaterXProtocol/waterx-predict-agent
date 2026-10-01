/**
 * Building a command's input from an invocation.
 *
 * Three sources, applied in order: a JSON document (`--input`, `--file`,
 * `--stdin`), then defaults the CLI can justify, then typed flags. Flags win
 * because they are the most specific thing the caller typed.
 *
 * THE RULE THAT MATTERS: a flag's value is converted according to the type the
 * command schema declares, and a value that does not match that type is an
 * error. `--limit abc` fails; it does not become `NaN`, `0` or the string
 * `"abc"` for the schema to reject later with a worse message. Nothing here ever
 * guesses — a runtime that coerces its way to a valid-looking order is how a
 * caller ends up trading a size they did not type.
 */
import {
  COMMAND_SCHEMA_DEFS,
  validateCommandInput,
  type AgentCommandSpec,
  type JsonSchema,
} from '@waterx/predict-agent-schema';

import { CliError } from './errors.ts';
import { GLOBAL_FLAGS, requireFlagValue } from './parse.ts';

export interface InputSources {
  readonly flags: ReadonlyMap<string, string | true>;
  /** Reads a file as UTF-8, or throws a CliError the caller can surface. */
  readFile(path: string): string;
  readStdin(): Promise<string>;
  /** Applied to `accountId` when the command needs one and none was given. */
  readonly defaultAccountId: string | undefined;
  /**
   * The account this agent ADOPTED, consulted only when nothing else named one.
   *
   * `onboard` records the account an owner granted and says it has been adopted
   * — and then every command still refused without `--accountId`, so the word
   * meant nothing to anyone following the setup. The record was already
   * durable; nothing read it back.
   *
   * Last in the order on purpose, and it widens nothing. ADR-0015 already
   * settles which account this agent trades: the first authorized one is
   * adopted, and a DIFFERENT one later is never taken up without being named.
   * So this fills in the account that rule has already chosen, and an operator
   * who names another still overrides it.
   *
   * A thunk because reading it costs a file: a command that names its account,
   * or does not take one, must not pay for a ledger it will not use — and a
   * machine with no state directory has no ledger to read and must still run.
   */
  readonly adoptedAccountId?: () => string | undefined;
  /**
   * Applied to `agentWallet` the same way. Justified because it is the SAME
   * value this CLI already hands the signer: a strategy created under a
   * different wallet than the one that can sign for it is a job that refuses at
   * the trigger, hours later. `ownerAddress` is deliberately NOT defaulted —
   * nothing in this configuration knows who the owner is, and inventing one
   * would attribute a trade to the wrong account.
   */
  readonly defaultAgentWallet: string | undefined;
}

export interface BuiltInput {
  readonly input: Readonly<Record<string, unknown>>;
  /** Values this CLI supplied. Surfaced in `meta.defaultsApplied`, never silent. */
  readonly defaultsApplied: Readonly<Record<string, unknown>>;
}

/** `#/$defs/x` → the definition. Anything else is a bug in the contract. */
function resolve(schema: JsonSchema): JsonSchema {
  if (schema.$ref === undefined) return schema;
  const name = schema.$ref.replace('#/$defs/', '');
  const target = COMMAND_SCHEMA_DEFS[name];
  if (target === undefined) {
    throw new CliError('INTERNAL', `The command contract references an unknown definition: ${name}`);
  }
  return resolve(target);
}

function convert(name: string, raw: string | true, schema: JsonSchema): unknown {
  const resolved = resolve(schema);
  const type = resolved.type;

  if (type === 'boolean') {
    // A bare `--tradeable` is unambiguous for a boolean, and only for a boolean.
    if (raw === true) return true;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new CliError(
      'USAGE',
      `\`--${name}\` is a boolean: pass \`--${name}\`, \`--${name} true\` or \`--${name} false\`, not \`${raw}\`.`,
    );
  }

  if (raw === true) {
    throw new CliError('USAGE', `\`--${name}\` needs a value.`);
  }

  if (type === 'integer') {
    if (!/^-?\d+$/u.test(raw)) {
      throw new CliError(
        'USAGE',
        `\`--${name}\` is a whole number; \`${raw}\` is not one. It is not rounded or truncated.`,
      );
    }
    return Number(raw);
  }

  if (type === 'number') {
    const parsed = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(parsed)) {
      throw new CliError('USAGE', `\`--${name}\` is a number; \`${raw}\` is not one.`);
    }
    return parsed;
  }

  if (type === 'object' || type === 'array') {
    throw new CliError(
      'USAGE',
      `\`--${name}\` is structured and cannot be typed as a flag. Pass the whole input with \`--input '<json>'\`, \`--file <path>\` or \`--stdin\`.`,
    );
  }

  // Strings — including every decimal amount and price — are passed through
  // exactly as typed. Parsing a money string into a JS number here would lose
  // precision before the schema ever saw it.
  return raw;
}

async function readBaseDocument(sources: InputSources): Promise<Record<string, unknown>> {
  const inline = requireFlagValue(sources.flags, 'input');
  const file = requireFlagValue(sources.flags, 'file');
  const stdin = sources.flags.get('stdin') !== undefined;

  const chosen = [
    inline !== undefined ? 'input' : null,
    file !== undefined ? 'file' : null,
    stdin ? 'stdin' : null,
  ].filter((entry): entry is string => entry !== null);

  if (chosen.length === 0) return {};
  if (chosen.length > 1) {
    throw new CliError(
      'USAGE',
      `Only one input source may be used at a time; got ${chosen.map((entry) => `--${entry}`).join(' and ')}.`,
    );
  }

  const raw =
    inline !== undefined
      ? inline
      : file !== undefined
        ? sources.readFile(file)
        : await sources.readStdin();

  if (raw.trim() === '') {
    throw new CliError('USAGE', `The input from --${chosen[0] ?? 'input'} was empty.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw new CliError(
      'USAGE',
      `The input is not valid JSON: ${error instanceof Error ? error.message : 'parse failed'}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError('USAGE', 'The input must be a JSON object.');
  }
  return { ...(parsed as Record<string, unknown>) };
}

/**
 * Assemble and validate. The returned input is the caller's, unchanged apart
 * from the defaults that are reported back — `validateCommandInput` does not
 * coerce, and neither does this.
 */
export async function buildCommandInput(
  command: AgentCommandSpec,
  sources: InputSources,
): Promise<BuiltInput> {
  const properties = command.input.properties ?? {};
  const input = await readBaseDocument(sources);

  for (const [name, raw] of sources.flags) {
    if (GLOBAL_FLAGS.has(name)) continue;
    const schema = properties[name];
    if (schema === undefined) {
      const known = Object.keys(properties);
      throw new CliError(
        'USAGE',
        known.length === 0
          ? `\`${command.cli}\` takes no input fields, so \`--${name}\` is not one.`
          : `\`--${name}\` is not a field of \`${command.cli}\`. Known fields: ${known.map((field) => `--${field}`).join(', ')}.`,
        { command: command.name, flag: name },
      );
    }
    input[name] = convert(name, raw, schema);
  }

  const defaultsApplied: Record<string, unknown> = {};
  const wantsAccount = Object.hasOwn(properties, 'accountId');
  if (wantsAccount && input.accountId === undefined) {
    /**
     * Configuration first, then the adoption. An operator who wrote the account
     * down meant that one; the ledger only answers when nobody has.
     *
     * `next` and `onboard` are excluded from the ADOPTION, and the exclusion is
     * the same shape as `runtime.configure`'s: these commands exist to DECIDE
     * which account this agent trades, so handing them the current answer begs
     * the question they were asked. Concretely — ADR-0015 §3 says a different
     * authorized account is never taken up unless it is named, and `next`
     * reports `ACCOUNT_CHOICE_NEEDED` to make the operator choose. Fed the
     * adopted account, it reads one the owner has moved away from and answers
     * `ACCOUNT_UNREADABLE`: a decision turned into a fault.
     *
     * They still honour configuration, which is a thing somebody typed.
     */
    const decidesTheAccount = command.name === 'runtime.next' || command.name === 'runtime.onboard';
    const account = sources.defaultAccountId ?? (decidesTheAccount ? undefined : sources.adoptedAccountId?.());
    if (account !== undefined) {
      input.accountId = account;
      defaultsApplied.accountId = account;
    }
  }
  /**
   * `runtime.configure` is excluded on purpose: filling its `agentWallet` in
   * from the configured wallet would hand the command the value it exists to
   * SET, and a caller asking to take the wallet from the keystore would find an
   * address it never named already in its input.
   */
  const wantsWallet = Object.hasOwn(properties, 'agentWallet') && command.name !== 'runtime.configure';
  if (wantsWallet && input.agentWallet === undefined && sources.defaultAgentWallet !== undefined) {
    input.agentWallet = sources.defaultAgentWallet;
    defaultsApplied.agentWallet = sources.defaultAgentWallet;
  }

  const result = validateCommandInput(command.name, input);
  if (!result.ok) {
    throw new CliError('INVALID_INPUT', result.message, {
      command: command.name,
      violations: result.violations,
      ...wayOut(command.name, input, result.violations),
    });
  }

  return { input: result.input as Record<string, unknown>, defaultsApplied };
}

/**
 * The other command, when a refusal is really a caller at the wrong door.
 *
 * A contract violation says what is wrong with the input and nothing about what
 * the caller wanted. Usually that is right — there is no second guess to make.
 * `market search` with no `search` is the exception: it is not a malformed
 * search, it is a request to BROWSE, and browsing has its own command. Told
 * only "`search` is required", a caller adds a keyword it had no reason to
 * invent, and a guessed keyword against a catalog resolves to a market nobody
 * asked for.
 *
 * Deliberately narrow. This names an alternative only where the contract makes
 * one certain, and never softens the refusal: the input is still invalid and
 * nothing was sent.
 */
function wayOut(
  command: string,
  input: Readonly<Record<string, unknown>>,
  violations: readonly { readonly path?: string }[],
): { tryInstead?: { command: string; why: string } } {
  if (command !== 'market.search' || input.search !== undefined) return {};
  if (!violations.some((violation) => violation.path === '/search' || violation.path === '')) return {};
  return {
    tryInstead: {
      command: 'market list',
      why: '`market search` resolves one named market and needs the name. Browsing the catalog without one is `market list`, which takes `--category`, `--status` and `--tradeable`.',
    },
  };
}
