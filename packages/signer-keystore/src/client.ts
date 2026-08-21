/**
 * The thin half: one request, one socket, one signature.
 *
 * This is what `WATERX_PREDICT_SIGNER_COMMAND` points at. It holds nothing,
 * decides nothing, and exists only so the runtime that spawns it never has to
 * know where the key lives — swap the agent for a KMS shim and this file is the
 * only thing that changes.
 *
 * A refusal from the agent is passed through as a refusal, not as a signature
 * and not as silence: the caller's `SIGNER_FAILED` is the honest outcome when
 * nobody signed.
 */
import { connect } from 'node:net';

import { AGENT_PROTOCOL } from './agent.ts';
import { SignerRefusal, type SignerRequest } from './protocol.ts';

export interface AskOptions {
  readonly socketPath: string;
  readonly token: string;
  readonly request: SignerRequest;
  readonly timeoutMs?: number;
}

/** Long enough for scrypt to be irrelevant (the agent is already unlocked). */
export const DEFAULT_TIMEOUT_MS = 15_000;

export const askAgent = async (options: AskOptions): Promise<string> =>
  await new Promise<string>((resolve, reject) => {
    const socket = connect({ path: options.socketPath });
    let buffer = '';
    let settled = false;
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new SignerRefusal(message));
    };
    const timer = setTimeout(
      () => fail(`the keystore agent did not answer within ${String(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)}ms`),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    timer.unref?.();

    socket.setEncoding('utf8');
    socket.on('error', (error: NodeJS.ErrnoException) => {
      // The common one by far, and the one worth explaining: no agent is running.
      fail(
        error.code === 'ENOENT' || error.code === 'ECONNREFUSED'
          ? `no keystore agent is listening at ${options.socketPath}. Start one with \`waterx-predict-keystore agent\`.`
          : `keystore agent socket error: ${error.message}`,
      );
    });
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ token: options.token, request: options.request })}\n`);
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      clearTimeout(timer);
      let reply: { signature?: unknown; error?: unknown };
      try {
        reply = JSON.parse(buffer.slice(0, newline)) as typeof reply;
      } catch {
        fail('the keystore agent answered with something that was not JSON');
        return;
      }
      if (typeof reply.signature === 'string' && reply.signature !== '') {
        if (settled) return;
        settled = true;
        socket.end();
        resolve(reply.signature);
        return;
      }
      fail(typeof reply.error === 'string' ? reply.error : 'the keystore agent returned no signature');
    });
    socket.on('close', () => {
      clearTimeout(timer);
      if (!settled) fail('the keystore agent closed the connection without answering');
    });
  });
