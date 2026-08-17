/**
 * The signer, inside the Runner trust boundary.
 *
 * ADR-0001 §7 puts exactly one thing in this position: the component that turns
 * sponsored transaction bytes into a signature. Models, agent subprocesses and
 * the executor itself never hold key material, and neither does this module — the
 * only provider it implements is an **external command**, so the key stays inside
 * whatever already holds it: a keystore agent, a KMS shim, an HSM wrapper. A
 * versioned JSON request goes in on the child's stdin, `{"signature":"…"}` comes
 * back on its stdout, and nothing in this process ever sees a private key.
 *
 * ## The same protocol the CLI speaks
 *
 * `packages/cli/src/signer.ts` already defines this wire, and an operator who
 * pointed the CLI and the Runner at one keystore command must not need two of
 * them. The request shapes are therefore identical, and {@link SIGNER_PROTOCOL}
 * is exported from *both* packages and asserted equal in `tests/workspace.test.ts`
 * — the CLI cannot depend on the Runner, and the Runner must not depend on the
 * CLI, so the duplication is real and the invariant is what stops it drifting.
 *
 * `PERSONAL_MESSAGE` is part of the protocol because a key holder has to be able
 * to tell the two apart: it signs a login challenge, moves no funds, and Sui's
 * intent prefixes mean its signature cannot authorize a transaction. **This module
 * only ever emits `TRANSACTION`.** A Runner does not authenticate — the client it
 * is handed is already authenticated — and a signer that could be asked for
 * either would be one refusal away from sending transaction bytes as a "message".
 *
 * ## Why the signer, and not the caller, applies the policy
 *
 * An unattended daemon cannot perform an interactive approval. Interactive is the
 * DEFAULT approval mode, and scoped `delegated-auto` is the one that requires an
 * explicit local policy plus the owner's backend risk profile (ADR-0001 §9). So a
 * daemon that signed under an `interactive` snapshot would silently convert the
 * safe default into unattended trading, and — worse — would make the whole
 * `delegated-auto` scope evadable by wrapping any order in a strategy whose
 * trigger is already met.
 *
 * This is enforced in three places on purpose, and each catches something the
 * others cannot:
 *
 *   1. `normalizeStrategy` refuses to *create* a durable job under `read-only` or
 *      `interactive`, so an operator learns at the prompt rather than hours later.
 *   2. `preflight` stops a job whose snapshot says either, before it reads a
 *      market or a quote — a job written by an older build, or by anything that
 *      skipped creation, costs no network call and creates no execution.
 *   3. **Here**, before a child process exists. A read-only or interactive runtime
 *      that merely "does not call" the signing path is one bug away from calling
 *      it; this one is incapable of producing a transaction signature at all.
 *
 * The refusals are features. They are tested as such.
 *
 * ## What is deliberately re-checked here
 *
 * - **`notAfter`.** `preflight` reads it at the top of the pass, and a pass makes
 *   network calls; a mandate that runs out between the check and the signature
 *   must not sign. This module reads its own clock at the moment of signing.
 * - **The agent wallet.** The signer is configured for one wallet. A job naming a
 *   different one is refused rather than signed, so two agents sharing a store
 *   cannot have one's signer authorize the other's order.
 *
 * ## What never leaves this module
 *
 * The signature, the transaction bytes and the child's stdout. `onDiagnostic`
 * receives the child's **stderr** only, because that is where a signer writes its
 * own configuration problems and an operator has to be able to see them; the
 * caller redacts and writes it to stderr, and nothing puts it in a durable record.
 * No error detail here carries bytes or a signature — only a length, an exit
 * status and the executable's base name.
 */
import { systemClock, type Clock } from './clock.ts';
import type { JobPolicySnapshot } from './job.ts';
import type { StrategySignRequest, StrategySigner } from './strategy/gateway.ts';

/**
 * The local signing protocol, as data.
 *
 * Exported so the two implementations of it can be compared by a test rather
 * than by reading them side by side. Every field name a request carries is
 * listed, in order, and each package's own suite asserts that the object it
 * actually writes to a child's stdin has exactly these keys — so this is a
 * description of behaviour, not a comment that happens to be in a const.
 */
export const SIGNER_PROTOCOL = {
  version: 1,
  requests: [
    {
      type: 'PERSONAL_MESSAGE',
      fields: ['version', 'type', 'agentWallet', 'messageBase64'],
    },
    {
      type: 'TRANSACTION',
      fields: ['version', 'type', 'agentWallet', 'transactionBytesBase64'],
    },
  ],
  response: { fields: ['signature'] },
} as const;

/**
 * One line of JSON on the child's stdin.
 *
 * Versioned so the protocol can change without a silent reinterpretation, and
 * discriminated on `type` so a key holder can hold a transaction to a different
 * rule than a login challenge.
 */
export type RunnerSignerRequest =
  | {
      readonly version: 1;
      readonly type: 'PERSONAL_MESSAGE';
      readonly agentWallet: string;
      readonly messageBase64: string;
    }
  | {
      readonly version: 1;
      readonly type: 'TRANSACTION';
      readonly agentWallet: string;
      /** Sponsored transaction bytes, base64. Never logged and never echoed. */
      readonly transactionBytesBase64: string;
    };

/** Every way this signer refuses. Each names a decision, not a diagnostic. */
export type SignerErrorCode =
  /* ── Refused before a child process exists ─────────────────────────────── */
  /**
   * The job was admitted under `read-only`. A read-only runtime signs nothing;
   * this is a property of the code path, not of the caller's restraint.
   */
  | 'POLICY_READ_ONLY'
  /**
   * The job was admitted under `interactive`, the default. Approving a write
   * interactively requires someone to ask, and an unattended daemon has nobody
   * to ask — so it refuses rather than approving on their behalf.
   */
  | 'POLICY_REQUIRES_APPROVAL'
  /**
   * A policy mode this build does not recognize, from a store a newer build
   * wrote. An unknown authority is not an authority.
   */
  | 'POLICY_MODE_UNRECOGNIZED'
  /** The delegated scope's `notAfter` passed. Re-read here, at signing time. */
  | 'POLICY_SCOPE_EXPIRED'
  /** The job names an agent wallet this signer does not hold a key for. */
  | 'WALLET_MISMATCH'
  /** No bytes to sign. A signature over nothing would be a signature over anything. */
  | 'NOTHING_TO_SIGN'
  /** The lease signal aborted: this Runner no longer owns the job. */
  | 'ABORTED'
  /** No signer command is configured, so this Runner cannot sign at all. */
  | 'SIGNER_UNAVAILABLE'

  /* ── The child ran and did not produce a usable signature ──────────────── */
  /** Non-zero exit, unusable stdout, or no `signature` string. Never fabricated. */
  | 'SIGNER_FAILED'
  /** The child did not answer within the deadline and was killed. */
  | 'SIGNER_TIMEOUT';

export class SignerError extends Error {
  override readonly name = 'SignerError';

  constructor(
    readonly code: SignerErrorCode,
    message: string,
    readonly detail?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}

export const isSignerError = (value: unknown): value is SignerError => value instanceof SignerError;

/**
 * Whether the code refused before spawning anything.
 *
 * Useful to a caller that wants to distinguish "this job will never be signable
 * by this Runner" from "the key holder was unreachable this time". The driver
 * does not branch on it — an unsigned execution is left for the reconciler
 * either way — but a diagnostic that conflated the two would send an operator
 * looking at their keystore for a policy decision.
 */
export const isPreSpawnRefusal = (code: SignerErrorCode): boolean =>
  code !== 'SIGNER_FAILED' && code !== 'SIGNER_TIMEOUT';

/* ── The policy gate ───────────────────────────────────────────────────────── */

export interface PolicyRefusal {
  readonly code: SignerErrorCode;
  readonly message: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

/**
 * The one authority question: may an unattended process sign under this snapshot?
 *
 * Pure, exported and total over the mode, so the rule can be asserted directly
 * rather than inferred from whether a fake child was spawned. `undefined` is the
 * only answer that permits a signature.
 */
export const refusePolicy = (
  policy: JobPolicySnapshot,
  at: string,
): PolicyRefusal | undefined => {
  const mode: string = policy.mode;
  if (mode === 'read-only') {
    return {
      code: 'POLICY_READ_ONLY',
      message:
        'the job was admitted under a read-only policy, so this Runner signs nothing for it; no signer process was started',
      detail: { mode, source: policy.source },
    };
  }
  if (mode === 'interactive') {
    return {
      code: 'POLICY_REQUIRES_APPROVAL',
      message:
        'the job was admitted under the interactive policy, which requires a person to approve each write, and an unattended Runner has nobody to ask; a scoped delegated-auto policy is what authorizes unattended signing',
      detail: { mode, source: policy.source },
    };
  }
  if (mode !== 'delegated-auto') {
    return {
      code: 'POLICY_MODE_UNRECOGNIZED',
      message: `policy mode ${mode} is not one this build recognizes, and an unrecognized authority is not an authority`,
      detail: { mode, source: policy.source },
    };
  }
  const notAfter = policy.notAfter;
  if (notAfter !== undefined && Date.parse(notAfter) <= Date.parse(at)) {
    return {
      code: 'POLICY_SCOPE_EXPIRED',
      message: `the delegated scope ended at ${notAfter}; it is now ${at}, so the mandate that admitted this job no longer authorizes a signature`,
      detail: { mode, source: policy.source, notAfter, at },
    };
  }
  return undefined;
};

/* ── Running the child ─────────────────────────────────────────────────────── */

export interface SignerRunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/**
 * Injected, so no test in this package spawns a process.
 *
 * The same shape the CLI uses, for the same reason: the interesting behaviour is
 * what is done with a child's answer, and a suite that had to produce a real one
 * would be testing the shell.
 */
export type SignerRunner = (
  command: readonly string[],
  stdin: string,
  timeoutMs: number,
) => Promise<SignerRunResult>;

export interface ExternalCommandSignerOptions {
  /** argv, run without a shell. Nothing in it is ever interpreted. */
  readonly command: readonly string[];
  /** The one wallet this signer holds a key for. A job naming another is refused. */
  readonly agentWallet: string;
  readonly run: SignerRunner;
  /** How long the key holder gets. Killed, never left running, on the deadline. */
  readonly timeoutMs?: number;
  readonly now?: Clock;
  /**
   * The child's **stderr**, trimmed. Never its stdout, never the bytes and never
   * the signature. The caller redacts this and writes it to its own stderr.
   */
  readonly onDiagnostic?: (text: string) => void;
}

/** Never the full argv: an argument may be a path that says who the operator is. */
const baseName = (path: string): string => path.split('/').pop() ?? path;

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * The Runner's signer: an external command, gated by the job's own authority.
 *
 * Construction validates the configuration, so a Runner wired up wrong fails at
 * start-up rather than at the first trigger — the worst possible moment to
 * discover a signer does not exist is the instant a target is met.
 */
export const createExternalCommandSigner = (
  options: ExternalCommandSignerOptions,
): StrategySigner => {
  const executable = options.command[0];
  if (executable === undefined || executable === '') {
    throw new SignerError(
      'SIGNER_UNAVAILABLE',
      'no signer command is configured, so this Runner can sign nothing and must not claim it drives jobs',
    );
  }
  if (options.agentWallet === '') {
    throw new SignerError(
      'SIGNER_UNAVAILABLE',
      'no agent wallet is configured for the signer; it must be stated so a job belonging to another agent can be refused rather than signed',
    );
  }
  const now = options.now ?? systemClock;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const where = baseName(executable);

  return {
    sign: async (request: StrategySignRequest, signal?: AbortSignal): Promise<string> => {
      // Everything below this comment happens BEFORE a child process exists. A
      // refusal therefore costs nothing, reveals nothing, and cannot be raced by
      // a signature that was already being produced.
      const at = now();
      const context = { jobId: request.jobId, legIndex: request.legIndex };

      const refusal = refusePolicy(request.policy, at);
      if (refusal !== undefined) {
        throw new SignerError(refusal.code, refusal.message, { ...context, ...refusal.detail });
      }
      if (request.agentWallet !== options.agentWallet) {
        // Addresses are public, so naming both is not a leak — and an operator
        // debugging a shared store needs to see which two disagreed.
        throw new SignerError(
          'WALLET_MISMATCH',
          'the job names an agent wallet this signer holds no key for; it was refused rather than signed',
          { ...context, jobWallet: request.agentWallet, signerWallet: options.agentWallet },
        );
      }
      if (request.sponsoredTransactionBytes === '') {
        throw new SignerError(
          'NOTHING_TO_SIGN',
          'the execution carried no sponsored transaction bytes; a signature over nothing is not a signature over this order',
          context,
        );
      }
      if (signal?.aborted === true) {
        throw new SignerError(
          'ABORTED',
          'the lease signal aborted before the signer was started: this Runner no longer owns the job, so it must not authorize its order',
          context,
        );
      }

      const wire: RunnerSignerRequest = {
        version: 1,
        type: 'TRANSACTION',
        agentWallet: options.agentWallet,
        transactionBytesBase64: request.sponsoredTransactionBytes,
      };
      const result = await options.run(options.command, `${JSON.stringify(wire)}\n`, timeoutMs);

      if (result.stderr.trim() !== '') {
        options.onDiagnostic?.(result.stderr.trim());
      }
      if (result.timedOut) {
        throw new SignerError(
          'SIGNER_TIMEOUT',
          `the signer command did not answer within ${String(timeoutMs)}ms and was terminated; whether it signed is unknown, and this execution was not submitted`,
          { ...context, executable: where, timeoutMs },
        );
      }
      if (result.code !== 0) {
        throw new SignerError(
          'SIGNER_FAILED',
          `the signer command exited with status ${String(result.code)}; its output was not used`,
          { ...context, executable: where, exitCode: result.code },
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        // The message says what was expected and never what arrived: unparsed
        // stdout may hold anything, including the signature itself.
        throw new SignerError(
          'SIGNER_FAILED',
          'the signer command did not write JSON to stdout; it must write {"signature":"<base64>"} and nothing else',
          { ...context, executable: where, stdoutBytes: result.stdout.length },
        );
      }
      const signature = (parsed as { signature?: unknown } | null)?.signature;
      if (typeof signature !== 'string' || signature === '') {
        throw new SignerError(
          'SIGNER_FAILED',
          'the signer command returned JSON with no `signature` string; a signature is never fabricated from a partial answer',
          { ...context, executable: where },
        );
      }
      return signature;
    },
  };
};

/**
 * The real runner. Spawns without a shell, feeds stdin, kills on the deadline.
 *
 * `shell: false`, so nothing in the configured argv is interpreted; and the child
 * is killed rather than abandoned, because a hung signer that outlived the pass
 * would be a process holding a key open with nobody watching it.
 *
 * `spawn` is a parameter rather than an import so this function can be covered
 * without `node:child_process` being reached at all.
 */
export const createChildProcessSignerRunner = (
  spawn: typeof import('node:child_process').spawn,
): SignerRunner => {
  return async (command, stdin, timeoutMs) =>
    await new Promise<SignerRunResult>((resolve, reject) => {
      const [executable, ...args] = command;
      if (executable === undefined) {
        reject(new SignerError('SIGNER_UNAVAILABLE', 'the signer command is empty'));
        return;
      }
      const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let settled = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on('data', (chunk: string) => {
        stderr += chunk;
      });
      child.on('error', (error: Error) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        reject(
          new SignerError(
            'SIGNER_UNAVAILABLE',
            `the signer command could not be started: ${error.message}`,
            { executable: baseName(executable) },
          ),
        );
      });
      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;
        resolve({ code, stdout, stderr, timedOut });
      });

      child.stdin?.on('error', () => {
        // A signer that closes stdin early is reported by its exit status below.
        // An unhandled EPIPE here would take the whole Runner down instead.
      });
      child.stdin?.end(stdin);
    });
};
