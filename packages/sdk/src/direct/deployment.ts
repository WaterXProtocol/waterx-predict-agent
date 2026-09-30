/**
 * Which packages and shared objects a transaction may touch, from the
 * deployment's own published config.
 *
 * The verifier (`verify.ts`) refuses a call to any package that is not the
 * CURRENT `published_at` of the package it claims to be, and a shared object
 * whose id is not the one the deployment names for that role. Both lists come
 * from here, fetched from the same waterx-config document the backend builds
 * transactions from (`WATERX_CONFIG_URL` there).
 *
 * The document is the consolidated `schema_version: 2` shape
 * (`WaterXProtocol/waterx-config`, `schema/waterx-config.schema.json`): package
 * IDENTITY (`published_at`, `original_id`, `version`) stays under `packages.*`,
 * every shared-object id lives under `objects.<domain>.*`. The legacy
 * per-package shape (ids beside `published_at`, no `schema_version`) is refused
 * outright rather than read half-right: `@waterx/sdk` 6.0.0 — the builder the
 * backend uses — rejects it at `create()` too.
 *
 * Fetched rather than shipped: a package upgrade moves `published_at`, and a
 * pinned copy would refuse every order the day after one — or, worse, keep
 * accepting the superseded id.
 */
import { normalizeSuiAddress } from '../sui-tx.ts';

import { waterxConfigDocumentUrl, WATERX_CONFIG_URLS } from './config-url.ts';

export type DirectNetwork = 'mainnet' | 'testnet';

/** The schema this reader understands. Anything else is refused, not guessed at. */
export const WATERX_CONFIG_SCHEMA_VERSION = 2;

/**
 * Where the document is read: a `WATERX_CONFIG_URL` ROOT (default per network,
 * `main-v2` / `staging-v2`) with `${network}.json` appended. See `config-url.ts`.
 */
export { WATERX_CONFIG_URLS } from './config-url.ts';

/** Sui system objects every PTB may name. */
export const SUI_CLOCK = normalizeSuiAddress('0x6');
export const SUI_ACCUMULATOR_ROOT = normalizeSuiAddress('0xacc');

export interface DirectDeployment {
  readonly network: DirectNetwork;
  /** Current `published_at`, by package key. The only ids a call may target. */
  readonly callable: Readonly<Record<'prediction' | 'framework' | 'account' | 'custody', string>>;
  /** Shared objects by role. */
  readonly objects: {
    readonly predictionGlobalConfig: string;
    readonly marketRegistry: string;
    readonly accountRegistry: string;
    readonly custodyVault: string | undefined;
    readonly creditRegistry: string | undefined;
  };
  /**
   * The settlement coin type, as a (defining package, module, name). Move type
   * identity uses the package's ORIGINAL id, which for `usd` is also its only one.
   */
  readonly settlementCoin: { readonly address: string; readonly module: string; readonly name: string };
  /**
   * Original (type-defining) ids. A Move type names the package that first
   * defined it, so an on-chain `Account` or a permission key is matched here,
   * never against `published_at`.
   */
  readonly originals: Readonly<Record<'prediction' | 'account', string>>;
  /** Every package's original id → its waterx-config key, for reading types back symbolically. */
  readonly packageNames: ReadonlyMap<string, string>;
  /** Every package id a TYPE argument may come from (original and current). */
  readonly typeablePackages: ReadonlySet<string>;
}

export class DirectDeploymentError extends Error {
  override readonly name = 'DirectDeploymentError';
}

type Json = Record<string, unknown>;

const field = (object: unknown, key: string, where: string): Json => {
  const value = (object as Json | undefined)?.[key];
  if (typeof value !== 'object' || value === null) {
    throw new DirectDeploymentError(`waterx-config has no \`${where}.${key}\``);
  }
  return value as Json;
};

const text = (object: Json, key: string, where: string): string => {
  const value = object[key];
  if (typeof value !== 'string' || value === '') {
    throw new DirectDeploymentError(`waterx-config has no \`${where}.${key}\``);
  }
  return value;
};

const optionalText = (object: Json | undefined, key: string): string | undefined => {
  const value = object?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
};

/** Parse a waterx-config document. Pure, so the rules are testable offline. */
export function parseDeployment(document: unknown, expected: DirectNetwork): DirectDeployment {
  const root = document as Json;
  const schema = root?.['schema_version'];
  if (schema !== WATERX_CONFIG_SCHEMA_VERSION) {
    // The legacy per-package shape carries no `schema_version` and keeps every
    // object id beside `published_at`. Reading it here would mean guessing at
    // ids from the wrong place, so it is refused with the fix spelled out.
    const found = schema === undefined ? 'no `schema_version`' : `\`schema_version\` ${JSON.stringify(schema)}`;
    throw new DirectDeploymentError(
      `waterx-config has ${found}; direct mode reads the consolidated schema_version ${String(WATERX_CONFIG_SCHEMA_VERSION)} document ` +
        `(objects under \`objects.*\`, package identity under \`packages.*\`). Point WATERX_CONFIG_URL at a v2 root: ` +
        `${WATERX_CONFIG_URLS.mainnet} or ${WATERX_CONFIG_URLS.testnet}`,
    );
  }
  if (root['network'] !== expected) {
    // A testnet document behind a mainnet URL (or the reverse) would admit the
    // wrong packages while every check passed.
    throw new DirectDeploymentError(
      `waterx-config describes \`${String(root['network'])}\`, not \`${expected}\``,
    );
  }
  // Package identity — `published_at` and `original_id` — stays under `packages.*`.
  const packages = field(root, 'packages', '');
  const prediction = field(packages, 'waterx_prediction', 'packages');
  const framework = field(packages, 'bucket_framework', 'packages');
  const account = field(packages, 'waterx_account', 'packages');
  const custody = (packages['native_custody'] ?? undefined) as Json | undefined;

  // Every shared object id lives under `objects.<domain>`.
  const objects = field(root, 'objects', '');
  const predictionObjects = field(objects, 'prediction', 'objects');
  const accountObjects = field(objects, 'account', 'objects');
  const custodyObjects = (objects['custody'] ?? undefined) as Json | undefined;
  const creditObjects = (objects['credit'] ?? undefined) as Json | undefined;

  const registries = field(predictionObjects, 'market_registries', 'objects.prediction');
  const coins = field(predictionObjects, 'settlement_coin_types', 'objects.prediction');
  const coin = text(coins, 'USD', 'objects.prediction.settlement_coin_types');
  const parts = coin.split('::');
  if (parts.length !== 3) throw new DirectDeploymentError(`settlement coin type \`${coin}\` is not address::module::name`);

  const typeable = new Set<string>();
  const packageNames = new Map<string, string>();
  for (const [key, value] of Object.entries(packages)) {
    if (typeof value !== 'object' || value === null) continue;
    const original = optionalText(value as Json, 'original_id');
    if (original !== undefined) packageNames.set(normalizeSuiAddress(original), key);
    for (const key of ['published_at', 'original_id']) {
      const id = optionalText(value as Json, key);
      if (id !== undefined) typeable.add(normalizeSuiAddress(id));
    }
  }

  // The USD stack: `objects.custody.vault` / `objects.credit.registry` are the
  // USD credit's, and the per-credit maps (`objects.credit.registries[USD]`)
  // mirror them. The settlement coin read above is USD, so these are its objects.
  const custodyVault = optionalText(custodyObjects, 'vault');
  const creditRegistry = optionalText(creditObjects, 'registry');
  return {
    network: expected,
    callable: {
      prediction: normalizeSuiAddress(text(prediction, 'published_at', 'packages.waterx_prediction')),
      framework: normalizeSuiAddress(text(framework, 'published_at', 'packages.bucket_framework')),
      account: normalizeSuiAddress(text(account, 'published_at', 'packages.waterx_account')),
      custody:
        custody === undefined
          ? ''
          : normalizeSuiAddress(text(custody, 'published_at', 'packages.native_custody')),
    },
    objects: {
      predictionGlobalConfig: normalizeSuiAddress(text(predictionObjects, 'global_config', 'objects.prediction')),
      marketRegistry: normalizeSuiAddress(text(registries, 'USD', 'objects.prediction.market_registries')),
      accountRegistry: normalizeSuiAddress(text(accountObjects, 'registry', 'objects.account')),
      custodyVault: custodyVault === undefined ? undefined : normalizeSuiAddress(custodyVault),
      creditRegistry: creditRegistry === undefined ? undefined : normalizeSuiAddress(creditRegistry),
    },
    settlementCoin: { address: normalizeSuiAddress(parts[0]!), module: parts[1]!, name: parts[2]! },
    originals: {
      prediction: normalizeSuiAddress(text(prediction, 'original_id', 'packages.waterx_prediction')),
      account: normalizeSuiAddress(text(account, 'original_id', 'packages.waterx_account')),
    },
    packageNames,
    typeablePackages: typeable,
  };
}

export interface DeploymentSource {
  load(signal?: AbortSignal): Promise<DirectDeployment>;
}

export interface FetchedDeploymentOptions {
  readonly network: DirectNetwork;
  /**
   * `WATERX_CONFIG_URL`: a CDN ROOT, no filename (`${root}/${network}.json` is
   * read). Unset: the network's default root. Replaces the former `url`, which
   * took a whole document URL; passing `url` now throws.
   */
  readonly waterxConfigUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

/**
 * Fetches and caches the document. A failed refresh is a failure, not a reason
 * to keep using a stale copy: the one thing this list must not do is keep
 * admitting a package the deployment has moved away from.
 */
export class FetchedDeployment implements DeploymentSource {
  private cached: { at: number; value: DirectDeployment } | undefined;
  private readonly options: FetchedDeploymentOptions;

  private readonly url: string;

  constructor(options: FetchedDeploymentOptions) {
    if ((options as { url?: unknown }).url !== undefined) {
      throw new DirectDeploymentError(
        '`url` is retired; pass `waterxConfigUrl`, a CDN ROOT with no filename (e.g. https://main-v2.waterx-config.pages.dev; <network>.json is appended).',
      );
    }
    this.options = options;
    // Validated here, not at the first fetch: a malformed root is a setup
    // mistake and should stop the client being built.
    this.url = waterxConfigDocumentUrl(options.network, options.waterxConfigUrl);
  }

  async load(signal?: AbortSignal): Promise<DirectDeployment> {
    const now = (this.options.now ?? Date.now)();
    const ttl = this.options.ttlMs ?? 5 * 60_000;
    if (this.cached !== undefined && now - this.cached.at < ttl) return this.cached.value;
    const url = this.url;
    const fetchImpl = this.options.fetch ?? globalThis.fetch.bind(globalThis);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: signal ?? AbortSignal.timeout(15_000),
      });
    } catch (error: unknown) {
      throw new DirectDeploymentError(
        `could not fetch the deployment config at ${url}: ${error instanceof Error ? error.message : 'failed'}`,
      );
    }
    if (!response.ok) {
      throw new DirectDeploymentError(`the deployment config at ${url} answered HTTP ${String(response.status)}`);
    }
    let value: DirectDeployment;
    try {
      value = parseDeployment(await response.json(), this.options.network);
    } catch (error: unknown) {
      // Name the URL: a wrong schema or network is almost always a wrong host.
      if (!(error instanceof DirectDeploymentError)) throw error;
      throw new DirectDeploymentError(`the deployment config at ${url}: ${error.message}`);
    }
    this.cached = { at: now, value };
    return value;
  }
}
