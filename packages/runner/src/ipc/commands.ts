/**
 * What may be asked of the Runner over local IPC, and what it honestly refuses.
 *
 * The IPC surface is deliberately NOT a second command surface. Two families
 * arrive on this socket and they are dispatched differently:
 *
 * - **Agent command contract names** (`order.execute`, `market.quote`, …) are
 *   recognized by `@waterx/predict-agent-schema` — the same registry the CLI and
 *   every adapter validate against (ADR-0001 §5, ADR-0006). This build cannot
 *   perform any of them through the daemon, because the executor that would drive
 *   a job through the SDK does not exist yet, so each is refused with
 *   `NOT_IMPLEMENTED` naming the missing piece. That refusal is the point: a
 *   client asking a connected Runner to place an order must be told no, loudly,
 *   rather than told the command is unknown — which reads as a typo — or, worse,
 *   given a plausible-looking reply.
 * - **Runner control commands** (`runner.*`) are declared here, because they are
 *   about *this process* rather than about trading, and the trading contract must
 *   not grow entries for a local daemon's lifecycle. They are still validated by
 *   the contract package's validator rather than by a second one written here.
 *
 * Every schema below is checked by `assertSupportedSchema` at module load, so a
 * keyword the shared validator cannot enforce is an import-time failure rather
 * than a constraint that silently does nothing.
 */
import {
  assertSupportedSchema,
  formatViolations,
  getCommand,
  validateAgainstSchema,
  type JsonSchema,
} from '@waterx/predict-agent-schema';

import { JOB_STATES, type JobState } from '../state-machine.ts';
import { RunnerIpcError } from './protocol.ts';

const JOB_STATE_NAMES = Object.keys(JOB_STATES) as readonly JobState[];

const object = (
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[] = [],
): JsonSchema => ({
  type: 'object',
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});

const nonEmptyString: JsonSchema = { type: 'string', minLength: 1, maxLength: 512 };

export const RUNNER_IPC_COMMANDS: Readonly<Record<string, JsonSchema>> = {
  /**
   * What this Runner is, what it is holding, and — the field that matters —
   * whether it is actually driving anything.
   */
  'runner.status': object({}),
  'runner.jobs': object({
    state: { type: 'string', enum: [...JOB_STATE_NAMES] },
    accountId: nonEmptyString,
  }),
  'runner.job': object({ jobId: nonEmptyString }, ['jobId']),
  /**
   * Records a cancellation, and applies it only if this instance holds the lease
   * and the job has not started a write. The reply says which of those happened;
   * see `dispatch` for why it must never say "cancelled" otherwise.
   */
  'runner.cancel-job': object({ jobId: nonEmptyString, reason: nonEmptyString }, [
    'jobId',
    'reason',
  ]),
  'runner.shutdown': object({ reason: nonEmptyString }),
};

for (const [name, schema] of Object.entries(RUNNER_IPC_COMMANDS)) {
  try {
    assertSupportedSchema(schema);
  } catch (error) {
    throw new Error(`runner IPC command ${name} has an unenforceable schema: ${String(error)}`);
  }
}

export const listRunnerIpcCommands = (): readonly string[] =>
  Object.keys(RUNNER_IPC_COMMANDS).sort();

/**
 * Validates a runner-local command input, or explains why the name was refused.
 *
 * Returns the input unchanged on success. Nothing here coerces: the contract
 * package's rule that validation never rewrites a value applies to this surface
 * too.
 */
export const validateRunnerCommand = (
  name: string,
  input: unknown,
): Readonly<Record<string, unknown>> => {
  const schema = RUNNER_IPC_COMMANDS[name];
  if (schema === undefined) {
    if (getCommand(name) !== undefined) {
      throw new RunnerIpcError(
        'NOT_IMPLEMENTED',
        `"${name}" is a real agent command and this Runner cannot perform it: the daemon has no executor, no signer and no reconciler yet (docs/IMPLEMENTATION_BACKLOG.md 2.6). Run it through the CLI, which executes in-process and dies with the process.`,
        { command: name, missing: ['executor', 'signer', 'reconciler'] },
      );
    }
    throw new RunnerIpcError(
      'UNKNOWN_COMMAND',
      `unknown command "${name}"; this Runner accepts ${listRunnerIpcCommands().join(', ')}`,
      { command: name },
    );
  }

  const violations = validateAgainstSchema(schema, input ?? {});
  if (violations.length > 0) {
    throw new RunnerIpcError('INVALID_INPUT', `${name}: ${formatViolations(violations)}`, {
      command: name,
      violations,
    });
  }
  return (input ?? {}) as Readonly<Record<string, unknown>>;
};
