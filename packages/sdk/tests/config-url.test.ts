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
import { redactWaterxConfigUrl } from '../src/direct/config-url.ts';

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

/**
 * Values the SDK helper ACCEPTS and this package REFUSES, on purpose: a root
 * carrying a username or password. A public CDN root never carries credentials,
 * so one that does is a mistake (or a secret pasted into the wrong variable) —
 * refused here, as keeper #129 and quote-center #213 refuse it.
 * `waterxConfigUrlFromRoot` instead accepts it and silently drops the userinfo
 * from the URL it builds, and, like this package before, echoes the raw value
 * (credentials, query, fragment) in its own refusals. Both need a follow-up in
 * `@waterx/sdk`; until then this list holds the divergence explicitly, so a
 * change on either side shows up here.
 */
const USERINFO = [
  'https://user:pass@cdn.example.com',
  'https://token@cdn.example.com/v2',
  'https://:pass@main-v2.waterx-config.pages.dev/',
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

  it('refuses a root with a username or password — a deliberate divergence: the SDK helper accepts it', () => {
    for (const raw of USERINFO) {
      expect(verdict(() => waterxConfigUrlFromRoot(raw, 'mainnet')), raw).not.toBe('REFUSED');
      expect(() => normalizeWaterxConfigRoot(raw), raw).toThrow(/must not carry a username or password/u);
      expect(verdict(() => waterxConfigDocumentUrl('mainnet', raw)), raw).toBe('REFUSED');
    }
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

describe('a refusal never echoes a credential', () => {
  const SECRET = 'SUPERSECRET';
  const message = (raw: string, setting?: string): string => {
    try {
      normalizeWaterxConfigRoot(raw, setting);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(WaterxConfigUrlError);
      return (error as Error).message;
    }
    throw new Error(`expected ${raw} to be refused`);
  };

  it('shows a query-token URL without its query', () => {
    const text = message(`https://cdn.example.com/private?token=${SECRET}`);
    expect(text).not.toContain(SECRET);
    expect(text).toMatch(/no query or fragment — got "https:\/\/cdn\.example\.com\/private"/u);
  });

  it('shows a user:pass@ URL without its userinfo', () => {
    for (const raw of [`https://user:${SECRET}@cdn.example.com`, `https://${SECRET}@cdn.example.com/x`, `https://user:${SECRET}@cdn.example.com/mainnet.json?k=${SECRET}`]) {
      const text = message(raw);
      expect(text, raw).not.toContain(SECRET);
      expect(text, raw).toMatch(/must not carry a username or password \(a public CDN root never does\) — got "https:\/\/cdn\.example\.com\//u);
    }
  });

  it('shows a fragment URL without its fragment', () => {
    const text = message(`https://cdn.example.com/v2#access_token=${SECRET}`);
    expect(text).not.toContain(SECRET);
    expect(text).toContain('got "https://cdn.example.com/v2"');
  });

  it('shows nothing of a value that does not parse as a URL', () => {
    for (const raw of [`cdn.example.com/?token=${SECRET}`, `${SECRET}`, `https://exa mple.com/${SECRET}`]) {
      const text = message(raw);
      expect(text, raw).not.toContain(SECRET);
      expect(text, raw).not.toContain('got');
      expect(text, raw).toMatch(/^WATERX_CONFIG_URL is not a URL\. Set it to a CDN ROOT/u);
    }
  });

  it('strips them on every other refusal too — scheme, GitHub, filename', () => {
    for (const raw of [
      `http://user:${SECRET}@cdn.example.com/?t=${SECRET}`,
      `ftp://${SECRET}@cdn.example.com/#${SECRET}`,
      `https://raw.githubusercontent.com/x/y/main?token=${SECRET}`,
      `https://cdn.example.com/mainnet.json?sig=${SECRET}#${SECRET}`,
      `mailto:${SECRET}@example.com`,
    ]) {
      expect(message(raw, 'X'), raw).not.toContain(SECRET);
    }
  });

  it('reaches the client and the deployment reader unchanged', () => {
    const raw = `https://user:${SECRET}@cdn.example.com/?token=${SECRET}#${SECRET}`;
    const build = (): unknown =>
      new PredictDirectClient({ baseUrl: 'https://waterx.test.invalid', network: 'mainnet', signer: {}, waterxConfigUrl: raw } as never);
    const caught = (fn: () => unknown): string => {
      try {
        fn();
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(WaterxConfigUrlError);
        return (error as Error).message;
      }
      throw new Error('expected a refusal');
    };
    expect(caught(build)).toMatch(/^WATERX_CONFIG_URL must not carry a username or password/u);
    expect(caught(build)).not.toContain(SECRET);
    // Nor does a retired name echo the value it was set to.
    const retired = caught(() => assertNoRetiredWaterxConfigUrlEnv({ PREDICT_CONFIG_URL: raw }));
    expect(retired).toMatch(/PREDICT_CONFIG_URL is retired/u);
    expect(retired).not.toContain(SECRET);
  });

  it('redactWaterxConfigUrl keeps scheme, host, port and path only', () => {
    expect(redactWaterxConfigUrl(`https://u:${SECRET}@CDN.example.com:8443/a/b?x=${SECRET}#${SECRET}`)).toBe('https://cdn.example.com:8443/a/b');
    expect(redactWaterxConfigUrl('file:///tmp/config')).toBe('file:///tmp/config');
    expect(redactWaterxConfigUrl(`mailto:${SECRET}@example.com`)).toBeUndefined();
    expect(redactWaterxConfigUrl(`not a url ${SECRET}`)).toBeUndefined();
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

  it('refuses the retired `deploymentUrl` client option, as a setup error naming it', () => {
    const build = (): unknown =>
      new PredictDirectClient({
        baseUrl: 'https://waterx.test.invalid',
        network: 'mainnet',
        signer: {},
        deploymentUrl: 'https://main-v2.waterx-config.pages.dev/mainnet.json',
      } as never);
    expect(build).toThrow(/`deploymentUrl` is retired; use `waterxConfigUrl`, set to a CDN ROOT/u);
    expect(build).toThrow(expect.objectContaining({ name: 'WaterxConfigUrlError', setting: 'deploymentUrl' }));
  });
});
