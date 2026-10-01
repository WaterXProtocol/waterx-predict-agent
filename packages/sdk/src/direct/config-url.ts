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

export class WaterxConfigUrlError extends Error {
  override readonly name = 'WaterxConfigUrlError';
}

const EXAMPLE = WATERX_CONFIG_URLS.mainnet;
const FORBIDDEN_HOST_SUFFIXES = ['github.com', 'githubusercontent.com'];
/** Plain http is accepted for these only: a local stub, never a network hop. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Validate a configured root and return it without trailing slashes. Throws
 * `WaterxConfigUrlError` naming the fix.
 */
export function normalizeWaterxConfigRoot(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new WaterxConfigUrlError(`${WATERX_CONFIG_URL_ENV} is empty; set it to a CDN ROOT such as ${EXAMPLE}, or leave it unset for the network's default.`);
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new WaterxConfigUrlError(`${WATERX_CONFIG_URL_ENV} is not a URL — got "${raw}". Set it to a CDN ROOT such as ${EXAMPLE}.`);
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.has(hostname))) {
    throw new WaterxConfigUrlError(
      `${WATERX_CONFIG_URL_ENV} must be an https:// URL — got "${raw}". Set it to a CDN ROOT such as ${EXAMPLE}.`,
    );
  }
  if (FORBIDDEN_HOST_SUFFIXES.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))) {
    throw new WaterxConfigUrlError(
      `${WATERX_CONFIG_URL_ENV} must not point at ${hostname} — got "${raw}". GitHub is rate-limited and forbidden by the config repo; use the waterx-config CDN, e.g. ${EXAMPLE}.`,
    );
  }
  const path = url.pathname.replace(/\/+$/u, '');
  if (path.toLowerCase().endsWith('.json')) {
    throw new WaterxConfigUrlError(
      `${WATERX_CONFIG_URL_ENV} must be a CDN ROOT with no filename — got "${raw}". Set it to e.g. ${EXAMPLE}; <network>.json is appended.`,
    );
  }
  if (url.search !== '' || url.hash !== '') {
    throw new WaterxConfigUrlError(
      `${WATERX_CONFIG_URL_ENV} must be a CDN ROOT with no query or fragment — got "${raw}". Set it to e.g. ${EXAMPLE}; <network>.json is appended.`,
    );
  }
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
      throw new WaterxConfigUrlError(
        `${name} is retired; use ${WATERX_CONFIG_URL_ENV}, set to a CDN ROOT with no filename (e.g. ${EXAMPLE}; <network>.json is appended). Unset ${name}.`,
      );
    }
  }
}
