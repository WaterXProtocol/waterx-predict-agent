/**
 * `configure` — the only command that writes this machine's settings.
 *
 * Everything asserted here is a bound on that permission. It may write two
 * settings and no others; it may not overwrite what somebody already set unless
 * asked twice; it never opens the keystore; and when the environment will
 * shadow what it just wrote, it says so rather than reporting a success the next
 * invocation ignores (ADR-0020).
 */
import { describe, expect, it } from 'vitest';

import { invoke, type InvokeOptions } from './harness.ts';

const HOME = '/home/op';
const CONFIG = `${HOME}/.config/waterx-predict/config.json`;
const DIR = `${HOME}/.waterx/keystore`;
const ADDRESS = `0x${'b'.repeat(63)}7`;
const OTHER = `0x${'c'.repeat(63)}2`;
/** A sealed keystore, cipher and all: nothing but the address may ever come out. */
const KEYSTORE = {
  [`${DIR}/keystore.json`]: JSON.stringify({
    version: 1,
    address: ADDRESS,
    protection: 'SCRYPT_AES_GCM',
    cipherBase64: 'secret-bits',
  }),
};
const PLAIN_KEYSTORE = {
  [`${DIR}/keystore.json`]: JSON.stringify({
    version: 1,
    address: ADDRESS,
    protection: 'NONE',
    secretBase64: 'secret-bits',
  }),
};

const configure = async (argv: readonly string[], options: InvokeOptions = {}) =>
  await invoke(['configure', ...argv], { homeDir: HOME, env: {}, ...options });

interface Result {
  configFile: string;
  changes: { setting: string; status: string; value: unknown; why: string }[];
  settings: { agentWallet: string | null; signerCommand: string[] | null };
  keystoreProtection?: string;
  shadowedByEnvironment?: string[];
  warning?: string;
  notWritten: { settings: string[]; why: string };
}

describe('configure, the one command that writes settings', () => {
  it('takes both settings from the keystore, and writes them where they survive', async () => {
    const result = await configure(['--fromKeystore'], { files: KEYSTORE });
    expect(result.envelope.ok).toBe(true);
    const data = result.envelope.data as Result;

    expect(data.configFile).toBe(CONFIG);
    expect(data.settings).toEqual({
      agentWallet: ADDRESS,
      signerCommand: ['waterx-predict-keystore', 'sign'],
    });
    // Through the 0600 seam, and nowhere else.
    expect(result.secretWrites.map((write) => write.path)).toEqual([CONFIG]);
    expect(JSON.parse(result.secretWrites[0]?.contents ?? '{}')).toEqual({
      agentWallet: ADDRESS,
      signerCommand: ['waterx-predict-keystore', 'sign'],
    });
    // The sealed half of the keystore never reaches an output.
    expect(result.stdout).not.toContain('secret-bits');
    expect(result.stderr).not.toContain('secret-bits');
    // It is a local write and nothing else: no request, no signature.
    expect(result.fetches).toEqual([]);
    expect(result.signerRuns).toEqual([]);
  });

  it('names what it will not write, so nobody expects it to choose a network', async () => {
    const data = (await configure(['--fromKeystore'], { files: KEYSTORE })).envelope.data as Result;
    expect(data.notWritten.settings).toEqual(['environment', 'network', 'policy', 'defaultAccountId']);
    expect(data.notWritten.why).toMatch(/real funds/u);
  });

  it('keeps what somebody already set, until asked twice', async () => {
    const files = { ...KEYSTORE, [CONFIG]: JSON.stringify({ agentWallet: OTHER, environment: 'testnet' }) };
    const kept = (await configure(['--fromKeystore'], { files })).envelope.data as Result;
    expect(kept.changes.find((change) => change.setting === 'agentWallet')?.status).toBe('KEPT');
    expect(kept.settings.agentWallet).toBe(OTHER);

    const replaced = await configure(['--fromKeystore', '--replace'], { files });
    const data = replaced.envelope.data as Result;
    expect(data.settings.agentWallet).toBe(ADDRESS);
    // The settings it does not touch survive the rewrite.
    expect(JSON.parse(replaced.secretWrites[0]?.contents ?? '{}')).toMatchObject({ environment: 'testnet' });
  });

  it('writes nothing when the file already says exactly this', async () => {
    const files = {
      ...KEYSTORE,
      [CONFIG]: JSON.stringify({ agentWallet: ADDRESS, signerCommand: ['waterx-predict-keystore', 'sign'] }),
    };
    const result = await configure(['--fromKeystore'], { files });
    expect((result.envelope.data as Result).changes.every((change) => change.status === 'UNCHANGED')).toBe(true);
    expect(result.secretWrites).toEqual([]);
  });

  it('says so when a plaintext keystore is what it just pointed at', async () => {
    const data = (await configure(['--fromKeystore'], { files: PLAIN_KEYSTORE })).envelope.data as Result;
    expect(data.keystoreProtection).toBe('NONE');
    expect(data.warning).toMatch(/plaintext/u);
  });

  it('refuses to invent an address when there is no keystore', async () => {
    const result = await configure(['--fromKeystore']);
    expect(result.envelope.ok).toBe(false);
    expect(result.envelope.error?.code).toBe('NOT_CONFIGURED');
    expect(result.envelope.error?.message).toMatch(/No readable keystore/u);
    expect(result.secretWrites).toEqual([]);
  });

  it('refuses two answers to the same question', async () => {
    const result = await configure(['--fromKeystore', '--agentWallet', OTHER], { files: KEYSTORE });
    expect(result.envelope.error?.code).toBe('INVALID_INPUT');
    expect(result.secretWrites).toEqual([]);
  });

  it('takes an address for a signer that is not the keystore', async () => {
    const result = await configure(['--agentWallet', OTHER]);
    const data = result.envelope.data as Result;
    expect(data.settings).toEqual({ agentWallet: OTHER, signerCommand: null });
  });

  it('refuses anything that is not an address', async () => {
    const result = await configure(['--agentWallet', 'my-wallet']);
    expect(result.envelope.ok).toBe(false);
    expect(result.secretWrites).toEqual([]);
  });

  it('will not be used to set a network or an account', async () => {
    for (const flag of ['--environment', '--network', '--defaultAccountId']) {
      const result = await configure([flag, 'testnet']);
      expect(result.envelope.ok, flag).toBe(false);
      expect(result.envelope.error?.code, flag).toBe('USAGE');
    }
    // `--policy` is a global flag that can only NARROW what this invocation may
    // sign. It is not a field of this command, so it reaches nothing this
    // command writes — the configured policy stays the operator's.
    const narrowed = await configure(['--policy', 'read-only', '--agentWallet', OTHER]);
    expect(narrowed.envelope.ok).toBe(true);
    expect(JSON.parse(narrowed.secretWrites[0]?.contents ?? '{}')).toEqual({ agentWallet: OTHER });
  });

  it('warns when the environment will shadow what it just wrote', async () => {
    // The environment wins over the file, so a write that changes nothing about
    // the next invocation must not read as a success (see `config.ts`).
    const data = (
      await configure(['--fromKeystore'], {
        files: KEYSTORE,
        env: { WATERX_PREDICT_AGENT_WALLET: OTHER },
      })
    ).envelope.data as Result;
    expect(data.shadowedByEnvironment).toEqual(['agentWallet']);
  });

  it('refuses when this machine has nowhere to keep a config file', async () => {
    const result = await configure(['--agentWallet', OTHER], { homeDir: null });
    expect(result.envelope.ok).toBe(false);
    expect(result.envelope.error?.code).toBe('NOT_CONFIGURED');
  });
});
