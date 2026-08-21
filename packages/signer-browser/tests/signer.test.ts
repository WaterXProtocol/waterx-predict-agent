/**
 * What this provider must refuse, and what it must never do.
 *
 * The interesting assertions are negative. A signer is judged by the requests it
 * turns down: an unknown protocol version, a wallet that does not hold the
 * address, a nonce from somewhere else, an empty signature. And by one thing it
 * never does — execute. A sponsored transaction needs the server's signature
 * too, so a provider that executed would either fail on chain or, worse, submit
 * something the caller intended to inspect first.
 */
import { describe, expect, it, vi } from 'vitest';

import { buildPage } from '../src/page.ts';
import { parseRequest, sameAddress, SIGNER_PROTOCOL, SignerRefusal } from '../src/protocol.ts';
import { signInBrowser } from '../src/sign.ts';

const WALLET = '0x7777777777777777777777777777777777777777777777777777777777777777';

const personal = {
  version: 1,
  type: 'PERSONAL_MESSAGE',
  agentWallet: WALLET,
  messageBase64: Buffer.from('Sign in to Bucket Agent', 'utf8').toString('base64'),
} as const;

const transaction = {
  version: 1,
  type: 'TRANSACTION',
  agentWallet: WALLET,
  transactionBytesBase64: Buffer.from([1, 2, 3]).toString('base64'),
} as const;

/** Runs the flow against a fake browser that does whatever the test says. */
const withPage = async (
  request: Parameters<typeof signInBrowser>[0]['request'],
  act: (url: string) => Promise<void>,
  extra: Partial<Parameters<typeof signInBrowser>[0]> = {},
): Promise<{ settled: Promise<string>; url: string }> => {
  let resolveUrl!: (value: string) => void;
  const urlSeen = new Promise<string>((resolve) => {
    resolveUrl = resolve;
  });
  const settled = signInBrowser({
    request,
    timeoutMs: 4_000,
    decodeTransaction: async () => '{"fake":"tx"}',
    openUrl: (url) => {
      resolveUrl(url);
      void act(url);
    },
    ...extra,
  });
  return { settled, url: await urlSeen };
};

describe('parsing a request', () => {
  it('refuses a version it was not built to understand, by number', () => {
    expect(() => parseRequest(JSON.stringify({ ...personal, version: 2 }))).toThrow(
      /unsupported request version 2/u,
    );
  });

  it('refuses non-JSON, an unknown type, and a missing wallet, each by name', () => {
    expect(() => parseRequest('not json')).toThrow(/not JSON/u);
    expect(() => parseRequest(JSON.stringify({ ...personal, type: 'SOMETHING' }))).toThrow(
      /unknown request type SOMETHING/u,
    );
    expect(() => parseRequest(JSON.stringify({ ...personal, agentWallet: '' }))).toThrow(
      /named no agentWallet/u,
    );
  });

  it('refuses a request whose payload does not match its own type', () => {
    // The discriminator is the point: a TRANSACTION carrying a personal message
    // would be a key holder signing one thing while told it signed another.
    expect(() =>
      parseRequest(JSON.stringify({ ...transaction, transactionBytesBase64: undefined })),
    ).toThrow(/no transactionBytesBase64/u);
    expect(() =>
      parseRequest(JSON.stringify({ ...personal, messageBase64: undefined })),
    ).toThrow(/no messageBase64/u);
  });

  it('accepts both shapes the protocol declares', () => {
    expect(parseRequest(JSON.stringify(personal)).type).toBe('PERSONAL_MESSAGE');
    expect(parseRequest(JSON.stringify(transaction)).type).toBe('TRANSACTION');
    expect(SIGNER_PROTOCOL.requests.map((r) => r.type)).toEqual([
      'PERSONAL_MESSAGE',
      'TRANSACTION',
    ]);
  });

  it('treats zero-padding as the same address, and a different address as different', () => {
    expect(sameAddress('0x00ab', '0xab')).toBe(true);
    expect(sameAddress('0xAB', '0xab')).toBe(true);
    expect(sameAddress('0xab', '0xac')).toBe(false);
  });
});

describe('the page', () => {
  it('asks for the feature the request actually needs', () => {
    const login = buildPage({ request: personal, nonce: 'n', chain: 'sui:testnet' });
    const write = buildPage({
      request: transaction,
      nonce: 'n',
      chain: 'sui:testnet',
      transactionJson: '{"kind":"ProgrammableTransaction"}',
    });
    expect(login).toContain('sui:signPersonalMessage');
    expect(write).toContain('sui:signTransaction');
    expect(write).toContain('ProgrammableTransaction');
  });

  it('never executes a transaction, only signs it', () => {
    const write = buildPage({
      request: transaction,
      nonce: 'n',
      chain: 'sui:testnet',
      transactionJson: '{}',
    });
    // A sponsored transaction needs the server's signature too. Executing here
    // would fail on chain — and on the chain where it did not fail, it would
    // have submitted something the caller meant to inspect first.
    expect(write).not.toContain('signAndExecuteTransaction');
    expect(write).not.toContain('executeTransactionBlock');
  });

  it('carries the nonce and the wallet, and escapes what it injects', () => {
    const page = buildPage({
      request: { ...personal, agentWallet: '0x</script><script>evil()' },
      nonce: 'abc123',
      chain: 'sui:testnet',
    });
    expect(page).toContain('abc123');
    expect(page).not.toContain('<script>evil()');
  });
});

describe('the round trip', () => {
  it('returns the signature the wallet posted back', async () => {
    const { settled } = await withPage(personal, async (url) => {
      await fetch(`${url}done`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce: pageNonce(await (await fetch(url)).text()), signature: 'sig-ok' }),
      });
    });
    await expect(settled).resolves.toBe('sig-ok');
  });

  it('refuses a nonce from anywhere else, and keeps waiting', async () => {
    const posted = vi.fn();
    const { settled } = await withPage(
      personal,
      async (url) => {
        const bad = await fetch(`${url}done`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ nonce: 'not-the-nonce', signature: 'sig-evil' }),
        });
        posted(bad.status);
        // Another page on this machine must not be able to answer for the wallet.
        const good = pageNonce(await (await fetch(url)).text());
        await fetch(`${url}done`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ nonce: good, signature: 'sig-real' }),
        });
      },
      {},
    );
    await expect(settled).resolves.toBe('sig-real');
    expect(posted).toHaveBeenCalledWith(403);
  });

  it('refuses an empty signature rather than returning one', async () => {
    const codes: number[] = [];
    const { settled } = await withPage(personal, async (url) => {
      const nonce = pageNonce(await (await fetch(url)).text());
      codes.push(
        (
          await fetch(`${url}done`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ nonce, signature: '' }),
          })
        ).status,
      );
      await fetch(`${url}done`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce, signature: 'sig-after' }),
      });
    });
    await expect(settled).resolves.toBe('sig-after');
    expect(codes).toEqual([400]);
  });

  it('decodes a transaction before showing it, and gives up when nobody answers', async () => {
    const decode = vi.fn(async () => '{"decoded":true}');
    const { settled, url } = await withPage(transaction, async () => undefined, {
      timeoutMs: 300,
      decodeTransaction: decode,
    });
    // Embedded as a JS string literal, so the quotes inside it are escaped —
    // which is exactly what keeps a decoded transaction from closing the script.
    expect(await (await fetch(url)).text()).toContain('decoded');
    await expect(settled).rejects.toBeInstanceOf(SignerRefusal);
    expect(decode).toHaveBeenCalledOnce();
  });

  it('binds loopback only', async () => {
    const { settled, url } = await withPage(personal, async () => undefined, { timeoutMs: 200 });
    expect(url.startsWith('http://127.0.0.1:')).toBe(true);
    await expect(settled).rejects.toThrow(/no signature within/u);
  });
});

/** The nonce is a page literal; a test reads it the way the page would use it. */
const pageNonce = (html: string): string => {
  const match = /const NONCE="([0-9a-f]+)"/u.exec(html);
  if (match?.[1] === undefined) throw new Error('no nonce in page');
  return match[1];
};
