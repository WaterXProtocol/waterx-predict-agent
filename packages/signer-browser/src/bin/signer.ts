#!/usr/bin/env node
/**
 * `waterx-predict-browser-signer` — a signer provider that asks a person.
 *
 * Wire it in as the CLI's external signer command:
 *
 *   WATERX_PREDICT_SIGNER_COMMAND='["waterx-predict-browser-signer"]'
 *
 * It reads one JSON request on stdin and writes one JSON response on stdout, per
 * SIGNER_PROTOCOL v1. Everything else — the URL it is waiting on, why it refused
 * — goes to stderr, because stdout belongs to the caller's parser.
 *
 * This is the provider for `interactive`: every signature is a person looking at
 * a wallet dialog. It is deliberately NOT usable by the Runner, which signs when
 * a price target fires at an hour nobody is watching; that path needs a keystore
 * or a KMS (backlog 1.8).
 */
import { spawn } from 'node:child_process';
import { platform } from 'node:process';

import { parseRequest, SignerRefusal } from '../protocol.ts';
import { DEFAULTS, signInBrowser } from '../sign.ts';

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
};

/** Best effort. A signer that cannot open a browser still prints the URL. */
const openInBrowser = (url: string): void => {
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(command, [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    // The URL is already on stderr; a failed launcher is not a failed signer.
  }
};

const positiveInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

const main = async (): Promise<void> => {
  const request = parseRequest(await readStdin());
  const signature = await signInBrowser({
    request,
    chain: process.env['WATERX_SIGNER_CHAIN'] ?? DEFAULTS.chain,
    timeoutMs: positiveInt(process.env['WATERX_SIGNER_TIMEOUT_MS'], DEFAULTS.timeoutMs),
    openUrl: openInBrowser,
    onDiagnostic: (line) => process.stderr.write(`${line}\n`),
  });
  // Exactly the protocol response, and nothing else, on stdout.
  process.stdout.write(`${JSON.stringify({ signature })}\n`);
};

try {
  await main();
  process.exit(0);
} catch (error) {
  const message = error instanceof SignerRefusal || error instanceof Error ? error.message : String(error);
  process.stderr.write(`waterx-predict-browser-signer: ${message}\n`);
  process.exit(1);
}
