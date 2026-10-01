/**
 * `WATERX_CONFIG_URL` at config load: a CDN ROOT, validated before any command
 * runs, and every retired name for it refused rather than ignored.
 */
import { describe, expect, it } from 'vitest';

import { CliError, loadConfig } from '../src/index.ts';
import { CONFIGURED_ENV, invoke } from './harness.ts';

const load = (env: Record<string, string>, file?: Record<string, unknown>) =>
  loadConfig({
    env,
    readFile: (path) => (file !== undefined && path === '/cfg.json' ? JSON.stringify(file) : null),
    homeDir: () => null,
    ...(file === undefined ? {} : { explicitPath: '/cfg.json' }),
  });

const refusal = (fn: () => unknown): CliError => {
  try {
    fn();
  } catch (error: unknown) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('WATERX_CONFIG_URL', () => {
  it('is unset by default: the SDK picks the network root', () => {
    expect(load({}).waterxConfigUrl).toBeUndefined();
  });

  it('takes a root from the environment or the file, trailing slash stripped', () => {
    expect(load({ WATERX_CONFIG_URL: 'https://staging-v2.waterx-config.pages.dev/' }).waterxConfigUrl).toBe(
      'https://staging-v2.waterx-config.pages.dev',
    );
    expect(load({}, { waterxConfigUrl: 'https://main-v2.waterx-config.pages.dev' }).waterxConfigUrl).toBe(
      'https://main-v2.waterx-config.pages.dev',
    );
  });

  it('refuses an invalid root at load as CONFIG_INVALID, naming the variable', () => {
    // The URL rules themselves are the SDK's and tested there; this is the mapping.
    const error = refusal(() => load({ WATERX_CONFIG_URL: 'https://main-v2.waterx-config.pages.dev/mainnet.json' }));
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toMatch(/WATERX_CONFIG_URL/u);
  });

  it('names the file key, not the variable, when the bad root came from the file', () => {
    const error = refusal(() => load({}, { waterxConfigUrl: 'https://main-v2.waterx-config.pages.dev/mainnet.json' }));
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toMatch(/^`waterxConfigUrl` in \/cfg\.json must be a CDN ROOT/u);
    expect(error.details).toEqual({ file: '/cfg.json', key: 'waterxConfigUrl' });
  });

  it('is not read in agent-api mode, where the backend reads the document', () => {
    const config = load({ WATERX_PREDICT_MODE: 'agent-api', CONFIG_URL: 'https://x.example/app.json', WATERX_CONFIG_URL: 'https://x.example/mainnet.json' });
    expect(config.waterxConfigUrl).toBeUndefined();
  });

  it('refuses the retired environment names instead of ignoring them', () => {
    for (const name of ['WATERX_PREDICT_DEPLOYMENT_URL', 'PREDICT_CONFIG_URL']) {
      const error = refusal(() => load({ [name]: 'https://main-v2.waterx-config.pages.dev/mainnet.json' }));
      expect(error.code).toBe('CONFIG_INVALID');
      expect(error.message).toMatch(new RegExp(`${name} is retired; use WATERX_CONFIG_URL`, 'u'));
      expect(error.details).toEqual({ key: name });
    }
  });

  it('refuses the retired `deploymentUrl` config key, naming the replacement', () => {
    const error = refusal(() => load({}, { deploymentUrl: 'https://main-v2.waterx-config.pages.dev/mainnet.json' }));
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toMatch(/`deploymentUrl` in \/cfg\.json is retired; use `waterxConfigUrl` \(or WATERX_CONFIG_URL\), set to a CDN ROOT/u);
  });

  it('never echoes a credential carried by a refused root — not in the message, details or any stream', async () => {
    const SECRET = 'SUPERSECRET';
    const direct = { ...CONFIGURED_ENV, WATERX_PREDICT_MODE: 'direct', WATERX_PREDICT_NETWORK: 'mainnet' };
    for (const raw of [
      `https://cdn.example.com/private?token=${SECRET}`,
      `https://user:${SECRET}@cdn.example.com`,
      `https://cdn.example.com/v2#${SECRET}`,
      `cdn.example.com/?token=${SECRET}`,
    ]) {
      const result = await invoke(['describe'], { env: { ...direct, WATERX_CONFIG_URL: raw } });
      expect(result.envelope.error?.code, raw).toBe('CONFIG_INVALID');
      expect(result.envelope.error?.message, raw).toMatch(/^WATERX_CONFIG_URL /u);
      expect(result.stdout, raw).not.toContain(SECRET);
      expect(result.stderr, raw).not.toContain(SECRET);
    }
    // The same from the config file, and under a retired name.
    const fromFile = refusal(() => load({}, { waterxConfigUrl: `https://u:${SECRET}@cdn.example.com/?t=${SECRET}` }));
    expect(fromFile.message).not.toContain(SECRET);
    expect(JSON.stringify(fromFile.details)).not.toContain(SECRET);
    const retired = refusal(() => load({ PREDICT_CONFIG_URL: `https://cdn.example.com/?token=${SECRET}` }));
    expect(retired.message).not.toContain(SECRET);
  });
});
