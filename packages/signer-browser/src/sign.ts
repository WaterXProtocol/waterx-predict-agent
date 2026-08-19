/**
 * One request, one browser round trip, one signature.
 *
 * The load-bearing decisions:
 *
 * - **A transaction is decoded here, in Node.** `Transaction.from(bytes)` then
 *   `toJSON()` gives the wallet something it can render, so the person approving
 *   sees what they are approving. A wallet asked to sign opaque bytes either
 *   refuses or asks someone to trust a blob, and neither is a signature anybody
 *   should want.
 * - **It signs; it never executes.** A sponsored order carries a gas owner that
 *   is not the sender, so the chain wants two signatures and the second one is
 *   the server's. A wallet told to execute such a transaction fails with
 *   "Expected 2 signer signature but got 1" — which is the chain being right.
 * - **Loopback, ephemeral port, single-use nonce.** The page is reachable only
 *   from this machine and its answer is accepted once.
 * - **stdout carries exactly the protocol response.** Diagnostics go to stderr,
 *   and the signature appears in neither.
 */
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';

import { buildPage } from './page.ts';
import { SignerRefusal, type SignerRequest } from './protocol.ts';

export interface SignOptions {
  readonly request: SignerRequest;
  /** Which chain the wallet is told the transaction belongs to. */
  readonly chain?: string;
  readonly timeoutMs?: number;
  /** Injectable so a test drives the flow without a browser. */
  readonly openUrl?: (url: string) => void;
  /** Injectable so a test does not need the Sui SDK. */
  readonly decodeTransaction?: (bytes: Uint8Array) => Promise<string>;
  readonly onDiagnostic?: (line: string) => void;
}

export const DEFAULTS = {
  chain: 'sui:testnet',
  /** A person has to read a transaction and press a button. Seconds are not enough. */
  timeoutMs: 180_000,
} as const;

const decodeWithSuiSdk = async (bytes: Uint8Array): Promise<string> => {
  const { Transaction } = await import('@mysten/sui/transactions');
  return await Transaction.from(bytes).toJSON();
};

/**
 * Serves the page, waits for the wallet, and resolves with the signature.
 *
 * Resolves only through the nonce-checked POST; a timeout rejects, and the
 * server is closed on every path so a signer that was refused does not leave a
 * port open waiting for one.
 */
export const signInBrowser = async (options: SignOptions): Promise<string> => {
  const {
    request,
    chain = DEFAULTS.chain,
    timeoutMs = DEFAULTS.timeoutMs,
    openUrl,
    decodeTransaction = decodeWithSuiSdk,
    onDiagnostic,
  } = options;

  const transactionJson =
    request.type === 'TRANSACTION'
      ? await decodeTransaction(Buffer.from(request.transactionBytesBase64, 'base64'))
      : undefined;

  const nonce = randomBytes(16).toString('hex');
  const page = buildPage({
    request,
    nonce,
    chain,
    ...(transactionJson === undefined ? {} : { transactionJson }),
  });

  let settle!: { resolve: (value: string) => void; reject: (error: Error) => void };
  const signature = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });

  const server: Server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }
    if (req.method === 'POST' && req.url === '/done') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const parsed = body as { nonce?: unknown; signature?: unknown };
          if (parsed.nonce !== nonce) {
            res.writeHead(403).end('bad nonce');
            return;
          }
          if (typeof parsed.signature !== 'string' || parsed.signature === '') {
            res.writeHead(400).end('no signature');
            return;
          }
          res.writeHead(200).end('ok');
          settle.resolve(parsed.signature);
        } catch {
          res.writeHead(400).end('bad body');
        }
      });
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new SignerRefusal('could not bind a loopback port');
  }
  const url = `http://127.0.0.1:${String(address.port)}/`;
  onDiagnostic?.(`waiting for a wallet signature at ${url}`);
  openUrl?.(url);

  const timer = setTimeout(
    () => settle.reject(new SignerRefusal(`no signature within ${String(timeoutMs)}ms`)),
    timeoutMs,
  );
  timer.unref?.();
  try {
    return await signature;
  } finally {
    clearTimeout(timer);
    server.close();
  }
};
