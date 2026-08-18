#!/usr/bin/env node
/**
 * `waterx-predict-tools` — the generic function-calling adapter.
 *
 * A host that is not MCP still needs two things: the tool definitions to give
 * its model, and somewhere to send the tool call the model produces. This
 * binary is those two things over stdout, in the shape the host already
 * speaks — so wiring an OpenAI or Anthropic agent to this runtime is a
 * `tools --format` and a `call`, with no code that knows how an order works.
 *
 *   waterx-predict-tools instructions [--format markdown|json]
 *   waterx-predict-tools tools [--format openai|anthropic|mcp|neutral]
 *   waterx-predict-tools call <tool> --input '<json>'
 *
 * `call` writes one JSON document to stdout and exits with the command core's
 * own exit code, so a shell caller branches on the same table the CLI
 * publishes. It never writes an approval token, and there is no flag to give
 * it one.
 */
import { createCliInvoker } from '../core.ts';
import { createToolDispatcher, type ToolCallOutcome } from '../dispatch.ts';
import { buildAgentInstructions, renderAgentInstructions } from '../instructions.ts';
import {
  AGENT_TOOLS,
  toAnthropicTools,
  toMcpTools,
  toOpenAiTools,
  type AgentToolDefinition,
} from '../tools.ts';

/**
 * Mirrors the CLI's published table for the three outcomes that never reach
 * the core. `CORE_OUTPUT_UNREADABLE` is AMBIGUOUS rather than an error: the
 * call may have executed.
 */
const EXIT = { OK: 0, USAGE: 1, INVALID_INPUT: 2, AMBIGUOUS: 11 } as const;

const USAGE = [
  'waterx-predict-tools — function-calling adapter over the WaterX Predict command core.',
  '',
  '  instructions [--format markdown|json]   Host-neutral agent instructions.',
  '  tools [--format openai|anthropic|mcp|neutral]',
  '                                          Tool definitions, from the command contract.',
  "  call <tool> --input '<json>'            Run one tool through the command core.",
  '',
  'Operator flags, passed to the core unchanged: --config, --policy, --timeout-ms, --runner-dir.',
  'There is no approval flag. An approval authorises one exact intent and is given per order,',
  'at the command core, by a person.',
].join('\n');

interface Parsed {
  readonly positional: readonly string[];
  readonly flags: ReadonlyMap<string, string>;
  readonly operatorArgs: readonly string[];
}

const OPERATOR_FLAGS = new Set(['--config', '--policy', '--timeout-ms', '--runner-dir']);

function parse(argv: readonly string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const operatorArgs: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (OPERATOR_FLAGS.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`\`${arg}\` needs a value.`);
      operatorArgs.push(arg, value);
      index += 1;
    } else if (arg.startsWith('--')) {
      const [name, inline] = arg.includes('=') ? splitOnce(arg, '=') : [arg, undefined];
      if (inline !== undefined) {
        flags.set(name.slice(2), inline);
      } else {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) {
          flags.set(name.slice(2), '');
        } else {
          flags.set(name.slice(2), value);
          index += 1;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags, operatorArgs };
}

function splitOnce(value: string, separator: string): [string, string] {
  const at = value.indexOf(separator);
  return [value.slice(0, at), value.slice(at + separator.length)];
}

const write = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

function renderTools(format: string): readonly unknown[] | AgentToolDefinition[] {
  switch (format) {
    case 'openai':
      return toOpenAiTools();
    case 'anthropic':
      return toAnthropicTools();
    case 'mcp':
      return toMcpTools();
    case 'neutral':
      return [...AGENT_TOOLS];
    default:
      throw new Error(`Unknown --format \`${format}\`. Use openai, anthropic, mcp or neutral.`);
  }
}

function refusalExit(outcome: Extract<ToolCallOutcome, { source: 'ADAPTER' }>): number {
  if (outcome.code === 'UNKNOWN_TOOL') return EXIT.USAGE;
  if (outcome.code === 'INVALID_INPUT') return EXIT.INVALID_INPUT;
  return EXIT.AMBIGUOUS;
}

async function main(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write(`${USAGE}\n`);
    return argv.length === 0 ? EXIT.USAGE : EXIT.OK;
  }

  const { positional, flags, operatorArgs } = parse(argv);
  const subcommand = positional[0];

  if (subcommand === 'instructions') {
    const format = flags.get('format') ?? 'markdown';
    if (format === 'json') write(buildAgentInstructions());
    else if (format === 'markdown') process.stdout.write(renderAgentInstructions());
    else throw new Error(`Unknown --format \`${format}\`. Use markdown or json.`);
    return EXIT.OK;
  }

  if (subcommand === 'tools') {
    write(renderTools(flags.get('format') ?? 'neutral'));
    return EXIT.OK;
  }

  if (subcommand === 'call') {
    const tool = positional[1];
    if (tool === undefined) throw new Error('`call` needs a tool name.');
    const raw = flags.get('input');
    if (raw === undefined) throw new Error("`call` needs `--input '<json>'`.");
    let input: unknown;
    try {
      input = raw.trim() === '' ? {} : JSON.parse(raw);
    } catch (error) {
      throw new Error(`--input is not valid JSON: ${(error as Error).message}`);
    }

    const dispatcher = createToolDispatcher({
      invoke: createCliInvoker({ env: process.env, operatorArgs }),
    });
    const outcome = await dispatcher.call(tool, input);
    write(outcome);
    // The core's exit code, verbatim — including the non-zero codes that
    // accompany an `ok` envelope, which is how a partially filled batch says
    // that not every leg traded.
    return outcome.source === 'CORE' ? outcome.exitCode : refusalExit(outcome);
  }

  throw new Error(`Unknown subcommand \`${subcommand ?? ''}\`.`);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = EXIT.USAGE;
  });
