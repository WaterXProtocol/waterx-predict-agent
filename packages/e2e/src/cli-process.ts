/**
 * Driving the INSTALLED CLI as a subprocess.
 *
 * Not `run()` from the library. The thing under test is the artifact a user
 * installs: the `bin` entry, resolved through `node_modules` the way any
 * consumer resolves it, spawned as its own process, read back through its
 * stdout envelope and its exit code. Importing the command handlers instead
 * would test everything except the part that ships.
 *
 * Every run carries a `transport`. The only value this module can produce is
 * `PROCESS`. `STUB` exists in the type so the report layer can REFUSE it — see
 * `report.ts`. Nothing here fabricates a run.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { createRequire } from 'node:module';

import { lintInvocation, type LintViolation } from './lint.ts';

/** How a result was obtained. The report layer treats these very differently. */
export type Transport = 'PROCESS' | 'STUB';

export interface CliEnvelope {
  readonly schemaVersion?: string;
  readonly ok?: boolean;
  readonly command?: string;
  readonly requestId?: string;
  readonly data?: unknown;
  readonly error?: { readonly code?: string; readonly message?: string; readonly source?: string };
}

export interface CliRun {
  readonly transport: Transport;
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly durationMs: number;
  /** Parsed stdout, or null when stdout was not a single JSON document. */
  readonly envelope: CliEnvelope | null;
  /** Kept for a failure message. Never rendered into the machine report. */
  readonly stderr: string;
}

export interface CliInvoker {
  (argv: readonly string[]): Promise<CliRun>;
}

export type BinaryLocation =
  | { readonly found: true; readonly path: string }
  | { readonly found: false; readonly reason: string; readonly fix: string };

/**
 * Where the installed binary is.
 *
 * Resolved through `node_modules` from this module, which is exactly how a
 * consumer's shell resolves it after an install — not by walking up to a
 * `packages/cli/dist` path that only exists in this repository.
 */
export function locateCliBinary(): BinaryLocation {
  const require = createRequire(import.meta.url);
  let manifestPath: string;
  try {
    manifestPath = require.resolve('@waterx/predict-agent-cli/package.json');
  } catch {
    return {
      found: false,
      reason: '`@waterx/predict-agent-cli` does not resolve from this package.',
      fix: 'Run `pnpm install` at the workspace root.',
    };
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    bin?: Record<string, string>;
  };
  const relative = manifest.bin?.['waterx-predict'];
  if (relative === undefined) {
    return {
      found: false,
      reason: 'The CLI package declares no `waterx-predict` binary.',
      fix: 'Check `packages/cli/package.json`.',
    };
  }

  const path = resolvePath(dirname(manifestPath), relative);
  if (!existsSync(path)) {
    return {
      found: false,
      // The binary is built output on purpose (a `bin` pointing at TypeScript
      // works on the author's machine and nowhere else), so an unbuilt checkout
      // has nothing to drive.
      reason: `The CLI is not built: ${relative} does not exist.`,
      fix: 'Run `pnpm build` at the workspace root.',
    };
  }
  return { found: true, path };
}

export interface InvokerOptions {
  readonly binary: string;
  /** REPLACES the environment of the child. Nothing leaks in implicitly. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

/**
 * A real invoker over a real process.
 *
 * The invocation is linted against the command contract BEFORE it is spawned. A
 * harness that reported `USAGE` from its own typo as an E2E failure would send
 * someone looking at the server.
 */
export function processInvoker(options: InvokerOptions): CliInvoker {
  return async (argv) => {
    const violations: readonly LintViolation[] = lintInvocation(argv);
    if (violations.length > 0) {
      throw new Error(
        `This harness built an invocation the CLI would reject: ${violations
          .map((violation) => violation.message)
          .join(' ')}`,
      );
    }
    return spawnCli(argv, options);
  };
}

function spawnCli(argv: readonly string[], options: InvokerOptions): Promise<CliRun> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [options.binary, ...argv], {
      env: { ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    // The harness must not outlive its turn, and a hung child would make it. The
    // CLI has its own `--timeout-ms`; this is the backstop for the case where the
    // process itself stops responding.
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, options.timeoutMs);
    timer.unref?.();

    child.on('error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code: number | null, signal: string | null) => {
      clearTimeout(timer);
      resolve({
        transport: 'PROCESS',
        argv,
        // A killed child has no exit code. 137 is the conventional 128+SIGKILL,
        // and it must not be confused with the CLI's own codes.
        exitCode: code ?? (signal === null ? -1 : 137),
        durationMs: Date.now() - startedAt,
        envelope: parseEnvelope(stdout),
        stderr,
      });
    });
  });
}

/**
 * stdout is exactly one JSON document, on every path. Anything else is a
 * contract violation by the CLI, and is reported as `envelope: null` rather than
 * salvaged — a harness that dug a document out of noisy output would hide the
 * defect it exists to catch.
 */
function parseEnvelope(stdout: string): CliEnvelope | null {
  const trimmed = stdout.trim();
  if (trimmed === '') return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as CliEnvelope;
  } catch {
    return null;
  }
}
