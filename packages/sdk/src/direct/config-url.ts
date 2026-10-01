/**
 * `WATERX_CONFIG_URL`: where the waterx-config document is read.
 *
 * The value is a CDN ROOT — `https://<host>`, no filename — and the document
 * is `${root}/${network}.json`, with the network the client already has. One
 * name and one shape across every WaterX service, so the same value can be
 * pasted anywhere and the network is never stated twice.
 *
 * Refused, loudly, rather than rewritten: a full document URL (the old form —
 * appending to it would 404 as `…/mainnet.json/mainnet.json`), a query or
 * fragment (appending would land inside it), a non-https scheme, and GitHub
 * (rate-limited, and forbidden by the config repo; the CDN is the source).
 *
 * Those rules are the fleet's, and their one reference implementation is
 * `@waterx/sdk`'s `waterxConfigUrlFromRoot`. This package does not import it at
 * runtime: `@waterx/sdk` peers on `@mysten/sui` / `@mysten/bcs` and declares
 * `engines.node >=22`, and this SDK publishes with one runtime dependency and a
 * Node 20 floor (AGENTS.md "Runtime and dependency policy", held by
 * `tests/workspace.test.ts`). So the rules are restated here and held to the
 * SDK helper by `tests/config-url.test.ts`, which runs the same inputs through
 * both and requires the same verdict and the same URL. What is owned here and
 * nowhere else: the per-network default, the retired names, the error class,
 * and one allowance the SDK does not make — plain `http://` to a loopback host,
 * so `cli:bundle:check` can serve the document from its local stub.
 */
import type { DirectNetwork } from './deployment.ts';

/** The variable's one name. */
export const WATERX_CONFIG_URL_ENV = 'WATERX_CONFIG_URL';

/**
 * Names a deployment may still carry from before `WATERX_CONFIG_URL`. Setting
 * one is an error, never silently ignored: a deployment relying on the old name
 * must not quietly lose its override and read the default.
 */
export const RETIRED_WATERX_CONFIG_URL_ENV = [
  'WATERX_PREDICT_DEPLOYMENT_URL',
  'PREDICT_CONFIG_URL',
  'E2E_CONFIG_URL',
  'CONFIG_URL',
  'WATERX_CONFIG_ROOT',
] as const;

/**
 * The default ROOT per network, used when `WATERX_CONFIG_URL` is unset:
 * production (`main-v2`) for mainnet, staging (`staging-v2`) for testnet. Both
 * serve the consolidated `schema_version: 2` document. Roots, not documents —
 * `${root}/${network}.json` is appended.
 */
export const WATERX_CONFIG_URLS: Readonly<Record<DirectNetwork, string>> = {
  mainnet: 'https://main-v2.waterx-config.pages.dev',
  testnet: 'https://staging-v2.waterx-config.pages.dev',
};

/**
 * A refused `WATERX_CONFIG_URL` value, retired name or retired option. A
 * setup mistake, never transient. `setting` names what was refused — the
 * variable, a retired name, or whatever label the caller passed — so a host
 * can point at the source the operator has to change.
 */
export class WaterxConfigUrlError extends Error {
  override readonly name = 'WaterxConfigUrlError';
  constructor(
    message: string,
    readonly setting: string,
  ) {
    super(message);
  }
}

const EXAMPLE = WATERX_CONFIG_URLS.mainnet;
const ROOT_HINT = `a CDN ROOT with no filename (e.g. ${EXAMPLE}; <network>.json is appended)`;

/**
 * The one message for a retired name or option: `retired` is what was set,
 * `replacement` what to set instead. Shared by the env check here, the SDK's
 * retired client options and the CLI's retired config key.
 */
export function retiredWaterxConfigUrlMessage(retired: string, replacement: string): string {
  return `${retired} is retired; use ${replacement}, set to ${ROOT_HINT}.`;
}

/** A refusal of `raw`, naming the setting, the problem and the fix. */
const refuse = (setting: string, raw: string, problem: string): WaterxConfigUrlError =>
  new WaterxConfigUrlError(`${setting} ${problem} — got "${raw}". Set it to ${ROOT_HINT}.`, setting);
const FORBIDDEN_HOST_SUFFIXES = ['github.com', 'githubusercontent.com'];
/** Plain http is accepted for these only: a local stub, never a network hop. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Validate a configured root and return it without trailing slashes. Throws
 * `WaterxConfigUrlError` naming the fix.
 */
export function normalizeWaterxConfigRoot(raw: string, setting: string = WATERX_CONFIG_URL_ENV): string {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new WaterxConfigUrlError(`${setting} is empty; set it to ${ROOT_HINT}, or leave it unset for the network's default.`, setting);
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw refuse(setting, raw, 'is not a URL');
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(hostname))) {
    throw refuse(setting, raw, 'must be an https:// URL');
  }
  if (FORBIDDEN_HOST_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))) {
    throw refuse(setting, raw, `must not point at ${hostname} (GitHub is rate-limited and forbidden by the config repo; use the waterx-config CDN)`);
  }
  const path = url.pathname.replace(/\/+$/u, '');
  if (path.toLowerCase().endsWith('.json')) throw refuse(setting, raw, 'must be a CDN ROOT with no filename');
  if (url.search !== '' || url.hash !== '') throw refuse(setting, raw, 'must be a CDN ROOT with no query or fragment');
  // Composed from the parsed URL, as `waterxConfigUrlFromRoot` does, so the two
  // agree byte for byte (host case, default port).
  return `${url.origin}${path}`;
}

/**
 * The document URL for `network`: `${root}/${network}.json`, where the root is
 * `configured` when given (validated) and the network's default otherwise.
 */
export function waterxConfigDocumentUrl(network: DirectNetwork, configured?: string): string {
  const root =
    configured === undefined || configured.trim() === ''
      ? WATERX_CONFIG_URLS[network]
      : normalizeWaterxConfigRoot(configured);
  return `${root}/${network}.json`;
}

/** Throw if any retired name for `WATERX_CONFIG_URL` is set (non-empty) in `env`. */
export function assertNoRetiredWaterxConfigUrlEnv(env: Readonly<Record<string, string | undefined>>): void {
  for (const name of RETIRED_WATERX_CONFIG_URL_ENV) {
    const value = env[name];
    if (value !== undefined && value.trim() !== '') {
      throw new WaterxConfigUrlError(`${retiredWaterxConfigUrlMessage(name, WATERX_CONFIG_URL_ENV)} Unset ${name}.`, name);
    }
  }
}
