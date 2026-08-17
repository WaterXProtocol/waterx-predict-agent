/**
 * argv → a path and a flag map, and nothing more.
 *
 * No interpretation happens here: values stay strings, unknown flags are not
 * rejected yet (the command's schema decides what is known), and nothing is
 * coerced. Separating tokenizing from meaning is what lets `--limit abc` fail
 * with "expected an integer" instead of silently becoming NaN.
 */
import { CliError } from './errors.ts';

export interface ParsedArgv {
  /** Positional tokens, in order. The command path lives at the front. */
  readonly path: readonly string[];
  /** Flag name (without `--`) to value. `true` means the flag was bare. */
  readonly flags: ReadonlyMap<string, string | true>;
}

/** Flags the dispatcher owns. Everything else must be a command input field. */
export const GLOBAL_FLAGS = new Set([
  'config',
  'file',
  'input',
  'stdin',
  'timeout-ms',
  'help',
  'version',
  'json',
  // Both belong to the execution policy rather than to any intent: `--approve`
  // carries assent to an order that was already previewed, and `--policy` can
  // only narrow what the configuration already allows.
  'approve',
  'policy',
  // Which local Runner the strategy family talks to. An address, not part of any
  // intent: the same strategy sent to two runtime directories is two strategies,
  // and neither the schema nor the Runner should have to know how it was reached.
  'runner-dir',
]);

export function parseArgv(argv: readonly string[]): ParsedArgv {
  const path: string[] = [];
  const flags = new Map<string, string | true>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;

    if (token === '--') {
      // Everything after `--` is positional. Nothing uses it today; treating it
      // as a terminator now keeps the option open without a breaking change.
      path.push(...argv.slice(index + 1));
      break;
    }

    if (token === '-h') {
      flags.set('help', true);
      continue;
    }

    if (!token.startsWith('--')) {
      path.push(token);
      continue;
    }

    const body = token.slice(2);
    if (body === '') {
      throw new CliError('USAGE', 'A bare `--` flag has no name.');
    }

    const equals = body.indexOf('=');
    if (equals !== -1) {
      const name = body.slice(0, equals);
      if (name === '') throw new CliError('USAGE', `\`${token}\` has no flag name.`);
      flags.set(name, body.slice(equals + 1));
      continue;
    }

    const next = argv[index + 1];
    // A following token that itself looks like a flag is the NEXT flag, not this
    // one's value. `--stdin --limit 5` must not read `--limit` as stdin's value.
    if (next === undefined || next.startsWith('--')) {
      flags.set(body, true);
      continue;
    }
    flags.set(body, next);
    index += 1;
  }

  return { path, flags };
}

/** A flag that must carry a value, e.g. `--config`. */
export function requireFlagValue(
  flags: ReadonlyMap<string, string | true>,
  name: string,
): string | undefined {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  if (value === true) throw new CliError('USAGE', `\`--${name}\` needs a value.`);
  return value;
}
