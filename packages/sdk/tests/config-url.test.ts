/**
 * `WATERX_CONFIG_URL`: a CDN ROOT, `${root}/${network}.json` appended, and
 * every other shape refused with the fix in the message.
 *
 * The URL rules are the fleet's, implemented once in `@waterx/sdk`'s
 * `waterxConfigUrlFromRoot`. This package restates them rather than importing
 * it at runtime (see `src/direct/config-url.ts`), so the rules are tested here
 * as PARITY with that helper — same verdict, same URL — and only what is owned
 * locally (defaults, the loopback allowance, retired names, the error) is
 * asserted on its own.
 */
import { waterxConfigUrlFromRoot } from '@waterx/sdk/config';
import { describe, expect, it } from 'vitest';

import {
  assertNoRetiredWaterxConfigUrlEnv,
  type DirectNetwork,
  normalizeWaterxConfigRoot,
  PredictDirectClient,
  RETIRED_WATERX_CONFIG_URL_ENV,
  WATERX_CONFIG_URLS,
  waterxConfigDocumentUrl,
  WaterxConfigUrlError,
} from '../src/index.ts';

/** Every shape the standard names, accepted and refused. */
const CORPUS = [
  'https://main-v2.waterx-config.pages.dev',
  'https://staging-v2.waterx-config.pages.dev',
  ' https://config.waterx.app// ',
  'https://cdn.example.com/v2/',
  'https://CDN.Example.com:443/waterx/config',
  // the old full-document form, never rewritten
  'https://main-v2.waterx-config.pages.dev/mainnet.json',
  'https://main-v2.waterx-config.pages.dev/mainnet.json/',
  'https://main-v2.waterx-config.pages.dev/MAINNET.JSON',
  'https://main-v2.waterx-config.pages.dev/testnet.json?v=2',
  // GitHub
  'https://raw.githubusercontent.com/WaterXProtocol/waterx-config/main',
  'https://github.com/WaterXProtocol/waterx-config',
  'https://objects.githubusercontent.com/x',
  'https://notgithub.com',
  // non-https (a public host — loopback is the one local allowance, below)
  'http://main-v2.waterx-config.pages.dev',
  'ftp://cdn.example.com',
  'file:///tmp/config',
  // query / fragment / not a URL
  'https://cdn.example.com/?ref=main',
  'https://cdn.example.com/#x',
  'main-v2.waterx-config.pages.dev',
] as const;

const NETWORKS: readonly DirectNetwork[] = ['mainnet', 'testnet'];

const verdict = (compose: () => string): string => {
  try {
    return compose();
  } catch {
    return 'REFUSED';
  }
};

describe('waterxConfigDocumentUrl', () => {
  it('agrees with @waterx/sdk waterxConfigUrlFromRoot on every shape, both networks', () => {
    for (const network of NETWORKS) {
      for (const raw of CORPUS) {
        expect(verdict(() => waterxConfigDocumentUrl(network, raw)), `${network} ${raw}`).toBe(
          verdict(() => waterxConfigUrlFromRoot(raw, network)),
        );
      }
    }
    // And the corpus is not vacuous: it holds both outcomes.
    const outcomes = CORPUS.map((raw) => verdict(() => waterxConfigDocumentUrl('mainnet', raw)));
    expect(outcomes).toContain('https://main-v2.waterx-config.pages.dev/mainnet.json');
    expect(outcomes).toContain('REFUSED');
  });

  it('refuses with WaterxConfigUrlError, naming WATERX_CONFIG_URL and the fix', () => {
    expect(() => waterxConfigDocumentUrl('mainnet', 'https://main-v2.waterx-config.pages.dev/mainnet.json')).toThrow(
      /WATERX_CONFIG_URL must be a CDN ROOT with no filename — got ".*"\. Set it to a CDN ROOT with no filename \(e\.g\. https:\/\/main-v2\.waterx-config\.pages\.dev; <network>\.json is appended\)\./u,
    );
    expect(() => normalizeWaterxConfigRoot('https://github.com/WaterXProtocol/waterx-config')).toThrow(WaterxConfigUrlError);
    expect(() => normalizeWaterxConfigRoot('   ')).toThrow(/WATERX_CONFIG_URL is empty/u);
  });

  it('defaults to the per-network v2 root when unset or empty', () => {
    expect(WATERX_CONFIG_URLS).toEqual({
      mainnet: 'https://main-v2.waterx-config.pages.dev',
      testnet: 'https://staging-v2.waterx-config.pages.dev',
    });
    expect(waterxConfigDocumentUrl('mainnet')).toBe('https://main-v2.waterx-config.pages.dev/mainnet.json');
    expect(waterxConfigDocumentUrl('testnet', '  ')).toBe('https://staging-v2.waterx-config.pages.dev/testnet.json');
  });

  it('accepts plain http to a loopback host only — the local allowance the SDK helper does not make', () => {
    for (const raw of ['http://127.0.0.1:8787/', 'http://localhost:8787', 'http://[::1]:8787']) {
      expect(() => waterxConfigUrlFromRoot(raw, 'mainnet'), raw).toThrow(/must use https/u);
      expect(waterxConfigDocumentUrl('mainnet', raw), raw).toBe(`${raw.replace(/\/+$/u, '')}/mainnet.json`);
    }
    expect(() => normalizeWaterxConfigRoot('http://127.0.0.1.example.com')).toThrow(/must be an https:\/\/ URL/u);
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
    ).toThrow(/`deploymentUrl` is retired; use `waterxConfigUrl`, set to a CDN ROOT/u);
  });
});
