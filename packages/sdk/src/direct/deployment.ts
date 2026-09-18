/**
 * Which packages and shared objects a transaction may touch, from the
 * deployment's own published config.
 *
 * The verifier (`verify.ts`) refuses a call to any package that is not the
 * CURRENT `published_at` of the package it claims to be, and a shared object
 * whose id is not the one the deployment names for that role. Both lists come
 * from here, fetched from the same waterx-config document the backend builds
 * transactions from (`WATERX_CONFIG_URL` there; the defaults below are the ones
 * the perp agent uses, `waterx-agent` `src/config.ts:59-60`).
 *
 * Fetched rather than shipped: a package upgrade moves `published_at`, and a
 * pinned copy would refuse every order the day after one — or, worse, keep
 * accepting the superseded id.
 */
import { normalizeSuiAddress } from '../sui-tx.ts';

export type DirectNetwork = 'mainnet' | 'testnet';

export const WATERX_CONFIG_URLS: Readonly<Record<DirectNetwork, string>> = {
  mainnet: 'https://config.waterx.app/mainnet.json',
  testnet: 'https://staging.waterx-config.pages.dev/testnet.json',
};

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
  if (root?.['network'] !== expected) {
    // A testnet document behind a mainnet URL (or the reverse) would admit the
    // wrong packages while every check passed.
    throw new DirectDeploymentError(
      `waterx-config describes \`${String(root?.['network'])}\`, not \`${expected}\``,
    );
  }
  const packages = field(root, 'packages', '');
  const prediction = field(packages, 'waterx_prediction', 'packages');
  const framework = field(packages, 'bucket_framework', 'packages');
  const account = field(packages, 'waterx_account', 'packages');
  const custody = (packages['native_custody'] ?? undefined) as Json | undefined;
  const credit = (packages['waterx_credit'] ?? undefined) as Json | undefined;

  const registries = field(prediction, 'market_registries', 'packages.waterx_prediction');
  const coins = field(prediction, 'settlement_coin_types', 'packages.waterx_prediction');
  const coin = text(coins, 'USD', 'packages.waterx_prediction.settlement_coin_types');
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

  const custodyVault = optionalText(custody, 'vault');
  const creditRegistry = optionalText(credit, 'credit_registry');
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
      predictionGlobalConfig: normalizeSuiAddress(text(prediction, 'global_config', 'packages.waterx_prediction')),
      marketRegistry: normalizeSuiAddress(text(registries, 'USD', 'packages.waterx_prediction.market_registries')),
      accountRegistry: normalizeSuiAddress(text(account, 'account_registry', 'packages.waterx_account')),
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
  readonly url?: string;
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

  constructor(options: FetchedDeploymentOptions) {
    this.options = options;
  }

  async load(signal?: AbortSignal): Promise<DirectDeployment> {
    const now = (this.options.now ?? Date.now)();
    const ttl = this.options.ttlMs ?? 5 * 60_000;
    if (this.cached !== undefined && now - this.cached.at < ttl) return this.cached.value;
    const url = this.options.url ?? WATERX_CONFIG_URLS[this.options.network];
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
    const value = parseDeployment(await response.json(), this.options.network);
    this.cached = { at: now, value };
    return value;
  }
}
