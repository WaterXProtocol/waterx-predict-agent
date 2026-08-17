/**
 * The signer boundary.
 *
 * A raw private key never enters this process. The only provider this version
 * supports is an external command: the CLI writes a signing request to the
 * child's stdin and reads a signature from its stdout, so the key material stays
 * inside whatever holds it — a keystore agent, a KMS shim, an HSM wrapper
 * (ADR-0001 §6). Keystore, keychain and KMS providers are not built here;
 * backlog 1.8 records that gap rather than this file pretending to close it.
 *
 * TWO SIGNATURE KINDS, NEVER INTERCHANGEABLE. A `PERSONAL_MESSAGE` request signs
 * the login challenge: it moves no funds, and Sui's intent prefixes mean the
 * resulting signature cannot authorize a transaction. A `TRANSACTION` request
 * signs sponsored transaction bytes and can move funds. They are separate request
 * types on the wire to the signer so a provider can hold them to different rules,
 * and this CLI never sends transaction bytes as a "message" to get around a
 * refusal.
 *
 * THE POLICY IS ENFORCED, NOT DOCUMENTED.
 *   - under `read-only`, `signTransaction` throws BEFORE the child process is
 *     spawned. A read-only runtime that merely "does not call" the write path is
 *     one bug away from calling it; this one cannot produce a transaction
 *     signature at all.
 *   - under every other policy, `signTransaction` first spends a permit from the
 *     `SigningGate`, which only a command holding a `WriteAuthorization` can have
 *     granted. A path that reaches the signer without having been authorized does
 *     not skip a check — it runs out of permits and is refused.
 *
 * Nothing here logs a signature, transaction bytes or the child's stdout. The
 * child's stderr is forwarded to this process's stderr, redacted by the caller,
 * and never enters the result envelope.
 */
import type { AgentSigner, SignatureWithBytes } from '@waterx/predict-agent-sdk';

import type { ResolvedConfig } from './config.ts';
import { CliError } from './errors.ts';
import type { PolicyMode, SigningGate } from './policy.ts';

export type SignerPolicy = PolicyMode;

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

/**
 * The local signing protocol, as data.
 *
 * The Runner speaks the same wire to the same keystore command
 * (`packages/runner/src/signer.ts`), and an operator who configured one must not
 * have to configure a second. Neither package may depend on the other — the CLI
 * would be importing a daemon, the Runner a CLI — so the two implementations are
 * genuinely separate, and `tests/workspace.test.ts` asserts these two descriptors
 * are equal. `tests/signer.test.ts` asserts the request this file actually writes
 * has exactly the keys listed here, which is what makes the descriptor a claim
 * about behaviour rather than a comment.
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
 * What the child receives on stdin, as one JSON line. Versioned so the protocol
 * can change, and discriminated on `type` so a provider can require a different
 * confirmation for a transaction than for a login challenge.
 */
export type SignerRequest =
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

/** Providers this build knows about. Only one of them is implemented. */
export type SignerProviderKind = 'EXTERNAL_COMMAND' | 'KEYSTORE_FILE' | 'OS_KEYCHAIN' | 'KMS';

export interface SignerProviderSupport {
  readonly kind: SignerProviderKind;
  readonly implemented: boolean;
  readonly note: string;
  /** The backlog id that tracks building it. Absent when it exists. */
  readonly tracking?: string;
}

/**
 * Every provider the plan names, with its real status.
 *
 * Listed rather than filtered: a host reading this has to be able to tell "this
 * runtime cannot use a keychain" from "this runtime did not mention keychains".
 */
export const SIGNER_PROVIDERS: readonly SignerProviderSupport[] = [
  {
    kind: 'EXTERNAL_COMMAND',
    implemented: true,
    note: 'The CLI writes a JSON signing request to a child process’s stdin and reads {"signature":"<base64>"} from its stdout. The key stays inside the child; this process never holds one.',
  },
  {
    kind: 'KEYSTORE_FILE',
    implemented: false,
    note: 'An encrypted keystore unlocked by this process. Not built: it would put decrypted key material in this address space, which needs a decision about how it is held and zeroed.',
    tracking: '1.8',
  },
  {
    kind: 'OS_KEYCHAIN',
    implemented: false,
    note: 'macOS Keychain or libsecret. Not built. A keychain-backed external command is the supported way to get this behaviour today.',
    tracking: '1.8',
  },
  {
    kind: 'KMS',
    implemented: false,
    note: 'A remote KMS or HSM. Not built. A KMS-backed external command is the supported way to get this behaviour today.',
    tracking: '1.8',
  },
];

export interface SignerDescription {
  readonly kind: 'EXTERNAL_COMMAND' | 'NONE';
  readonly configured: boolean;
  /**
   * Whether this invocation could produce a transaction signature at all. Stated
   * rather than omitted: a host has to be able to tell "cannot sign transactions"
   * from "did not say". False under the read-only policy, where it is a property
   * of the code path and not of the caller's restraint.
   */
  readonly canSignTransactions: boolean;
  readonly policy: SignerPolicy;
  /** The executable's base name. Never the full argv — an argument may be a path. */
  readonly executable: string | null;
  readonly note: string;
  readonly providers: readonly SignerProviderSupport[];
}

const baseName = (path: string): string => path.split('/').pop() ?? path;

export function describeSigner(config: ResolvedConfig): SignerDescription {
  const policy = config.policy.mode;
  const command = config.signerCommand;
  const first = command?.[0];
  if (command === undefined || first === undefined) {
    return {
      kind: 'NONE',
      configured: false,
      canSignTransactions: false,
      policy,
      executable: null,
      note: 'No signer is configured, so no command that authenticates can run. Set WATERX_PREDICT_SIGNER_COMMAND or `signerCommand` in the config file.',
      providers: SIGNER_PROVIDERS,
    };
  }
  return {
    kind: 'EXTERNAL_COMMAND',
    configured: true,
    canSignTransactions: policy !== 'read-only',
    policy,
    executable: baseName(first),
    note:
      policy === 'read-only'
        ? 'Signs the login challenge as a personal message by writing a request to an external command. Transaction signing is refused locally before the command is spawned.'
        : 'Signs the login challenge as a personal message, and sponsored transaction bytes for an order the execution policy has already authorized. An unauthorized transaction signature is refused before the command is spawned.',
    providers: SIGNER_PROVIDERS,
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
  gate?: SigningGate,
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

  /** Run the child for one request and return the signature it produced. */
  const sign = async (request: SignerRequest): Promise<string> => {
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
        { executable: baseName(command[0] ?? ''), timedOut: true, request: request.type },
      );
    }
    if (result.code !== 0) {
      throw new CliError(
        'SIGNER_FAILED',
        `The signer command exited with status ${String(result.code)}. Its output was not used. See stderr for its own diagnostics.`,
        { executable: baseName(command[0] ?? ''), exitCode: result.code, request: request.type },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new CliError(
        'SIGNER_FAILED',
        'The signer command did not write JSON to stdout. It must write {"signature":"<base64>"} and nothing else.',
        { executable: baseName(command[0] ?? ''), request: request.type },
      );
    }
    const signature = (parsed as { signature?: unknown } | null)?.signature;
    if (typeof signature !== 'string' || signature === '') {
      throw new CliError(
        'SIGNER_FAILED',
        'The signer command returned JSON with no `signature` string.',
        { executable: baseName(command[0] ?? ''), request: request.type },
      );
    }
    return signature;
  };

  return {
    toSuiAddress: () => wallet,
    /**
     * Sponsored transaction bytes. Refused outright under the read-only policy,
     * and otherwise only against a permit the execution policy already granted —
     * both checks happen before the child is spawned, so a refusal costs nothing
     * and reveals nothing.
     */
    signTransaction: async (bytes: Uint8Array): Promise<SignatureWithBytes> => {
      if (config.policy.mode === 'read-only') {
        throw new CliError(
          'POLICY_DENIED',
          'The execution policy is read-only, so this runtime signs no transactions. The request was refused locally; no signer process was started and nothing was sent.',
          { policy: 'read-only', attempted: 'signTransaction' },
        );
      }
      if (gate === undefined) {
        throw new CliError(
          'POLICY_DENIED',
          'No signing gate was installed for this invocation, so no transaction signature can be authorized. The signer was not started.',
          { policy: config.policy.mode, attempted: 'signTransaction' },
        );
      }
      // Spends the permit BEFORE the child runs. A gate checked afterwards would
      // have already produced the signature it was meant to prevent.
      gate.consume();
      const transactionBytesBase64 = Buffer.from(bytes).toString('base64');
      const signature = await sign({
        version: 1,
        type: 'TRANSACTION',
        agentWallet: wallet,
        transactionBytesBase64,
      });
      return { signature, bytes: transactionBytesBase64 };
    },
    signPersonalMessage: async (bytes: Uint8Array): Promise<SignatureWithBytes> => {
      const messageBase64 = Buffer.from(bytes).toString('base64');
      const signature = await sign({
        version: 1,
        type: 'PERSONAL_MESSAGE',
        agentWallet: wallet,
        messageBase64,
      });
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
