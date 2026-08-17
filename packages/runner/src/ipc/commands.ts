/**
 * What may be asked of the Runner over local IPC, and what it honestly refuses.
 *
 * The IPC surface is deliberately NOT a second command surface. Two families
 * arrive on this socket and they are dispatched differently:
 *
 * - **Agent command contract names** (`order.execute`, `market.quote`, …) are
 *   recognized by `@waterx/predict-agent-schema` — the same registry the CLI and
 *   every adapter validate against (ADR-0001 §5, ADR-0006). None of them is served
 *   here, and the reason depends on the Runner. Without a driver it can execute
 *   nothing at all, so the refusal names what is missing; with one it executes
 *   *durable jobs*, and a one-shot agent command is not one, so the refusal says
 *   that instead. That refusal is the point either way: a client asking a
 *   connected Runner to place an order must be told no, loudly, rather than told
 *   the command is unknown — which reads as a typo — or, worse, given a
 *   plausible-looking reply.
 * - **Runner control commands** (`runner.*`) are declared here, because they are
 *   about *this process* rather than about trading, and the trading contract must
 *   not grow entries for a local daemon's lifecycle. They are still validated by
 *   the contract package's validator rather than by a second one written here.
 * - **Strategy commands** (`strategy.*`) are the one family this socket *does*
 *   serve, because a durable job is exactly what this process owns. They are
 *   declared here for the same reason: a strategy is a thing a Runner holds, and
 *   nothing places one on a server.
 *
 * ## What the strategy schemas do and do not say
 *
 * They describe **shape only**: which fields exist, and what type each one is, so
 * a peer that sent `maxSlippageBps: "50"` is refused at the socket instead of
 * reaching normalization as something that has to be guessed about.
 *
 * They deliberately do NOT restate a single *rule*. The four sizing fields are all
 * optional here even though exactly one is required; `expiresAt` is optional here
 * even though a strategy without one is refused; the seven-day cap appears
 * nowhere. Every one of those lives in `strategy/intent.ts`, and a schema that
 * re-encoded them would be a second implementation of the rules that decide how
 * much gets traded — which is how two surfaces end up disagreeing about what "sell
 * half" means. The refusal a client sees is therefore the *named* one —
 * `SIZE_AMBIGUOUS`, `EXPIRY_REQUIRED`, `EXPIRY_TOO_FAR` — with the explanation
 * attached, rather than an anonymous `INVALID_INPUT`.
 *
 * There is also no `policy` field on `strategy.create`, and that absence is a
 * security property rather than an omission: the mandate comes from this machine's
 * configuration (`config.ts`), so a socket peer cannot widen its own authority by
 * asking for a different one.
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

/**
 * A decimal as a string, unanchored to any scale.
 *
 * Wide on purpose: the precision rules belong to the wire contract and to
 * `intent.ts`, and a pattern here that was stricter than either would refuse a
 * size the server accepts. What it does enforce is that money never arrives as a
 * JSON number, which no amount of downstream care can undo.
 */
const decimalString: JsonSchema = { type: 'string', pattern: '^\\d+(\\.\\d+)?$', maxLength: 40 };

/**
 * One leg, as asked for. Every sizing field is optional here; exactly one is
 * required, and `normalizeStrategy` is the single place that says so.
 */
const legSchema: JsonSchema = object(
  {
    marketId: nonEmptyString,
    outcomeId: nonEmptyString,
    side: { type: 'string', enum: ['BUY', 'SELL'] },
    buyAmount: decimalString,
    sellShares: decimalString,
    sellFractionOfPosition: decimalString,
    /** The distinct, explicit mode: re-read the position at the trigger (D-15). */
    dynamicSellFractionOfPosition: decimalString,
    positionId: nonEmptyString,
    maxSlippageBps: { type: 'integer', minimum: 0, maximum: 10_000 },
    worstAcceptablePrice: decimalString,
  },
  ['marketId', 'outcomeId', 'side', 'maxSlippageBps'],
);

/**
 * `observe` is absent, and must stay absent: which side of the book a target is
 * read against is *derived* from the leg's side — a BUY ceiling watches the ask, a
 * SELL floor watches the bid — and accepting it would let a caller arm a strategy
 * that triggers off the wrong half of the market.
 */
const triggerSchema: JsonSchema = object(
  {
    kind: { type: 'string', enum: ['IMMEDIATE', 'PRICE'] },
    targetPrice: decimalString,
    marketId: nonEmptyString,
    outcomeId: nonEmptyString,
    side: { type: 'string', enum: ['BUY', 'SELL'] },
  },
  ['kind'],
);

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

  /**
   * Arm a durable strategy. Note what is not here: `policy`. See the header.
   *
   * `expiresAt` is not `required` even though it is mandatory, so the caller gets
   * `EXPIRY_REQUIRED` and the sentence explaining that there is no permanent
   * watcher, rather than a schema violation naming a missing property.
   */
  'strategy.create': object(
    {
      strategyId: nonEmptyString,
      ownerAddress: nonEmptyString,
      accountId: nonEmptyString,
      agentWallet: nonEmptyString,
      legs: { type: 'array', items: legSchema, minItems: 1, maxItems: 20 },
      trigger: triggerSchema,
      expiresAt: nonEmptyString,
    },
    ['ownerAddress', 'accountId', 'agentWallet', 'legs', 'trigger'],
  ),
  'strategy.get': object({ jobId: nonEmptyString }, ['jobId']),
  'strategy.list': object({
    accountId: nonEmptyString,
    strategyId: nonEmptyString,
    state: { type: 'string', enum: [...JOB_STATE_NAMES] },
  }),
  /** The same recorded/applied rule as `runner.cancel-job`, and the same code. */
  'strategy.cancel': object({ jobId: nonEmptyString, reason: nonEmptyString }, ['jobId', 'reason']),
  'strategy.events': object({ jobId: nonEmptyString }, ['jobId']),
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
  context?: { readonly driverGaps?: readonly string[] },
): Readonly<Record<string, unknown>> => {
  const schema = RUNNER_IPC_COMMANDS[name];
  if (schema === undefined) {
    if (getCommand(name) !== undefined) {
      // Refused whether or not this Runner drives, and for different reasons.
      // Without a driver it cannot execute anything at all; with one it executes
      // *durable jobs*, and a one-shot agent command is not one — answering it
      // here would be a second execution surface with its own quoting, retry and
      // policy, which ADR-0001 §5 exists to prevent.
      const gaps = context?.driverGaps ?? ['scheduler', 'signer', 'price-watcher'];
      throw new RunnerIpcError(
        'NOT_IMPLEMENTED',
        gaps.length > 0
          ? `"${name}" is a real agent command and this Runner cannot perform it: it is missing ${gaps.join(', ')} (docs/IMPLEMENTATION_BACKLOG.md 2.6). Run it through the CLI, which executes in-process and dies with the process.`
          : `"${name}" is a real agent command and this socket does not serve one: this Runner drives durable jobs, not one-shot intents (docs/IMPLEMENTATION_BACKLOG.md 2.6). Run it through the CLI, or create a strategy so the Runner owns it.`,
        { command: name, missing: [...gaps] },
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
