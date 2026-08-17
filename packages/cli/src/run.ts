/**
 * The dispatcher: one invocation in, one JSON document and one exit code out.
 *
 * Everything the process touches arrives through `CliIo`, so the whole surface
 * is testable without spawning a shell, opening a socket or reading a real
 * config file — and so a test can prove that a token in the environment never
 * reaches either stream, on any path.
 *
 * THE INVARIANT: this function writes to stdout exactly once, and always. A
 * failure anywhere below still produces a parseable envelope; the only thing
 * that changes is `ok`, `error` and the exit code.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';

import { AGENT_COMMANDS, type AgentCommandSpec } from '@waterx/predict-agent-schema';
import type { PredictAgentClient } from '@waterx/predict-agent-sdk';

import { CAPABILITIES, getCapability, type Capability } from './capabilities.ts';
import { createClient, deadline, toEnvelopeError } from './client.ts';
import {
  accountAllowance,
  accountExecutions,
  accountFills,
  accountPositions,
  accountRiskLimits,
  accountStatus,
} from './commands/account.ts';
import { commandSchema } from './commands/command-schema.ts';
import { describeRuntime } from './commands/describe.ts';
import { doctorFailure, runDoctor } from './commands/doctor.ts';
import { marketGet, marketList, marketQuote, marketSearch } from './commands/market.ts';
import {
  orderExecute,
  orderExecuteMany,
  orderGet,
  orderPreview,
  orderReconcile,
} from './commands/order.ts';
import {
  strategyCancel,
  strategyCreate,
  strategyEvents,
  strategyGet,
  strategyList,
} from './commands/strategy.ts';
import { loadConfig, type ResolvedConfig } from './config.ts';
import type { CommandContext, CommandHandler } from './context.ts';
import { errorEnvelope, successEnvelope, type EnvelopeMeta } from './envelope.ts';
import { CliError, isCliError } from './errors.ts';
import {
  EXIT_CODES,
  exitCodeForCliError,
  exitCodeForRunnerError,
  exitCodeForServerError,
  type ExitCode,
} from './exit-codes.ts';
import { buildCommandInput } from './input.ts';
import {
  createNodeStreams,
  emitEnvelope,
  writeDiagnostic,
  type OutputStreams,
} from './output.ts';
import { parseArgv, requireFlagValue, type ParsedArgv } from './parse.ts';
import { SigningGate } from './policy.ts';
import { Redactor, SECRET_ENV_KEYS } from './redact.ts';
import {
  createNodePathStat,
  createNodeRunnerDialer,
  openRunnerSession,
  resolveRuntimeDir,
  type PathStat,
  type RunnerDialer,
  type RunnerSession,
} from './runner-ipc.ts';
import { createNodeSignerRunner, type SignerRunner } from './signer.ts';
import { CLI_NAME, CLI_VERSION } from './version.ts';

export interface CliIo {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly streams: OutputStreams;
  readonly fetch: typeof globalThis.fetch;
  readonly runSigner: SignerRunner;
  /**
   * Opens a Unix socket to the local Runner. A seam, not a convenience: the CLI
   * must not depend on `@waterx/predict-agent-runner`, and a test must be able
   * to prove that a refusal cost zero socket traffic.
   */
  readonly dialRunner: RunnerDialer;
  /** Ownership and permission bits, for the pre-dial privacy check. */
  readonly pathStat: PathStat;
  /** Returns null when the file does not exist. */
  readFile(path: string): string | null;
  homeDir(): string | null;
  readStdin(): Promise<string>;
  now(): Date;
  /** Injected so an envelope is reproducible in a test. */
  newRequestId(): string;
  readonly nodeVersion: string;
}

/**
 * `runtime.doctor` is absent on purpose: it is the one command whose failure is
 * a report rather than a thrown error, so the dispatcher handles it directly.
 */
const HANDLERS: Readonly<Record<string, CommandHandler>> = {
  'runtime.describe': (context) =>
    Promise.resolve(describeRuntime(context.config, context.nodeVersion)),
  'runtime.command-schema': (context) => Promise.resolve(commandSchema(context.input)),
  'market.list': marketList,
  'market.search': marketSearch,
  'market.get': marketGet,
  'market.quote': marketQuote,
  'account.status': accountStatus,
  'account.allowance': accountAllowance,
  'account.risk-limits': accountRiskLimits,
  'account.positions': accountPositions,
  'account.executions': accountExecutions,
  'account.fills': accountFills,
  'order.preview': orderPreview,
  'order.get': orderGet,
  'order.reconcile': orderReconcile,
  'order.execute': orderExecute,
  'order.execute-many': orderExecuteMany,
  'strategy.create': strategyCreate,
  'strategy.get': strategyGet,
  'strategy.list': strategyList,
  'strategy.cancel': strategyCancel,
  'strategy.events': strategyEvents,
};

/** CLI invocation → contract command, taken from the contract's own `cli` field. */
const BY_CLI_PATH: ReadonlyMap<string, AgentCommandSpec> = new Map(
  AGENT_COMMANDS.map((command) => [command.cli, command]),
);

const USAGE = [
  `${CLI_NAME} ${CLI_VERSION} — universal agent surface for WaterX Predict.`,
  '',
  'Usage: waterx-predict <command> [flags]',
  '',
  'Start with:',
  '  waterx-predict describe        what this runtime can and cannot do',
  '  waterx-predict command-schema  the versioned command contract',
  '  waterx-predict doctor          check configuration, signer and reachability',
  '',
  'Commands:',
  ...AGENT_COMMANDS.map((command) => `  ${command.cli.padEnd(22)}${command.summary}`),
  '',
  "Input:  --input '<json>' | --file <path> | --stdin, plus typed --flags per the command schema.",
  'Output: one JSON document on stdout. Diagnostics on stderr. Exit codes: see `describe`.',
  'Policy: writes need the interactive approval from `order preview` (--approve <token>), or a',
  '        configured delegated-auto scope. --policy read-only narrows any configuration.',
].join('\n');

/**
 * Longest-match the command path: `account status` before `account`.
 *
 * Every CLI path in the contract is one or two words, and matching the short
 * form first would route `account status` to a non-existent `account`.
 */
function resolveCommand(path: readonly string[]): {
  spec: AgentCommandSpec | undefined;
  invocation: string;
} {
  const two = path.slice(0, 2).join(' ');
  const one = path[0] ?? '';
  const spec = BY_CLI_PATH.get(two) ?? BY_CLI_PATH.get(one);
  if (spec !== undefined) return { spec, invocation: spec.cli };
  return { spec: undefined, invocation: path.length >= 2 ? two : one };
}

/**
 * A named-but-unavailable capability, answered from the same inventory
 * `describe` publishes.
 *
 * This is capability negotiation, not an error in the ordinary sense: the
 * runtime knows what was asked for, knows it cannot do it, and says why, what
 * tracks it, and what to do instead. The alternative — approximating
 * `market history` from repeated quotes, say — would have this runtime invent a
 * fact the server never stated.
 */
function refusal(capability: Capability): CliError {
  const code =
    capability.status === 'UNAVAILABLE' ? 'CAPABILITY_UNAVAILABLE' : 'COMMAND_NOT_IMPLEMENTED';
  return new CliError(
    code,
    `\`${capability.id}\` is not available in this build: ${capability.detail ?? capability.summary}`,
    {
      capability: capability.id,
      reason: capability.reason ?? 'UNSPECIFIED',
      ...(capability.alternative !== undefined ? { alternative: capability.alternative } : {}),
      ...(capability.tracking !== undefined ? { tracking: capability.tracking } : {}),
    },
  );
}

export async function run(io: CliIo): Promise<number> {
  const redactor = new Redactor();
  for (const key of SECRET_ENV_KEYS) redactor.register(io.env[key]);

  const requestId = io.newRequestId();
  const diagnostic = (text: string): void => {
    writeDiagnostic(io.streams, text, redactor);
  };

  let parsed: ParsedArgv = { path: [], flags: new Map() };
  let command = '(none)';
  let meta: EnvelopeMeta | undefined;
  let timeoutMs = 0;
  let closeRunner: (() => void) | undefined;

  // A successful result that still must not read as "done" — see
  // `CommandContext.exitAs`. AMBIGUOUS wins outright; otherwise the first class
  // asked for stands, so one failed leg cannot be overwritten by a later one.
  let successExit: ExitCode = EXIT_CODES.OK;
  const exitAs = (code: ExitCode): void => {
    if (successExit === EXIT_CODES.AMBIGUOUS) return;
    if (code === EXIT_CODES.AMBIGUOUS || successExit === EXIT_CODES.OK) successExit = code;
  };

  try {
    parsed = parseArgv(io.argv);
    timeoutMs = parseTimeoutFlag(parsed.flags) ?? 0;

    if (parsed.flags.has('version')) {
      command = 'runtime.version';
      emitEnvelope(
        io.streams,
        successEnvelope(command, requestId, { name: CLI_NAME, version: CLI_VERSION }),
        redactor,
      );
      return EXIT_CODES.OK;
    }

    if (parsed.path.length === 0 || parsed.flags.has('help')) {
      // Usage goes to stderr and stdout still gets an envelope, because a caller
      // that always parses stdout must never find prose there.
      diagnostic(USAGE);
      throw new CliError(
        'USAGE',
        parsed.path.length === 0
          ? 'No command was given. Run `waterx-predict describe` for the capability inventory.'
          : 'Help was requested. The command reference is on stderr; `command-schema` has the machine-readable form.',
      );
    }

    const resolved = resolveCommand(parsed.path);
    const spec = resolved.spec;
    command = spec?.name ?? resolved.invocation;

    if (spec === undefined) {
      // A capability that is named but not runnable gets its own refusal; an
      // invented one gets a plain unknown-command error.
      const capability = getCapability(resolved.invocation) ?? getCapability(parsed.path[0] ?? '');
      if (capability !== undefined && capability.status !== 'AVAILABLE') {
        command = capability.id;
        throw refusal(capability);
      }
      throw new CliError(
        'UNKNOWN_COMMAND',
        `\`${resolved.invocation}\` is not a command. Run \`waterx-predict describe\` for the capability inventory, or \`waterx-predict command-schema\` for the contract.`,
        { invocation: resolved.invocation, known: CAPABILITIES.map((entry) => entry.id) },
      );
    }

    // Refuse an unimplemented command BEFORE parsing its input. Rejecting
    // `order cancel` because a field was malformed would tell the caller to fix
    // the field, and the fixed invocation would be refused anyway — for the real
    // reason, one round trip later.
    const handler = HANDLERS[spec.name];
    if (handler === undefined && spec.name !== 'runtime.doctor') {
      const capability = getCapability(spec.cli);
      throw capability !== undefined && capability.status !== 'AVAILABLE'
        ? refusal(capability)
        : new CliError(
            'COMMAND_NOT_IMPLEMENTED',
            `\`${spec.cli}\` is defined in the command contract and is not implemented in this build.`,
            { command: spec.name },
          );
    }

    const config = loadConfig({
      env: io.env,
      readFile: io.readFile,
      homeDir: io.homeDir,
      explicitPath: requireFlagValue(parsed.flags, 'config'),
      timeoutMs: parseTimeoutFlag(parsed.flags),
      policy: requireFlagValue(parsed.flags, 'policy'),
    });
    redactor.register(config.token);
    timeoutMs = config.timeoutMs;

    const built = await buildCommandInput(spec, {
      flags: parsed.flags,
      readFile: (path) => {
        const contents = io.readFile(path);
        if (contents === null) throw new CliError('USAGE', `No input file at ${path}.`);
        return contents;
      },
      readStdin: io.readStdin,
      defaultAccountId: config.defaultAccountId,
      defaultAgentWallet: config.agentWallet,
    });

    meta = buildMeta(config, built.defaultsApplied);
    const invocation = createContext(io, config, built.input, diagnostic, {
      approval: requireFlagValue(parsed.flags, 'approve'),
      runnerDir: requireFlagValue(parsed.flags, 'runner-dir'),
      exitAs,
    });
    const context = invocation.context;
    // Registered before the handler runs, so a socket opened by a command that
    // then threw is still closed. A CLI that leaks an fd per invocation would
    // hold the Runner's connection slot open long after the process cared.
    closeRunner = invocation.close;

    if (spec.name === 'runtime.doctor') {
      const report = await runDoctor(context);
      if (report.failed === 0) {
        emitEnvelope(io.streams, successEnvelope(command, requestId, report, meta), redactor);
        return EXIT_CODES.OK;
      }
      const failure = doctorFailure(report);
      emitEnvelope(io.streams, errorEnvelope(command, requestId, failure.error, meta), redactor);
      return failure.exit;
    }

    // Unreachable: the guard above ran before any input was read.
    if (handler === undefined) {
      throw new CliError('INTERNAL', `No handler is registered for \`${spec.name}\`.`);
    }

    emitEnvelope(
      io.streams,
      successEnvelope(command, requestId, await handler(context), meta),
      redactor,
    );
    return successExit;
  } catch (error: unknown) {
    const envelopeError = toEnvelopeError(error, timeoutMs);
    emitEnvelope(io.streams, errorEnvelope(command, requestId, envelopeError, meta), redactor);
    return resolveExit(error, envelopeError.source, envelopeError.code);
  } finally {
    closeRunner?.();
  }
}

function resolveExit(error: unknown, source: string, code: string): ExitCode {
  if (isCliError(error)) return exitCodeForCliError(error.code);
  if (source === 'SERVER') return exitCodeForServerError(code);
  if (source === 'RUNNER') return exitCodeForRunnerError(code);
  if (source === 'TRANSPORT') return EXIT_CODES.TRANSPORT;
  return EXIT_CODES.INTERNAL;
}

function parseTimeoutFlag(flags: ReadonlyMap<string, string | true>): number | undefined {
  const raw = flags.get('timeout-ms');
  if (raw === undefined) return undefined;
  if (raw === true) throw new CliError('USAGE', '`--timeout-ms` needs a value.');
  if (!/^\d+$/u.test(raw)) {
    throw new CliError(
      'USAGE',
      `\`--timeout-ms\` is a whole number of milliseconds, not \`${raw}\`.`,
    );
  }
  return Number(raw);
}

function buildMeta(
  config: ResolvedConfig,
  defaultsApplied: Readonly<Record<string, unknown>>,
): EnvelopeMeta | undefined {
  const meta: EnvelopeMeta = {
    ...(Object.keys(defaultsApplied).length > 0 ? { defaultsApplied } : {}),
    ...(config.warnings.length > 0 ? { warnings: config.warnings } : {}),
  };
  return Object.keys(meta).length > 0 ? meta : undefined;
}

function createContext(
  io: CliIo,
  config: ResolvedConfig,
  input: Readonly<Record<string, unknown>>,
  diagnostic: (text: string) => void,
  options: {
    approval: string | undefined;
    runnerDir: string | undefined;
    exitAs: (code: ExitCode) => void;
  },
): { context: CommandContext; close: () => void } {
  let session: Promise<PredictAgentClient> | undefined;
  let runner: Promise<RunnerSession> | undefined;
  // One gate per invocation, created before any client exists so that every
  // signer this run builds shares it. A command that never authorizes a write
  // leaves it empty, and an empty gate signs nothing.
  const gate = new SigningGate(config.policy.mode);
  /**
   * Build, then open a session unless the caller supplied a token. Memoized as a
   * PROMISE rather than as a client, so `account status`'s two concurrent reads
   * sign one challenge between them instead of one each.
   */
  const open = async (): Promise<PredictAgentClient> => {
    const client = createClient({
      config,
      fetch: io.fetch,
      runSigner: io.runSigner,
      onDiagnostic: diagnostic,
      gate,
    });
    if (config.token === undefined) await client.authenticate();
    return client;
  };

  /**
   * The Runner session, memoized the same way and for the same reason.
   *
   * Everything that can refuse without touching the socket — an absent runtime
   * directory, one another local account can reach — happens inside
   * `openRunnerSession`, before a dial.
   */
  const openRunner = (): Promise<RunnerSession> =>
    openRunnerSession({
      runtimeDir: resolveRuntimeDir({
        env: io.env,
        homeDir: io.homeDir,
        explicit: options.runnerDir,
      }),
      dial: io.dialRunner,
      stat: io.pathStat,
      readFile: io.readFile,
      timeoutMs: config.timeoutMs,
      client: `${CLI_NAME}/${CLI_VERSION}`,
    });

  return {
    context: {
      input,
      config,
      approval: options.approval,
      gate,
      client: () => (session ??= open()),
      runner: () => (runner ??= openRunner()),
      signal: (atLeastMs?: number) => deadline(Math.max(config.timeoutMs, atLeastMs ?? 0)),
      exitAs: options.exitAs,
      diagnostic,
      nodeVersion: io.nodeVersion,
      now: io.now,
    },
    close: () => {
      // Swallowed deliberately: a socket that failed to open has nothing to
      // close, and a close that throws must not replace the answer already on
      // stdout with an internal error.
      void runner?.then((open) => {
        open.close();
      }, noop);
    },
  };
}

const noop = (): void => {
  /* nothing to do */
};

/* ── Node bindings ───────────────────────────────────────────────────────── */

function readFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error: unknown) {
    const code = (error as { code?: string } | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null;
    throw new CliError('CONFIG_INVALID', `Could not read ${path}: ${code ?? 'read failed'}`);
  }
}

/** Only called when `--stdin` was passed, so an interactive run never blocks. */
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString('utf8');
}

/** Wired against the real process. Kept here so `main.ts` stays a shebang. */
export function createNodeIo(overrides: Partial<CliIo> = {}): CliIo {
  return {
    argv: process.argv.slice(2),
    env: process.env,
    streams: createNodeStreams(),
    fetch: globalThis.fetch.bind(globalThis),
    runSigner: createNodeSignerRunner(spawn),
    dialRunner: createNodeRunnerDialer(connect),
    pathStat: createNodePathStat(statSync),
    readFile: readFileOrNull,
    homeDir: () => {
      try {
        const home = homedir();
        return home === '' ? null : home;
      } catch {
        return null;
      }
    },
    readStdin: readAllStdin,
    now: () => new Date(),
    newRequestId: () => randomUUID(),
    nodeVersion: process.version,
    ...overrides,
  };
}
