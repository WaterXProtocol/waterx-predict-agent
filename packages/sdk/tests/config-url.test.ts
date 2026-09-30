/**
 * `WATERX_CONFIG_URL`: a CDN ROOT, `${root}/${network}.json` appended, and
 * every other shape refused with the fix in the message.
 */
import { describe, expect, it } from 'vitest';

import {
  assertNoRetiredWaterxConfigUrlEnv,
  normalizeWaterxConfigRoot,
  PredictDirectClient,
  RETIRED_WATERX_CONFIG_URL_ENV,
  WATERX_CONFIG_URLS,
  waterxConfigDocumentUrl,
  WaterxConfigUrlError,
} from '../src/index.ts';

describe('waterxConfigDocumentUrl', () => {
  it('appends the network document to a root, on both networks', () => {
    expect(waterxConfigDocumentUrl('mainnet', 'https://main-v2.waterx-config.pages.dev')).toBe(
      'https://main-v2.waterx-config.pages.dev/mainnet.json',
    );
    expect(waterxConfigDocumentUrl('testnet', 'https://staging-v2.waterx-config.pages.dev')).toBe(
      'https://staging-v2.waterx-config.pages.dev/testnet.json',
    );
  });

  it('strips trailing slashes and surrounding space', () => {
    expect(waterxConfigDocumentUrl('mainnet', ' https://config.waterx.app// ')).toBe('https://config.waterx.app/mainnet.json');
    expect(normalizeWaterxConfigRoot('https://cdn.example.com/v2/')).toBe('https://cdn.example.com/v2');
  });

  it('defaults to the per-network v2 root when unset or empty', () => {
    expect(WATERX_CONFIG_URLS).toEqual({
      mainnet: 'https://main-v2.waterx-config.pages.dev',
      testnet: 'https://staging-v2.waterx-config.pages.dev',
    });
    expect(waterxConfigDocumentUrl('mainnet')).toBe('https://main-v2.waterx-config.pages.dev/mainnet.json');
    expect(waterxConfigDocumentUrl('testnet', '  ')).toBe('https://staging-v2.waterx-config.pages.dev/testnet.json');
  });

  it('refuses a document URL rather than rewriting it', () => {
    for (const raw of [
      'https://main-v2.waterx-config.pages.dev/mainnet.json',
      'https://main-v2.waterx-config.pages.dev/mainnet.json/',
      'https://main-v2.waterx-config.pages.dev/MAINNET.JSON',
    ]) {
      expect(() => waterxConfigDocumentUrl('mainnet', raw)).toThrow(WaterxConfigUrlError);
      expect(() => waterxConfigDocumentUrl('mainnet', raw)).toThrow(
        /WATERX_CONFIG_URL must be a CDN ROOT with no filename — got ".*"\. Set it to e\.g\. https:\/\/main-v2\.waterx-config\.pages\.dev; <network>\.json is appended\./u,
      );
    }
  });

  it('refuses GitHub hosts', () => {
    expect(() => normalizeWaterxConfigRoot('https://raw.githubusercontent.com/WaterXProtocol/waterx-config/main')).toThrow(
      /must not point at raw\.githubusercontent\.com/u,
    );
    expect(() => normalizeWaterxConfigRoot('https://github.com/WaterXProtocol/waterx-config')).toThrow(/must not point at github\.com/u);
  });

  it('refuses non-https, except a loopback stub', () => {
    expect(() => normalizeWaterxConfigRoot('http://main-v2.waterx-config.pages.dev')).toThrow(/must be an https:\/\/ URL/u);
    expect(() => normalizeWaterxConfigRoot('ftp://cdn.example.com')).toThrow(/must be an https:\/\/ URL/u);
    expect(normalizeWaterxConfigRoot('http://127.0.0.1:8787/')).toBe('http://127.0.0.1:8787');
  });

  it('refuses an unparsable value, a query and a fragment', () => {
    expect(() => normalizeWaterxConfigRoot('main-v2.waterx-config.pages.dev')).toThrow(/WATERX_CONFIG_URL is not a URL/u);
    expect(() => normalizeWaterxConfigRoot('https://cdn.example.com/?ref=main')).toThrow(/no query or fragment/u);
    expect(() => normalizeWaterxConfigRoot('https://cdn.example.com/#x')).toThrow(/no query or fragment/u);
  });
});

describe('retired names', () => {
  it('refuses every retired environment name when set, naming WATERX_CONFIG_URL', () => {
    expect(RETIRED_WATERX_CONFIG_URL_ENV).toContain('WATERX_PREDICT_DEPLOYMENT_URL');
    expect(RETIRED_WATERX_CONFIG_URL_ENV).toContain('PREDICT_CONFIG_URL');
    for (const name of RETIRED_WATERX_CONFIG_URL_ENV) {
      expect(() => assertNoRetiredWaterxConfigUrlEnv({ [name]: 'https://x.example/mainnet.json' })).toThrow(
        new RegExp(`${name} is retired; use WATERX_CONFIG_URL, set to a CDN ROOT`, 'u'),
      );
    }
    expect(() => assertNoRetiredWaterxConfigUrlEnv({ PREDICT_CONFIG_URL: '', WATERX_CONFIG_URL: 'https://x.example' })).not.toThrow();
  });

  it('refuses the retired `deploymentUrl` client option', () => {
    expect(
      () =>
        new PredictDirectClient({
          baseUrl: 'https://waterx.test.invalid',
          network: 'mainnet',
          signer: {},
          deploymentUrl: 'https://main-v2.waterx-config.pages.dev/mainnet.json',
        } as never),
    ).toThrow(/`deploymentUrl` is retired; pass `waterxConfigUrl`/u);
  });
});
