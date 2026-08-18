/**
 * Tool call → command core.
 *
 * The dispatcher is allowed to refuse exactly two things, and both are free:
 * a tool nobody advertised, and an input the command contract rejects. Both
 * decisions are made by code that is not this package's — the tool registry is
 * a projection of the contract, and the validation is
 * `validateCommandInput` — so neither is an adapter opinion.
 *
 * Everything else is the core's answer, relayed. The envelope is passed through
 * as parsed JSON, unmodified: no error is rewritten, no field is added to
 * `data`, no retry is attempted here. An adapter that retried would be a second
 * retry policy sitting on top of the one that owns the idempotency key.
 */
import { validateCommandInput } from '@waterx/predict-agent-schema';

import type { CoreInvokeOptions, CoreInvoker } from './core.ts';
import { getTool } from './tools.ts';

/** A refusal made here, before anything was spent. */
export interface AdapterRefusal {
  readonly ok: false;
  readonly source: 'ADAPTER';
  readonly code: 'UNKNOWN_TOOL' | 'INVALID_INPUT' | 'CORE_OUTPUT_UNREADABLE';
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

/** The command core's own answer. */
export interface CoreOutcome {
  readonly ok: boolean;
  readonly source: 'CORE';
  readonly tool: string;
  readonly command: string;
  /** The argv the core was run with. Reproducible by hand, in a terminal. */
  readonly argv: readonly string[];
  readonly exitCode: number;
  /** The core's envelope, verbatim. */
  readonly envelope: Readonly<Record<string, unknown>>;
}

export type ToolCallOutcome = AdapterRefusal | CoreOutcome;

/**
 * True only when the whole intent reached a definite, successful end.
 *
 * `envelope.ok` alone is not that. A batch where one leg failed and another was
 * skipped still answers `ok: true` with a non-zero exit code, because the call
 * did produce an authoritative per-leg result — and a host that showed that to
 * a model as an unqualified success would be hiding the legs that did not
 * trade.
 */
export const isFullySettled = (outcome: ToolCallOutcome): boolean =>
  outcome.source === 'CORE' && outcome.ok && outcome.exitCode === 0;

export interface ToolDispatcher {
  call(tool: string, input: unknown, options?: CoreInvokeOptions): Promise<ToolCallOutcome>;
}

export interface ToolDispatcherOptions {
  readonly invoke: CoreInvoker;
  /**
   * Includes the core's stderr in a `CORE_OUTPUT_UNREADABLE` refusal. Off by
   * default: the CLI redacts known secrets from both streams, but "redacted"
   * is a property of what it knows about, and an adapter forwarding a crash
   * dump to a model host by default is the wrong side of that bet.
   */
  readonly includeCoreDiagnostics?: boolean;
}

function parseEnvelope(stdout: string): Record<string, unknown> | undefined {
  const trimmed = stdout.trim();
  if (trimmed === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Deliberately no salvage attempt. Fishing a JSON object out of noisy
    // output is how a truncated result gets reported as a complete one.
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

export function createToolDispatcher(options: ToolDispatcherOptions): ToolDispatcher {
  return {
    async call(toolName, input, invokeOptions) {
      const tool = getTool(toolName);
      if (tool === undefined) {
        return {
          ok: false,
          source: 'ADAPTER',
          code: 'UNKNOWN_TOOL',
          message: `\`${toolName}\` is not a tool this runtime advertises.`,
          details: { tool: toolName },
        };
      }

      // The tool came from the registry, so the command exists and the only
      // reachable failure is the input's — `validateCommandInput` already
      // formats the violations into its message.
      const validation = validateCommandInput(tool.command, input ?? {});
      if (!validation.ok) {
        return {
          ok: false,
          source: 'ADAPTER',
          code: 'INVALID_INPUT',
          message: validation.message,
          details: {
            tool: toolName,
            command: tool.command,
            violations: validation.violations,
          },
        };
      }

      // The argv is the whole contract with the core: the command's own path,
      // and one JSON document the schema has already accepted. Nothing is
      // spread into typed flags — a value that survived validation as a
      // decimal string must not be re-parsed on a command line.
      const argv = [...tool.annotations.cli.split(' '), '--input', JSON.stringify(validation.input)];

      const response = await options.invoke({ command: tool.command, argv }, invokeOptions);
      const envelope = parseEnvelope(response.stdout);
      if (envelope === undefined) {
        return {
          ok: false,
          source: 'ADAPTER',
          code: 'CORE_OUTPUT_UNREADABLE',
          message:
            'The command core did not write one JSON envelope to stdout. The outcome of this call is UNKNOWN: if it was a write, reconcile before retrying.',
          details: {
            tool: toolName,
            command: tool.command,
            argv,
            exitCode: response.exitCode,
            ...(options.includeCoreDiagnostics === true ? { stderr: response.stderr } : {}),
          },
        };
      }

      return {
        ok: envelope['ok'] === true,
        source: 'CORE',
        tool: toolName,
        command: tool.command,
        argv,
        exitCode: response.exitCode,
        envelope,
      };
    },
  };
}
