/**
 * The resident half: unlocked once, signs for as long as it runs.
 *
 * A price trigger fires at 03:00 and nobody is awake to approve it, so
 * `delegated-auto` needs a signer that does not ask. The only way to have that
 * and still not put a decrypted key in every process is the shape ssh-agent
 * settled on decades ago: one long-lived holder, and a thin client per request.
 *
 * The Runner spawns the client (`SIGNER_PROTOCOL`, one JSON line each way); the
 * client reaches this agent over a private socket. So the Runner still never
 * holds key material — ADR-0001 §7 stands — and the passphrase is typed exactly
 * once, when an operator starts the agent.
 *
 * ## What it refuses
 *
 * - **An address it does not hold.** The request names an `agentWallet`; a key
 *   that is not that address signs nothing. A signature from the wrong account is
 *   not a smaller version of the right one.
 * - **A caller without the token.** Minted per start, written 0600 beside the
 *   socket, compared in constant time. A stale token from a dead agent stops
 *   working the moment a new one takes over.
 * - **A runtime directory anyone else can reach.** Asserted, never repaired:
 *   quietly tightening someone's filesystem is not this program's call.
 *
 * What it does NOT do is decide whether a signature *should* happen. That is the
 * job of the policy in the runtime that asked (`packages/cli/src/policy.ts`, the
 * Runner's job snapshot). A signer that also enforced policy would be a second
 * place for the rules to live, and the two would drift.
 */
import { createServer, type Server, type Socket } from 'node:net';

import { tokensMatch } from './keystore.ts';
import { parseRequest, sameAddress, SignerRefusal, type SignerRequest } from './protocol.ts';

/** One line of JSON in, one out. The same shape the CLI's signer speaks. */
export const AGENT_PROTOCOL = {
  version: 1,
  socketFile: 'keystore.sock',
  tokenFile: 'keystore.token',
  runtimeDirEnv: 'WATERX_KEYSTORE_DIR',
  defaultRuntimeDir: ['.waterx', 'keystore'],
  /** A signature is small; anything larger is a peer that has lost the plot. */
  maxFrameBytes: 256 * 1024,
} as const;

export interface HeldKey {
  readonly address: string;
  signPersonalMessage(message: Uint8Array): Promise<{ signature: string }>;
  signTransaction(bytes: Uint8Array): Promise<{ signature: string }>;
}

export interface AgentOptions {
  readonly key: HeldKey;
  readonly token: string;
  /** Diagnostics. Never given a signature, a passphrase or key material. */
  readonly onEvent?: (event: string) => void;
}

interface RequestFrame {
  readonly token?: unknown;
  readonly request?: unknown;
}

/**
 * Answers one framed request.
 *
 * Exported so a test drives the decision without a socket: everything that can
 * refuse does so here, before any signing.
 */
export const answer = async (
  frame: RequestFrame,
  options: AgentOptions,
): Promise<{ readonly signature: string } | { readonly error: string }> => {
  if (typeof frame.token !== 'string' || !tokensMatch(frame.token, options.token)) {
    return { error: 'UNAUTHENTICATED' };
  }
  let request: SignerRequest;
  try {
    request = parseRequest(JSON.stringify(frame.request));
  } catch (error) {
    return { error: error instanceof SignerRefusal ? error.message : 'malformed request' };
  }
  if (!sameAddress(request.agentWallet, options.key.address)) {
    // Named, because an operator who pointed the Runner at the wrong keystore
    // needs to see which key is actually loaded, not "signing failed".
    return {
      error: `this agent holds ${options.key.address}, and the request asked ${request.agentWallet} to sign`,
    };
  }
  const signed =
    request.type === 'PERSONAL_MESSAGE'
      ? await options.key.signPersonalMessage(Buffer.from(request.messageBase64, 'base64'))
      : await options.key.signTransaction(Buffer.from(request.transactionBytesBase64, 'base64'));
  options.onEvent?.(`signed ${request.type}`);
  return { signature: signed.signature };
};

/** Binds the socket. The caller is responsible for the directory's privacy. */
export const createAgentServer = (options: AgentOptions): Server =>
  createServer((socket: Socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > AGENT_PROTOCOL.maxFrameBytes) {
        socket.end(`${JSON.stringify({ error: 'FRAME_TOO_LARGE' })}\n`);
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      buffer = '';
      void (async () => {
        let reply: { signature: string } | { error: string };
        try {
          reply = await answer(JSON.parse(line) as RequestFrame, options);
        } catch (error) {
          reply = { error: error instanceof Error ? error.message : 'internal' };
        }
        socket.end(`${JSON.stringify(reply)}\n`);
      })();
    });
    socket.on('error', () => socket.destroy());
  });
