/**
 * The seam every adapter calls through, and the one implementation of it.
 *
 * Plan §6.7's constraint is that an adapter must not reimplement pricing, retry,
 * signing, policy or job state. The cheapest way to make that true is to leave
 * the adapter no material to reimplement them WITH: this package takes no
 * static import of the CLI or the SDK, and reaches the command core the way a
 * user does — by running the installed `waterx-predict` binary and reading the
 * single JSON envelope it writes to stdout.
 *
 * The cost is a process per call. That is the correct trade here. It means the
 * execution policy, the signer gate, the redactor, the idempotency handling and
 * the Runner socket are all on the far side of a process boundary that an
 * adapter cannot reach around, so "the MCP host and the terminal got different
 * safety semantics" stops being possible rather than being discouraged.
 *
 * The other half of the boundary is the argv. Only two things are ever put on
 * it: the command's own CLI path, and a `--input` JSON document that the
 * command schema has already validated. Operator flags are pinned when the
 * invoker is constructed, are checked against an allowlist, and can never come
 * from a tool call — see `assertOperatorFlags`.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

/** What the adapter asks the core to run. */
export interface CoreInvocation {
  /** The contract command name, for logging and errors. */
  readonly command: string;
  /** The full argv after the binary, exactly as it will be passed. */
  readonly argv: readonly string[];
}

/** What the core answered. `stdout` is the envelope; nothing is parsed here. */
export interface CoreResponse {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CoreInvokeOptions {
  readonly signal?: AbortSignal;
}

export type CoreInvoker = (
  invocation: CoreInvocation,
  options?: CoreInvokeOptions,
) => Promise<CoreResponse>;

/**
 * Global flags an OPERATOR may pin when constructing an adapter.
 *
 * `--approve` is absent, and its absence is the point. An approval token
 * digests one exact intent, so a pinned one would either be useless or would
 * pre-authorise a single order for whatever the model later asks for. It is
 * supplied at the terminal, by a person, per order.
 *
 * `--input`, `--file` and `--stdin` are absent because the dispatcher owns the
 * input; a second source would silently win or lose against the validated one.
 */
export const ALLOWED_OPERATOR_FLAGS: readonly string[] = [
  '--config',
  '--policy',
  '--timeout-ms',
  '--runner-dir',
];

/**
 * Rejects anything an operator should not be able to pin, loudly, at
 * construction — long before a model can be blamed for it.
 */
export function assertOperatorFlags(args: readonly string[]): void {
  for (const [index, arg] of args.entries()) {
    if (!arg.startsWith('--')) continue;
    const name = arg.split('=')[0] ?? arg;
    if (!ALLOWED_OPERATOR_FLAGS.includes(name)) {
      throw new Error(
        `\`${name}\` may not be pinned on an adapter. Allowed: ${ALLOWED_OPERATOR_FLAGS.join(', ')}.` +
          (name === '--approve'
            ? ' An approval token authorises one exact intent and is supplied per order, by an operator.'
            : ''),
      );
    }
    // A flag whose value happens to look like another flag would let
    // `--config --approve` past the check above.
    const value = args[index + 1];
    if (!arg.includes('=') && value !== undefined && value.startsWith('--')) {
      throw new Error(`\`${name}\` was given \`${value}\` as its value.`);
    }
  }
}

export interface CliInvokerOptions {
  /** Absolute path to the CLI entry script. Defaults to the installed one. */
  readonly binary?: string;
  /** The child's entire environment. Never inherited implicitly. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Operator flags, pinned. Validated against the allowlist. */
  readonly operatorArgs?: readonly string[];
  /** Hard wall-clock cap per invocation. */
  readonly timeoutMs?: number;
  /** Injected in tests. */
  readonly spawn?: typeof nodeSpawn;
  /** Node executable used to run the CLI script. */
  readonly execPath?: string;
}

/**
 * Where the installed `waterx-predict` is.
 *
 * Resolved through the package's own `bin` entry rather than a guessed path, so
 * an adapter run from a global install, a pnpm store or a workspace all find
 * the same artifact the user runs.
 */
export function locateCommandCore(): string {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('@waterx/predict-agent-cli/package.json');
  const manifest = require(manifestPath) as { bin?: Record<string, string> | string };
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['waterx-predict'];
  if (bin === undefined) {
    throw new Error('`@waterx/predict-agent-cli` declares no `waterx-predict` binary.');
  }
  return resolve(dirname(manifestPath), bin);
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Runs one command in a child process and returns its streams verbatim.
 *
 * Notably absent: any interpretation. A non-zero exit is not an error here — a
 * partially successful batch exits non-zero WITH a valid envelope, and turning
 * that into a thrown error would lose the legs.
 */
export function createCliInvoker(options: CliInvokerOptions = {}): CoreInvoker {
  const operatorArgs = options.operatorArgs ?? [];
  assertOperatorFlags(operatorArgs);
  const spawn = options.spawn ?? nodeSpawn;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const execPath = options.execPath ?? process.execPath;
  let binary = options.binary;

  return (invocation, invokeOptions = {}) =>
    new Promise<CoreResponse>((settle, fail) => {
      let resolved: string;
      try {
        resolved = binary ?? (binary = locateCommandCore());
      } catch (error) {
        fail(error);
        return;
      }

      const child = spawn(execPath, [resolved, ...operatorArgs, ...invocation.argv], {
        env: { ...options.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let done = false;
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });

      // A child that outlives this turn is the failure mode the rules single
      // out, so the timer kills rather than just rejecting, and never keeps the
      // event loop alive on its own.
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
      }, timeoutMs);
      timer.unref?.();

      const abort = (): void => {
        child.kill('SIGKILL');
      };
      invokeOptions.signal?.addEventListener('abort', abort, { once: true });

      const finish = (): void => {
        clearTimeout(timer);
        invokeOptions.signal?.removeEventListener('abort', abort);
      };

      child.on('error', (error) => {
        if (done) return;
        done = true;
        finish();
        fail(error);
      });

      child.on('close', (code, signal) => {
        if (done) return;
        done = true;
        finish();
        settle({
          // A killed child has no exit code. `-1` is reported rather than 0, so
          // "the core never answered" cannot be read as success anywhere.
          exitCode: code ?? (signal === null ? -1 : 137),
          stdout,
          stderr,
        });
      });
    });
}
