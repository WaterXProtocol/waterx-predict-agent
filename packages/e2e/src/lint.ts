/**
 * Check an invocation against the command contract WITHOUT running it.
 *
 * This exists because of a real defect: an ambiguous write returned
 * `order reconcile --execution-id <id>` as the recovery instruction, and that
 * spelling is not a field of `order reconcile`, so the one command a caller runs
 * while holding an order of unknown outcome exited USAGE. A string that names a
 * command is not a command that runs.
 *
 * So every invocation this repository publishes — the harness's own steps and
 * every shipped example — is linted against the same source the CLI validates
 * against, using the CLI's own tokenizer. A second tokenizer would be a second
 * opinion, and the point is to have one.
 */
import { GLOBAL_FLAGS, parseArgv } from '@waterx/predict-agent-cli';
import {
  AGENT_COMMANDS,
  COMMAND_SCHEMA_DEFS,
  type AgentCommandSpec,
  type JsonSchema,
} from '@waterx/predict-agent-schema';

export interface LintViolation {
  readonly kind: 'UNKNOWN_COMMAND' | 'UNKNOWN_FLAG' | 'STRUCTURED_FLAG';
  readonly message: string;
}

const BY_CLI_PATH = new Map(AGENT_COMMANDS.map((command) => [command.cli, command]));

/** Longest match first, exactly as the dispatcher resolves it. */
export function resolveCliPath(path: readonly string[]): AgentCommandSpec | undefined {
  return BY_CLI_PATH.get(path.slice(0, 2).join(' ')) ?? BY_CLI_PATH.get(path[0] ?? '');
}

/** `#/$defs/x` → the definition, so a `$ref`'d type is seen as its real type. */
function resolveSchema(schema: JsonSchema): JsonSchema {
  if (schema.$ref === undefined) return schema;
  const target = COMMAND_SCHEMA_DEFS[schema.$ref.replace('#/$defs/', '')];
  return target === undefined ? schema : resolveSchema(target);
}

/**
 * Lint one invocation, given WITHOUT the program name.
 *
 * Values are not checked — that is the schema's job at runtime, and a lint that
 * needed real ids could not run before provisioning. What is checked is the
 * thing a human gets wrong in documentation: a command that does not exist, and
 * a flag that is not a field of it.
 */
export function lintInvocation(argv: readonly string[]): readonly LintViolation[] {
  const violations: LintViolation[] = [];
  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (error: unknown) {
    return [
      {
        kind: 'UNKNOWN_COMMAND',
        message: error instanceof Error ? error.message : 'The invocation could not be tokenized.',
      },
    ];
  }

  const spec = resolveCliPath(parsed.path);
  if (spec === undefined) {
    return [
      {
        kind: 'UNKNOWN_COMMAND',
        message: `\`${parsed.path.join(' ')}\` is not a command in the contract.`,
      },
    ];
  }

  const properties = spec.input.properties ?? {};
  for (const [name] of parsed.flags) {
    if (GLOBAL_FLAGS.has(name)) continue;
    const schema = properties[name];
    if (schema === undefined) {
      const known = Object.keys(properties);
      violations.push({
        kind: 'UNKNOWN_FLAG',
        message:
          known.length === 0
            ? `\`${spec.cli}\` takes no input fields, so \`--${name}\` is not one.`
            : `\`--${name}\` is not a field of \`${spec.cli}\`. Known fields: ${known
                .map((field) => `--${field}`)
                .join(', ')}.`,
      });
      continue;
    }
    const type = resolveSchema(schema).type;
    if (type === 'object' || type === 'array') {
      violations.push({
        kind: 'STRUCTURED_FLAG',
        message: `\`--${name}\` is structured and cannot be a flag. Pass the whole document with \`--input '<json>'\`.`,
      });
    }
  }

  return violations;
}

const NEEDLE = 'waterx-predict ';

/**
 * The first words a real invocation can start with.
 *
 * Used to tell an invocation from prose that happens to name the binary — "the
 * waterx-predict binary is installed" is a sentence, not a command, and a linter
 * that reported UNKNOWN_COMMAND for `binary` would be noise nobody reads.
 *
 * The cost is that a misspelled ROOT (`waterx-predict odrer preview`) is skipped
 * rather than flagged. A misspelled SUBCOMMAND or FLAG still is — and the flag
 * is what the defect this linter exists for actually was.
 */
const COMMAND_ROOTS = new Set(AGENT_COMMANDS.map((command) => command.cli.split(' ')[0] ?? ''));

/**
 * Every `waterx-predict …` invocation appearing in a text — a shell script, a
 * README, a comment.
 *
 * Backslash continuations are joined first, because an example that spans lines
 * is still one command. Every occurrence on a line is taken, not just the first:
 * `id=$(waterx-predict market search …)` is an invocation someone will run, and
 * a linter that only saw the outer command would bless the inner one unchecked.
 */
export function extractInvocations(text: string): readonly (readonly string[])[] {
  const joined = text.replace(/\\\n\s*/gu, ' ');
  const found: string[][] = [];
  for (const line of joined.split('\n')) {
    const stripped = line.replace(/^\s*(?:#|\/\/|\*)\s?/u, '');
    for (let at = stripped.indexOf(NEEDLE); at !== -1; at = stripped.indexOf(NEEDLE, at + 1)) {
      const tail = stripped.slice(at + NEEDLE.length);
      // An invocation quoted INSIDE another string — `say "run waterx-predict
      // order reconcile --executionId $ID"` — ends on a quote that belongs to
      // the outer command. Those lines are exactly the documented recovery
      // instructions this linter exists for, so a lone trailing quote is dropped
      // and the line retried rather than skipped as unparseable.
      const tokens =
        tokenize(tail).length > 0 ? tokenize(tail) : tokenize(tail.replace(/["']\s*$/u, ''));
      // A computed path — `"$CLI" "$@"` — has nothing static to check, and
      // prose is not an invocation at all.
      if (tokens.length > 0 && COMMAND_ROOTS.has(tokens[0] ?? '')) found.push(tokens);
    }
  }
  return found;
}

/**
 * Shell-ish word splitting, stopping where the command does.
 *
 * Quotes group; `$(` opens a nesting level; and outside quotes a shell operator
 * or a `)` that closes a level this command never opened ENDS the invocation —
 * what follows belongs to the surrounding shell, not to the command being
 * linted. Enough to see the command path and the flag NAMES, which is all
 * `lintInvocation` reads: a flag's VALUE is the schema's business at runtime,
 * and here it is usually a shell variable anyway.
 *
 * A line whose quoting does not balance yields nothing rather than a guess.
 */
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  let depth = 0;

  const flush = (): void => {
    if (started || current !== '') tokens.push(current);
    current = '';
    started = false;
  };

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? '';

    if (quote === null && (char === '"' || char === "'")) {
      quote = char;
      started = true;
      continue;
    }
    if (quote === char) {
      quote = null;
      continue;
    }
    if (quote !== null) {
      current += char;
      continue;
    }

    if (char === '$' && line[index + 1] === '(') {
      depth += 1;
      current += '$(';
      index += 1;
      continue;
    }
    if (char === ')') {
      if (depth === 0) break;
      depth -= 1;
      current += char;
      continue;
    }
    if (depth === 0 && (char === '>' || char === '<')) {
      // A redirection may carry a file descriptor glued to its left — `2>` in
      // `waterx-predict describe 2>/dev/null`. That digit belongs to the
      // redirection, not to the command, and reporting `2` as an argument would
      // invent a violation about something nobody wrote.
      if (/^\d+$/u.test(current)) {
        current = '';
        started = false;
      }
      break;
    }
    if (depth === 0 && (char === '|' || char === ';' || char === '&')) break;
    if (/\s/u.test(char)) {
      flush();
      continue;
    }
    current += char;
  }

  if (quote !== null) return [];
  flush();
  return tokens;
}
