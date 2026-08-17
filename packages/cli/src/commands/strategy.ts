/**
 * The five strategy commands, and the one thing they all do.
 *
 * They hand the caller's input to the local Runner and render its answer. Not
 * one of them decides anything: no expiry is defaulted, no sizing field is
 * chosen between, no policy is named, and no refusal is translated into a
 * different refusal. Those rules live in `packages/runner/src/strategy`, which is
 * also what an embedding application calls, so a socket client and a library
 * client cannot end up disagreeing about what "sell half" means. What this module
 * adds is the honesty a command-line answer needs and a socket reply does not
 * carry: which Runner answered, whether it is actually driving, and — after a
 * create with no answer — that the outcome is unknown.
 *
 * THE THREE PLACES AN OPERATOR LOSES MONEY, AND WHAT IS DONE ABOUT EACH:
 *
 * 1. **A strategy that is armed and asleep.** A Runner with no signer, no
 *    gateway or no price feed still accepts a create and writes a real, durable
 *    job that nothing will ever advance. It looks exactly like a working one. So
 *    `create` reads `driving` off the handshake and the reply, prints what is
 *    missing to stderr, and exits UNAVAILABLE — a success envelope carrying the
 *    real job, and an exit code a shell script cannot mistake for "watching".
 *
 * 2. **A create that is retried.** The Runner does not deduplicate creates:
 *    `strategyId` is an attribution label, not an idempotency key, so a second
 *    call arms a second strategy and both of them trade. When an answer never
 *    arrives, this module refuses to guess in either direction — it reports
 *    CREATE_OUTCOME_UNKNOWN and exits AMBIGUOUS, naming `strategy list` as the
 *    way to find out. That is deliberately conservative: it declares an unknown
 *    outcome even in the case where the request never left this process, because
 *    the cost of over-reporting is one list call and the cost of under-reporting
 *    is a duplicate position.
 *
 * 3. **A cancellation that did not stop anything.** `cancel` is recorded
 *    durably and applied only if that Runner holds the lease and no write has
 *    begun. Reporting the record as the stop would be a lie in exactly the case
 *    that matters — an order already on its way to the chain — so a
 *    `recorded: true, applied: false` reply exits AMBIGUOUS with the reason
 *    named.
 */
import type { CommandContext } from '../context.ts';
import { CliError } from '../errors.ts';
import { EXIT_CODES } from '../exit-codes.ts';
import { RunnerRefusal, isRunnerRefusal, type RunnerSession } from '../runner-ipc.ts';

/** The Runner's reply, plus which Runner it came from. Never a summary of it. */
const withRunner = (session: RunnerSession, result: unknown): Record<string, unknown> => ({
  ...(result !== null && typeof result === 'object' && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : { result }),
  runner: {
    instanceId: session.instanceId,
    socketPath: session.socketPath,
    // Repeated on every reply, not just on a create: a `strategy get` that says
    // WATCHING against a Runner that is not driving is a job nobody is moving.
    driving: session.driving,
  },
});

const read =
  (command: string) =>
  async (context: CommandContext): Promise<unknown> => {
    const session = await context.runner();
    return withRunner(session, await session.request(command, context.input));
  };

export const strategyGet = read('strategy.get');
export const strategyList = read('strategy.list');
export const strategyEvents = read('strategy.events');

/**
 * Arm a strategy.
 *
 * The local policy check comes first and is this CLI's own, not a second opinion
 * on the Runner's mandate: under `--policy read-only` this process refuses to
 * ask for something that trades later. The Runner then applies its own mandate,
 * which it takes from its configuration and never from this request.
 */
export async function strategyCreate(context: CommandContext): Promise<unknown> {
  if (context.config.policy.mode === 'read-only') {
    throw new CliError(
      'POLICY_DENIED',
      'A strategy signs and trades later, unattended, so a read-only policy refuses to arm one. Nothing was sent to the Runner.',
      { policy: 'read-only' },
    );
  }

  const session = await context.runner();

  let result: unknown;
  try {
    result = await session.request('strategy.create', context.input);
  } catch (error: unknown) {
    throw isRunnerRefusal(error) ? createOutcome(error) : error;
  }

  const reply = withRunner(session, result);
  // `driving` from the reply is the authoritative one — it is read at the moment
  // the job was written, where the handshake's was read at connect. They agree
  // in practice; when they do not, the pessimistic reading is the safe one.
  const driving = reply['driving'] === true && session.driving;
  if (!driving) {
    const gaps = Array.isArray(reply['driverGaps']) ? (reply['driverGaps'] as unknown[]) : [];
    context.diagnostic(
      `The strategy was written and is NOT being watched: the Runner at ${session.socketPath} is not driving jobs${
        gaps.length > 0 ? ` (missing: ${gaps.map(String).join(', ')})` : ''
      }. It will not trigger until a Runner that can drive picks it up.`,
    );
    context.exitAs(EXIT_CODES.UNAVAILABLE);
  }
  return reply;
}

/**
 * A create whose answer did not arrive.
 *
 * Only the outcomes where nothing could have been written stay as they are — a
 * refusal the Runner articulated, a directory that was never dialled. Everything
 * else becomes AMBIGUOUS, because past the point the request was written to the
 * socket, "no answer" and "committed but unreported" are indistinguishable from
 * here, and only one of them makes a retry safe.
 */
function createOutcome(error: RunnerRefusal): RunnerRefusal {
  const answered = new Set([
    'RUNNER_UNREACHABLE',
    'INSECURE_RUNTIME_DIR',
    'SOCKET_PATH_TOO_LONG',
    'UNAUTHENTICATED',
    'PROTOCOL_VERSION',
    'FRAME_TOO_LARGE',
    'UNKNOWN_COMMAND',
    'NOT_IMPLEMENTED',
  ]);
  if (answered.has(error.code)) return error;
  if (error.code !== 'TIMEOUT' && error.code !== 'CONNECTION_CLOSED') return error;

  return new RunnerRefusal(
    'CREATE_OUTCOME_UNKNOWN',
    `${error.message} The Runner may or may not have armed this strategy, and it does NOT deduplicate a repeated create — a second one would arm a second strategy that also trades. Run \`waterx-predict strategy list\` and look for it before deciding anything.`,
    { ...(error.detail ?? {}), underlying: error.code },
  );
}

/**
 * Record a cancellation, and say whether it stopped anything.
 *
 * The exit code distinguishes the two, because the envelope's `applied: false`
 * is easy to skip and the difference is whether an order is still on its way.
 */
export async function strategyCancel(context: CommandContext): Promise<unknown> {
  const session = await context.runner();
  const reply = withRunner(session, await session.request('strategy.cancel', context.input));

  if (reply['applied'] !== true) {
    const pending = typeof reply['pending'] === 'string' ? reply['pending'] : 'UNKNOWN';
    context.diagnostic(
      pending === 'IN_FLIGHT'
        ? 'The cancellation is recorded and was NOT applied: this job has already begun a write, which cannot be recalled. Re-read it with `strategy get` to see how it resolved.'
        : `The cancellation is recorded and was NOT applied (${pending}): this Runner does not hold the job's lease, so whichever instance does will honour the record when it next looks. Re-read it with \`strategy get\`.`,
    );
    context.exitAs(EXIT_CODES.AMBIGUOUS);
  }
  return reply;
}
