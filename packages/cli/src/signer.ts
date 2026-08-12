/**
 * The signer boundary.
 *
 * A raw private key never enters this process. The only provider this version
 * supports is an external command: the CLI writes a signing request to the
 * child's stdin and reads a signature from its stdout, so the key material stays
 * inside whatever holds it — a keystore agent, a KMS shim, an HSM wrapper
 * (ADR-0001 §6). Keystore and KMS providers are not built here; backlog 1.8
 * records that gap rather than this file pretending to close it.
 *
 * READ-ONLY IS ENFORCED, NOT DOCUMENTED. `signTransaction` throws before the
 * child process is spawned. That is the whole point: a read-only runtime that
 * merely "does not call" the write path is one bug away from calling it, whereas
 * this one cannot produce a transaction signature at all. `signPersonalMessage`
 * stays available because the login challenge is a personal message, moves no
 * funds, and is not interchangeable with a transaction signature — Sui's intent
 * prefixes differ, so this signer literally cannot be tricked into authorizing a
 * transfer by being handed transaction bytes as a "message".
 */
import type { AgentSigner, SignatureWithBytes } from '@waterx/predict-agent-sdk';

import type { ResolvedConfig } from './config.ts';
import { CliError } from './errors.ts';

export type SignerPolicy = 'read-only';

export interface SignerRunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** Injected so tests never spawn a process. */
export type SignerRunner = (
  command: readonly string[],
  stdin: string,
  timeoutMs: number,
) => Promise<SignerRunResult>;

/** What the child receives on stdin. Versioned so the protocol can change. */
export interface SignerRequest {
  readonly version: 1;
  readonly type: 'PERSONAL_MESSAGE';
  readonly agentWallet: string;
  readonly messageBase64: string;
}

export interface SignerDescription {
  readonly kind: 'EXTERNAL_COMMAND' | 'NONE';
  readonly configured: boolean;
  /**
   * Always false in this version, and stated rather than omitted: a host reading
   * this has to be able to tell "cannot sign transactions" from "did not say".
   */
  readonly canSignTransactions: false;
  readonly policy: SignerPolicy;
  /** The executable's base name. Never the full argv — an argument may be a path. */
  readonly executable: string | null;
  readonly note: string;
}

const baseName = (path: string): string => path.split('/').pop() ?? path;

export function describeSigner(config: ResolvedConfig): SignerDescription {
  const command = config.signerCommand;
  const first = command?.[0];
  if (command === undefined || first === undefined) {
    return {
      kind: 'NONE',
      configured: false,
      canSignTransactions: false,
      policy: 'read-only',
      executable: null,
      note: 'No signer is configured, so no command that authenticates can run. Set WATERX_PREDICT_SIGNER_COMMAND or `signerCommand` in the config file.',
    };
  }
  return {
    kind: 'EXTERNAL_COMMAND',
    configured: true,
    canSignTransactions: false,
    policy: 'read-only',
    executable: baseName(first),
    note: 'Signs the login challenge as a personal message by writing a request to an external command. Transaction signing is refused locally before the command is spawned.',
  };
}

/**
 * Build the signer, or explain precisely what is missing.
 *
 * `toSuiAddress` returns the configured wallet rather than deriving one, because
 * deriving would require the key. The server checks that the signature resolves
 * to this address, so a mismatch fails authentication server-side instead of
 * being silently accepted.
 */
export function createSigner(
  config: ResolvedConfig,
  run: SignerRunner,
  onDiagnostic: (text: string) => void,
): AgentSigner {
  const command = config.signerCommand;
  const wallet = config.agentWallet;
  if (command === undefined || command.length === 0) {
    throw new CliError(
      'SIGNER_UNAVAILABLE',
      'No signer command is configured, so this runtime cannot authenticate. Set WATERX_PREDICT_SIGNER_COMMAND to an executable that signs a personal message.',
    );
  }
  if (wallet === undefined) {
    throw new CliError(
      'NOT_CONFIGURED',
      'No agent wallet is configured. The server verifies that the signature resolves to a specific address, so it must be stated rather than guessed.',
    );
  }

  const refuseTransaction = async (): Promise<SignatureWithBytes> => {
    throw new CliError(
      'POLICY_DENIED',
      'This CLI version is read-only and signs no transactions. The request was refused locally; no signer process was started and nothing was sent.',
      { policy: 'read-only', attempted: 'signTransaction' },
    );
  };

  return {
    toSuiAddress: () => wallet,
    signTransaction: refuseTransaction,
    signPersonalMessage: async (bytes: Uint8Array): Promise<SignatureWithBytes> => {
      const messageBase64 = Buffer.from(bytes).toString('base64');
      const request: SignerRequest = {
        version: 1,
        type: 'PERSONAL_MESSAGE',
        agentWallet: wallet,
        messageBase64,
      };
      const result = await run(command, `${JSON.stringify(request)}\n`, config.timeoutMs);

      // The child's stderr may hold its own configuration. It goes to this
      // process's stderr, redacted and truncated by the caller, and never into
      // the stdout envelope where a caller would archive it.
      if (result.stderr.trim() !== '') {
        onDiagnostic(`signer stderr: ${result.stderr.trim()}`);
      }
      if (result.timedOut) {
        throw new CliError(
          'SIGNER_FAILED',
          `The signer command did not respond within ${String(config.timeoutMs)}ms and was terminated.`,
          { executable: baseName(command[0] ?? ''), timedOut: true },
        );
      }
      if (result.code !== 0) {
        throw new CliError(
          'SIGNER_FAILED',
          `The signer command exited with status ${String(result.code)}. Its output was not used. See stderr for its own diagnostics.`,
          { executable: baseName(command[0] ?? ''), exitCode: result.code },
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        throw new CliError(
          'SIGNER_FAILED',
          'The signer command did not write JSON to stdout. It must write {"signature":"<base64>"} and nothing else.',
          { executable: baseName(command[0] ?? '') },
        );
      }
      const signature = (parsed as { signature?: unknown } | null)?.signature;
      if (typeof signature !== 'string' || signature === '') {
        throw new CliError(
          'SIGNER_FAILED',
          'The signer command returned JSON with no `signature` string.',
          { executable: baseName(command[0] ?? '') },
        );
      }
      // `bytes` is the message that was signed, echoed back for the SDK's
      // interface. The signature itself is never logged or put in an envelope.
      return { signature, bytes: messageBase64 };
    },
  };
}

/**
 * The real runner. Spawns without a shell, feeds stdin, kills on the deadline.
 *
 * No shell, so nothing in the configured argv is ever interpreted; and the child
 * is killed rather than left running, so a hung signer cannot outlive the
 * invocation that started it.
 */
export function createNodeSignerRunner(
  spawn: typeof import('node:child_process').spawn,
): SignerRunner {
  return async (command, stdin, timeoutMs) =>
    await new Promise<SignerRunResult>((resolve, reject) => {
      const [executable, ...args] = command;
      if (executable === undefined) {
        reject(new CliError('SIGNER_UNAVAILABLE', 'The signer command is empty.'));
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
          new CliError(
            'SIGNER_UNAVAILABLE',
            `The signer command could not be started: ${error.message}`,
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
        // A signer that closes stdin early is handled by the exit status below;
        // an unhandled EPIPE here would crash the process instead.
      });
      child.stdin?.end(stdin);
    });
}
