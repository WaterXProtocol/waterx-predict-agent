/**
 * A key that signs while nobody is watching, and the refusals that make that
 * survivable.
 *
 * The reason this package exists is that `delegated-auto` has no other provider:
 * a trigger fires at 03:00 and there is no wallet dialog to press. So the key is
 * decrypted, in memory, for as long as the agent runs — and every assertion below
 * is about bounding what that costs. Wrong token, wrong address, wrong
 * passphrase, altered file: each is a refusal, and none of them is a signature.
 */
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { answer, createAgentServer, type HeldKey } from '../src/agent.ts';
import { askAgent } from '../src/client.ts';
import { KeystoreError, openKeystore, sealKeystore } from '../src/keystore.ts';
import type { SignerRequest } from '../src/protocol.ts';

const ADDRESS = `0x${'a'.repeat(63)}1`;
const SECRET = Uint8Array.from(Array.from({ length: 32 }, (_, i) => i + 1));
const PASSPHRASE = 'correct horse battery';
/** scrypt at the shipped cost takes seconds; a test asserts behaviour, not cost. */
const FAST = { name: 'scrypt', N: 2 ** 12, r: 8, p: 1 } as const;

const held = (over: Partial<HeldKey> = {}): HeldKey => ({
  address: ADDRESS,
  signPersonalMessage: vi.fn(async () => ({ signature: 'sig-personal' })),
  signTransaction: vi.fn(async () => ({ signature: 'sig-transaction' })),
  ...over,
});

const personal: SignerRequest = {
  version: 1,
  type: 'PERSONAL_MESSAGE',
  agentWallet: ADDRESS,
  messageBase64: Buffer.from('challenge').toString('base64'),
};
const transaction: SignerRequest = {
  version: 1,
  type: 'TRANSACTION',
  agentWallet: ADDRESS,
  transactionBytesBase64: Buffer.from([9, 9, 9]).toString('base64'),
};

describe('the keystore file', () => {
  it('gives the key back to the right passphrase', () => {
    const file = sealKeystore({ secretKey: SECRET, address: ADDRESS, passphrase: PASSPHRASE, kdf: FAST });
    expect(file.address).toBe(ADDRESS);
    expect(Buffer.from(openKeystore(file, PASSPHRASE))).toEqual(Buffer.from(SECRET));
    // The secret is not sitting in the document in any readable form.
    expect(JSON.stringify(file)).not.toContain(Buffer.from(SECRET).toString('base64'));
  });

  it('answers a wrong passphrase and an altered file identically', () => {
    const file = sealKeystore({ secretKey: SECRET, address: ADDRESS, passphrase: PASSPHRASE, kdf: FAST });
    const wrong = (): void => void openKeystore(file, 'not the passphrase');
    const altered = (): void =>
      void openKeystore({ ...file, cipherBase64: Buffer.from('tampered').toString('base64') }, PASSPHRASE);
    // Deliberately indistinguishable: a format that could tell them apart would
    // tell an attacker when they had guessed everything except the passphrase.
    expect(wrong).toThrow(/did not open/u);
    expect(altered).toThrow(/did not open/u);
  });

  it('refuses a version it was not built to read, by number', () => {
    const file = sealKeystore({ secretKey: SECRET, address: ADDRESS, passphrase: PASSPHRASE, kdf: FAST });
    expect(() => openKeystore({ ...file, version: 99 }, PASSPHRASE)).toThrow(/version 99/u);
  });

  it('refuses a passphrase too short to be one', () => {
    expect(() => sealKeystore({ secretKey: SECRET, address: ADDRESS, passphrase: 'short', kdf: FAST })).toThrow(
      KeystoreError,
    );
  });
});

describe('what the agent refuses', () => {
  it('signs nothing for a caller without the token', async () => {
    const key = held();
    const reply = await answer({ token: 'wrong', request: personal }, { key, token: 'right' });
    expect(reply).toEqual({ error: 'UNAUTHENTICATED' });
    expect(key.signPersonalMessage).not.toHaveBeenCalled();
    expect(key.signTransaction).not.toHaveBeenCalled();
  });

  it('signs nothing for an address it does not hold, and names both', async () => {
    const key = held();
    const reply = await answer(
      { token: 't', request: { ...personal, agentWallet: `0x${'b'.repeat(63)}2` } },
      { key, token: 't' },
    );
    expect(reply).toHaveProperty('error');
    // An operator who pointed the Runner at the wrong keystore needs to see
    // which key is loaded, not "signing failed".
    expect((reply as { error: string }).error).toContain(ADDRESS);
    expect(key.signPersonalMessage).not.toHaveBeenCalled();
  });

  it('treats zero-padding as the same address', async () => {
    const key = held({ address: '0x0abc' });
    const reply = await answer(
      { token: 't', request: { ...personal, agentWallet: '0xabc' } },
      { key, token: 't' },
    );
    expect(reply).toHaveProperty('signature');
  });

  it('refuses a malformed request by name rather than signing something', async () => {
    const key = held();
    const reply = await answer({ token: 't', request: { version: 9, type: 'PERSONAL_MESSAGE' } }, { key, token: 't' });
    expect((reply as { error: string }).error).toMatch(/unsupported request version 9/u);
    expect(key.signPersonalMessage).not.toHaveBeenCalled();
  });
});

describe('what it signs', () => {
  it('uses the personal-message path for a challenge and the transaction path for an order', async () => {
    const key = held();
    await expect(answer({ token: 't', request: personal }, { key, token: 't' })).resolves.toEqual({
      signature: 'sig-personal',
    });
    await expect(answer({ token: 't', request: transaction }, { key, token: 't' })).resolves.toEqual({
      signature: 'sig-transaction',
    });
    // Sui's intent prefixes differ; a challenge signed as a transaction is a
    // well-formed signature over the wrong bytes.
    expect(key.signPersonalMessage).toHaveBeenCalledOnce();
    expect(key.signTransaction).toHaveBeenCalledOnce();
  });
});

describe('over a real socket', () => {
  let dir: string;
  let socketPath: string;
  const servers: { close(): void }[] = [];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'waterx-keystore-'));
    socketPath = join(dir, 'keystore.sock');
  });
  afterEach(() => {
    for (const server of servers.splice(0)) server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const listen = async (options: Parameters<typeof createAgentServer>[0]): Promise<void> => {
    const server = createAgentServer(options);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  };

  it('carries a signature from the client to the agent and back', async () => {
    await listen({ key: held(), token: 'tok' });
    await expect(askAgent({ socketPath, token: 'tok', request: transaction })).resolves.toBe('sig-transaction');
  });

  it('surfaces a refusal as a refusal, never as a signature', async () => {
    await listen({ key: held(), token: 'tok' });
    await expect(askAgent({ socketPath, token: 'nope', request: personal })).rejects.toThrow(/UNAUTHENTICATED/u);
  });

  it('says plainly when no agent is running', async () => {
    await expect(
      askAgent({ socketPath: join(dir, 'absent.sock'), token: 't', request: personal }),
    ).rejects.toThrow(/no keystore agent is listening/u);
  });

  it('gives up rather than hanging when the agent never answers', async () => {
    const stall = createAgentServer({ key: held(), token: 't' });
    // A server that accepts and says nothing: the shape a wedged agent has.
    const silent = (await import('node:net')).createServer(() => undefined);
    stall.close();
    servers.push(silent);
    await new Promise<void>((resolve) => silent.listen(socketPath, resolve));
    await expect(askAgent({ socketPath, token: 't', request: personal, timeoutMs: 150 })).rejects.toThrow(
      /did not answer within/u,
    );
  });

  it('binds a socket only this account can reach', async () => {
    await listen({ key: held(), token: 'tok' });
    // The agent binary chmods it; here we assert the path is in a private dir.
    // No platform escape hatch: POSIX mkdtemp creates 0700 everywhere, so an
    // `|| process.platform === 'darwin'` made this read `true === true` on every
    // machine it was ever run on by hand, and left the only real check to CI.
    expect(statSync(dir).mode & 0o077).toBe(0);
    writeFileSync(join(dir, 'probe'), 'x', { mode: 0o600 });
    expect(statSync(join(dir, 'probe')).mode & 0o077).toBe(0);
  });
});
