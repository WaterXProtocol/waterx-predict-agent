/**
 * Runtime validation of a command input.
 *
 * This is the gate every surface passes through before anything reaches the
 * SDK. TypeScript types do not run: a CLI argument, a JSON file, an MCP tool
 * call and a model's function call all arrive as `unknown`, and the type system
 * has already been erased by then (ADR-0001 §5).
 */
import { AGENT_COMMANDS, COMMAND_SCHEMA_DEFS, getCommand } from './commands.ts';
import {
  formatViolations,
  validateAgainstSchema,
  type SchemaViolation,
} from './json-schema.ts';

export interface CommandValidationSuccess {
  readonly ok: true;
  readonly command: string;
  /**
   * The same value, not a coerced copy. Nothing here parses a string into a
   * number or fills a default: a surface that rewrote an order size would be
   * changing the intent it was asked to validate.
   */
  readonly input: Readonly<Record<string, unknown>>;
}

export interface CommandValidationFailure {
  readonly ok: false;
  readonly command: string;
  /** Symbolic, for a caller branching on the failure (plan §6.3, §9). */
  readonly code: 'UNKNOWN_COMMAND' | 'INVALID_INPUT';
  readonly message: string;
  readonly violations: readonly SchemaViolation[];
}

export type CommandValidationResult = CommandValidationSuccess | CommandValidationFailure;

export function validateCommandInput(name: string, input: unknown): CommandValidationResult {
  const command = getCommand(name);
  if (command === undefined) {
    return {
      ok: false,
      command: name,
      code: 'UNKNOWN_COMMAND',
      message: `Unknown command "${name}". Known commands: ${AGENT_COMMANDS.map((c) => c.name).join(', ')}.`,
      violations: [],
    };
  }

  const violations = validateAgainstSchema(command.input, input, COMMAND_SCHEMA_DEFS);
  if (violations.length > 0) {
    return {
      ok: false,
      command: name,
      code: 'INVALID_INPUT',
      message: `${name}: ${formatViolations(violations)}`,
      violations,
    };
  }

  // Every command input is an object schema, so a passing value is an object.
  return { ok: true, command: name, input: input as Record<string, unknown> };
}

/**
 * Throwing variant, for a caller that has already decided an invalid input is a
 * bug rather than a request to reject.
 */
export function assertValidCommandInput(
  name: string,
  input: unknown,
): Readonly<Record<string, unknown>> {
  const result = validateCommandInput(name, input);
  if (!result.ok) throw new Error(result.message);
  return result.input;
}
