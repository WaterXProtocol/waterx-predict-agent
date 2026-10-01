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
 * fragment (appending would land inside it), a username or password (a public
 * CDN root never carries credentials), a non-https scheme, and GitHub
 * (rate-limited, and forbidden by the config repo; the CDN is the source).
 *
 * A refusal never echoes the value as given: a query, a fragment or userinfo is
 * exactly where a signed CDN token or an API key sits, and the message travels
 * on into `CONFIG_INVALID` envelopes and Runner diagnostics. It shows the URL
 * with userinfo, query and fragment removed, or — when the value does not parse
 * as a URL — nothing of it at all.
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
  // A plain field, not a parameter property: scripts load this file under
  // `--experimental-strip-types`, which refuses parameter properties.
  readonly setting: string;
  constructor(message: string, setting: string) {
    super(message);
    this.setting = setting;
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

/**
 * What a refusal may show of a configured value: the URL with userinfo, query
 * and fragment removed. `undefined` — show nothing — for a value that is not a
 * URL, and for one with no host (`mailto:`, `data:` …), whose whole body is an
 * opaque path the parser cannot separate a secret from.
 */
export function redactWaterxConfigUrl(url: URL | string): string | undefined {
  let copy: URL;
  try {
    copy = new URL(typeof url === 'string' ? url.trim() : url.href);
  } catch {
    return undefined;
  }
  if (copy.host === '' && copy.protocol !== 'file:') return undefined;
  copy.username = '';
  copy.password = '';
  copy.search = '';
  copy.hash = '';
  return copy.href;
}

/**
 * A refusal naming the setting, the problem and the fix. It shows `url` only
 * as `redactWaterxConfigUrl` renders it — never the raw value.
 */
const refuse = (setting: string, url: URL | undefined, problem: string): WaterxConfigUrlError => {
  const shown = url === undefined ? undefined : redactWaterxConfigUrl(url);
  const got = shown === undefined ? '' : ` — got "${shown}"`;
  return new WaterxConfigUrlError(`${setting} ${problem}${got}. Set it to ${ROOT_HINT}.`, setting);
};
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
    // Nothing of the value is shown: it did not parse, so there is no telling
    // which part of it is a credential.
    throw refuse(setting, undefined, 'is not a URL');
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(hostname))) {
    throw refuse(setting, url, 'must be an https:// URL');
  }
  if (url.username !== '' || url.password !== '') {
    // A deliberate divergence from `waterxConfigUrlFromRoot`, which accepts
    // userinfo and drops it from the URL it builds (see the parity test).
    throw refuse(setting, url, 'must not carry a username or password (a public CDN root never does)');
  }
  if (FORBIDDEN_HOST_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))) {
    throw refuse(setting, url, `must not point at ${hostname} (GitHub is rate-limited and forbidden by the config repo; use the waterx-config CDN)`);
  }
  const path = url.pathname.replace(/\/+$/u, '');
  if (path.toLowerCase().endsWith('.json')) throw refuse(setting, url, 'must be a CDN ROOT with no filename');
  if (url.search !== '' || url.hash !== '') throw refuse(setting, url, 'must be a CDN ROOT with no query or fragment');
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
