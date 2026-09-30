/**
 * The deployment reader, offline: the consolidated `schema_version: 2`
 * waterx-config is the only shape it reads, and everything else is refused
 * with the fix in the message rather than read half-right.
 */
import { describe, expect, it } from 'vitest';

import {
  DirectDeploymentError,
  FetchedDeployment,
  parseDeployment,
  WATERX_CONFIG_SCHEMA_VERSION,
  WATERX_CONFIG_URLS,
} from '../src/direct/deployment.ts';
import { normalizeSuiAddress } from '../src/sui-tx.ts';
import { CONFIG } from './direct-fixtures.ts';

const objects = CONFIG['objects'] as Record<string, Record<string, any>>;
const packages = CONFIG['packages'] as Record<string, Record<string, string>>;

/** The same document in the legacy per-package shape: ids beside `published_at`, no `schema_version`. */
function legacyShape(): Record<string, unknown> {
  const { schema_version: _schema, objects: _objects, ...rest } = CONFIG;
  return {
    ...rest,
    packages: {
      ...packages,
      waterx_prediction: { ...packages['waterx_prediction'], ...objects['prediction'] },
      waterx_account: { ...packages['waterx_account'], account_registry: objects['account']!['registry'] },
    },
  };
}

describe('parseDeployment reads the v2 document', () => {
  it('takes object ids from `objects.*` and package identity from `packages.*`', () => {
    const deployment = parseDeployment(CONFIG, 'mainnet');
    expect(deployment.objects.marketRegistry).toBe(normalizeSuiAddress(objects['prediction']!['market_registries'].USD));
    expect(deployment.objects.predictionGlobalConfig).toBe(normalizeSuiAddress(objects['prediction']!['global_config']));
    expect(deployment.objects.accountRegistry).toBe(normalizeSuiAddress(objects['account']!['registry']));
    expect(deployment.objects.custodyVault).toBe(normalizeSuiAddress(objects['custody']!['vault']));
    expect(deployment.objects.creditRegistry).toBe(normalizeSuiAddress(objects['credit']!['registry']));
    expect(deployment.settlementCoin).toEqual({
      address: normalizeSuiAddress(objects['prediction']!['settlement_coin_types'].USD.split('::')[0]),
      module: 'usd',
      name: 'USD',
    });
    expect(deployment.callable.prediction).toBe(normalizeSuiAddress(packages['waterx_prediction']!['published_at']!));
    expect(deployment.originals.prediction).toBe(normalizeSuiAddress(packages['waterx_prediction']!['original_id']!));
    expect(deployment.packageNames.get(deployment.originals.account)).toBe('waterx_account');
  });

  it('refuses the legacy per-package shape, naming the v2 hosts', () => {
    expect(WATERX_CONFIG_SCHEMA_VERSION).toBe(2);
    expect(() => parseDeployment(legacyShape(), 'mainnet')).toThrow(DirectDeploymentError);
    expect(() => parseDeployment(legacyShape(), 'mainnet')).toThrow(/no `schema_version`.*schema_version 2.*main-v2\.waterx-config\.pages\.dev/su);
  });

  it('refuses any other schema version, before reading the network', () => {
    expect(() => parseDeployment({ ...CONFIG, schema_version: 3 }, 'mainnet')).toThrow(/`schema_version` 3/u);
    expect(() => parseDeployment({ ...CONFIG, schema_version: '2' }, 'mainnet')).toThrow(/`schema_version` "2"/u);
    expect(() => parseDeployment({ ...CONFIG, schema_version: 1, network: 'testnet' }, 'mainnet')).toThrow(/`schema_version` 1/u);
  });

  it('still refuses a document for the other network', () => {
    expect(() => parseDeployment(CONFIG, 'testnet')).toThrow(/describes `mainnet`, not `testnet`/u);
  });

  it('names the missing v2 field when one is absent', () => {
    const { prediction: _prediction, ...rest } = objects;
    expect(() => parseDeployment({ ...CONFIG, objects: rest }, 'mainnet')).toThrow(/`objects\.prediction`/u);
    expect(() =>
      parseDeployment({ ...CONFIG, objects: { ...objects, prediction: { ...objects['prediction'], market_registries: {} } } }, 'mainnet'),
    ).toThrow(/`objects\.prediction\.market_registries\.USD`/u);
  });
});

describe('FetchedDeployment', () => {
  it('defaults to the v2 roots and names the URL when the document is refused', async () => {
    expect(WATERX_CONFIG_URLS.mainnet).toBe('https://main-v2.waterx-config.pages.dev');
    expect(WATERX_CONFIG_URLS.testnet).toBe('https://staging-v2.waterx-config.pages.dev');
    const requested: string[] = [];
    const fetch = (async (input: URL | string | Request) => {
      requested.push(String(input));
      return new Response(JSON.stringify(legacyShape()), { status: 200 });
    }) as typeof globalThis.fetch;
    const source = new FetchedDeployment({ network: 'mainnet', fetch });
    await expect(source.load()).rejects.toThrow(
      /the deployment config at https:\/\/main-v2\.waterx-config\.pages\.dev\/mainnet\.json: waterx-config has no `schema_version`/u,
    );
    expect(requested).toEqual([`${WATERX_CONFIG_URLS.mainnet}/mainnet.json`]);
  });

  it('reads `${WATERX_CONFIG_URL}/${network}.json` and refuses a document URL or the retired `url` up front', async () => {
    const requested: string[] = [];
    const fetch = (async (input: URL | string | Request) => {
      requested.push(String(input));
      return new Response(JSON.stringify({ ...CONFIG, network: 'testnet' }), { status: 200 });
    }) as typeof globalThis.fetch;
    await new FetchedDeployment({ network: 'testnet', waterxConfigUrl: 'https://cdn.example.com/', fetch }).load();
    expect(requested).toEqual(['https://cdn.example.com/testnet.json']);
    expect(() => new FetchedDeployment({ network: 'mainnet', waterxConfigUrl: 'https://cdn.example.com/mainnet.json' })).toThrow(
      /WATERX_CONFIG_URL must be a CDN ROOT with no filename/u,
    );
    expect(() => new FetchedDeployment({ network: 'mainnet', url: 'https://cdn.example.com/mainnet.json' } as never)).toThrow(
      /`url` is retired; pass `waterxConfigUrl`/u,
    );
  });

  it('loads a v2 document and caches it', async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify(CONFIG), { status: 200 });
    }) as typeof globalThis.fetch;
    const source = new FetchedDeployment({ network: 'mainnet', fetch, now: () => 0 });
    const first = await source.load();
    expect(first.objects.marketRegistry).toBe(normalizeSuiAddress(objects['prediction']!['market_registries'].USD));
    expect(await source.load()).toBe(first);
    expect(calls).toBe(1);
  });
});
