/**
 * `WATERX_CONFIG_URL` at config load: a CDN ROOT, validated before any command
 * runs, and every retired name for it refused rather than ignored.
 */
import { describe, expect, it } from 'vitest';

import { CliError, loadConfig } from '../src/index.ts';

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

  it('refuses the retired environment names instead of ignoring them', () => {
    for (const name of ['WATERX_PREDICT_DEPLOYMENT_URL', 'PREDICT_CONFIG_URL']) {
      const error = refusal(() => load({ [name]: 'https://main-v2.waterx-config.pages.dev/mainnet.json' }));
      expect(error.code).toBe('CONFIG_INVALID');
      expect(error.message).toMatch(new RegExp(`${name} is retired; use WATERX_CONFIG_URL`, 'u'));
    }
  });

  it('refuses the retired `deploymentUrl` config key, naming the replacement', () => {
    const error = refusal(() => load({}, { deploymentUrl: 'https://main-v2.waterx-config.pages.dev/mainnet.json' }));
    expect(error.code).toBe('CONFIG_INVALID');
    expect(error.message).toMatch(/`deploymentUrl` in \/cfg\.json is retired\. Use `waterxConfigUrl` \(or WATERX_CONFIG_URL\)/u);
  });
});
