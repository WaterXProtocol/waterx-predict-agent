/**
 * Where the CLI's settings come from, and what it refuses to accept.
 *
 * Precedence, lowest first: config file, then environment, then per-invocation
 * flags. Nothing here is required — `describe` has to answer on a machine with
 * no configuration at all, because discovery precedes setup.
 *
 * THE SECRET RULE: the config file is scanned for credential-shaped keys and
 * REFUSED if it has any. A private key belongs behind the signer command inside
 * the Runner's trust boundary (ADR-0001 §6), never in a JSON file this process
 * reads into memory and might echo. The refusal names the key path and never the
 * value — an error message that quotes the secret it is objecting to has leaked
 * it to every log the message reaches.
 */
import { CliError } from './errors.ts';

export interface ResolvedConfig {
  readonly baseUrl: string | undefined;
  /** Free-form label, e.g. `testnet`. Reported by `describe`, never inferred. */
  readonly environment: string | undefined;
  readonly agentWallet: string | undefined;
  readonly defaultAccountId: string | undefined;
  /** argv for the external signer process. Never a key. */
  readonly signerCommand: readonly string[] | undefined;
  readonly timeoutMs: number;
  /** A pre-minted session token, if one was supplied. Registered for redaction. */
  readonly token: string | undefined;
  /** Which file was read, or null when none existed. Never invented. */
  readonly configPath: string | null;
  readonly warnings: readonly string[];
}

export const DEFAULT_TIMEOUT_MS = 15_000;

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;

/**
 * Anything matching this in a config key is treated as a credential. Broad on
 * purpose: a false positive costs someone a rename, a false negative puts a key
 * in a file that gets committed.
 */
const SECRET_KEY_PATTERN =
  /(private|secret|mnemonic|seed|passphrase|password|token|credential|apikey|api_key)/iu;

const KNOWN_FILE_KEYS = new Set([
  'baseUrl',
  'environment',
  'agentWallet',
  'defaultAccountId',
  'signerCommand',
  'timeoutMs',
]);

export const ENV_KEYS = {
  configPath: 'WATERX_PREDICT_CONFIG',
  baseUrl: 'WATERX_PREDICT_BASE_URL',
  environment: 'WATERX_PREDICT_ENVIRONMENT',
  agentWallet: 'WATERX_PREDICT_AGENT_WALLET',
  accountId: 'WATERX_PREDICT_ACCOUNT_ID',
  signerCommand: 'WATERX_PREDICT_SIGNER_COMMAND',
  timeoutMs: 'WATERX_PREDICT_TIMEOUT_MS',
  token: 'WATERX_PREDICT_TOKEN',
} as const;

export type EnvReader = Readonly<Record<string, string | undefined>>;

export interface ConfigSources {
  readonly env: EnvReader;
  /** Returns null when the path does not exist. Throws only on a real read error. */
  readFile(path: string): string | null;
  /** null on a system with no resolvable home directory. */
  homeDir(): string | null;
  /** From `--config`. Explicit, so a missing file here is an error. */
  explicitPath?: string | undefined;
  /** From `--timeout-ms`. */
  timeoutMs?: number | undefined;
}

interface FileConfig {
  baseUrl?: unknown;
  environment?: unknown;
  agentWallet?: unknown;
  defaultAccountId?: unknown;
  signerCommand?: unknown;
  timeoutMs?: unknown;
}

/** Every path the config file may live at, in precedence order. */
export function candidateConfigPaths(sources: ConfigSources): string[] {
  if (sources.explicitPath !== undefined) return [sources.explicitPath];
  const fromEnv = sources.env[ENV_KEYS.configPath];
  if (fromEnv !== undefined && fromEnv !== '') return [fromEnv];
  const xdg = sources.env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg !== '') return [`${xdg}/waterx-predict/config.json`];
  const home = sources.homeDir();
  return home === null ? [] : [`${home}/.config/waterx-predict/config.json`];
}

/**
 * Walk the parsed file for credential-shaped keys.
 *
 * Recursive, because nesting a key one level down would otherwise slip past.
 */
function assertNoSecrets(value: unknown, path: string, filePath: string): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertNoSecrets(item, `${path}[${String(index)}]`, filePath);
    });
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    const keyPath = path === '' ? key : `${path}.${key}`;
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new CliError(
        'CONFIG_CONTAINS_SECRET',
        `The config file holds a credential-shaped key (${keyPath}). Move it out of the file: a signing key belongs behind the signer command, and a session token belongs in ${ENV_KEYS.token}.`,
        // The key path, never the value.
        { file: filePath, key: keyPath },
      );
    }
    assertNoSecrets(nested, keyPath, filePath);
  }
}

function readConfigFile(sources: ConfigSources): { path: string | null; config: FileConfig } {
  for (const path of candidateConfigPaths(sources)) {
    const raw = sources.readFile(path);
    if (raw === null) {
      // An explicit `--config` naming a file that is not there is a mistake
      // worth stopping for; a missing default location simply means unconfigured.
      if (sources.explicitPath !== undefined) {
        throw new CliError('CONFIG_INVALID', `No config file at ${path}.`, { file: path });
      }
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error: unknown) {
      throw new CliError(
        'CONFIG_INVALID',
        `The config file at ${path} is not valid JSON: ${error instanceof Error ? error.message : 'parse failed'}`,
        { file: path },
      );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CliError('CONFIG_INVALID', `The config file at ${path} must be a JSON object.`, {
        file: path,
      });
    }
    assertNoSecrets(parsed, '', path);
    for (const key of Object.keys(parsed)) {
      if (!KNOWN_FILE_KEYS.has(key)) {
        throw new CliError(
          'CONFIG_INVALID',
          `\`${key}\` in ${path} is not a known setting. Known settings: ${[...KNOWN_FILE_KEYS].join(', ')}.`,
          { file: path, key },
        );
      }
    }
    return { path, config: parsed as FileConfig };
  }
  return { path: null, config: {} };
}

function asString(value: unknown, key: string, where: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CliError('CONFIG_INVALID', `\`${key}\` in ${where} must be a non-empty string.`, {
      key,
    });
  }
  return value.trim();
}

/**
 * A signer command is argv, not a shell string: this CLI never invokes a shell,
 * so a bare executable name is accepted and anything with arguments must be a
 * JSON array. Splitting on spaces instead would break the first path containing
 * one and quietly change which program runs.
 */
function asCommand(value: unknown, key: string, where: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    if (trimmed.startsWith('[')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new CliError('CONFIG_INVALID', `\`${key}\` in ${where} is not valid JSON.`, { key });
      }
      return asCommand(parsed, key, where);
    }
    return [trimmed];
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === 'string' && item !== '')
  ) {
    throw new CliError(
      'CONFIG_INVALID',
      `\`${key}\` in ${where} must be a non-empty executable name or a JSON array of argv strings.`,
      { key },
    );
  }
  return value as readonly string[];
}

function asTimeout(value: unknown, key: string, where: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (
    typeof parsed !== 'number' ||
    !Number.isInteger(parsed) ||
    parsed < MIN_TIMEOUT_MS ||
    parsed > MAX_TIMEOUT_MS
  ) {
    throw new CliError(
      'CONFIG_INVALID',
      `\`${key}\` in ${where} must be a whole number of milliseconds between ${String(MIN_TIMEOUT_MS)} and ${String(MAX_TIMEOUT_MS)}.`,
      { key },
    );
  }
  return parsed;
}

/**
 * Plaintext HTTP to anything but the loopback interface puts the bearer token on
 * the wire in clear. A warning rather than a refusal, because a local mock
 * server on a container hostname is a legitimate test setup.
 */
function plaintextWarning(baseUrl: string | undefined): string | null {
  if (baseUrl === undefined || !baseUrl.startsWith('http://')) return null;
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return null;
  }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
    return null;
  }
  return `baseUrl uses plaintext http:// to ${host}. The session token is sent in clear over that connection.`;
}

export function loadConfig(sources: ConfigSources): ResolvedConfig {
  const { path, config } = readConfigFile(sources);
  const where = path ?? 'the config file';
  const env = sources.env;
  const warnings: string[] = [];

  const baseUrl =
    asString(env[ENV_KEYS.baseUrl], ENV_KEYS.baseUrl, 'the environment') ??
    asString(config.baseUrl, 'baseUrl', where);

  const timeoutMs =
    sources.timeoutMs ??
    asTimeout(env[ENV_KEYS.timeoutMs], ENV_KEYS.timeoutMs, 'the environment') ??
    asTimeout(config.timeoutMs, 'timeoutMs', where) ??
    DEFAULT_TIMEOUT_MS;

  const warning = plaintextWarning(baseUrl);
  if (warning !== null) warnings.push(warning);

  return {
    baseUrl: baseUrl?.replace(/\/+$/u, ''),
    environment:
      asString(env[ENV_KEYS.environment], ENV_KEYS.environment, 'the environment') ??
      asString(config.environment, 'environment', where),
    agentWallet:
      asString(env[ENV_KEYS.agentWallet], ENV_KEYS.agentWallet, 'the environment') ??
      asString(config.agentWallet, 'agentWallet', where),
    defaultAccountId:
      asString(env[ENV_KEYS.accountId], ENV_KEYS.accountId, 'the environment') ??
      asString(config.defaultAccountId, 'defaultAccountId', where),
    signerCommand:
      asCommand(env[ENV_KEYS.signerCommand], ENV_KEYS.signerCommand, 'the environment') ??
      asCommand(config.signerCommand, 'signerCommand', where),
    timeoutMs,
    token: env[ENV_KEYS.token] === '' ? undefined : env[ENV_KEYS.token],
    configPath: path,
    warnings,
  };
}

/** Read the config file with the real filesystem, treating "absent" as null. */
export function createNodeConfigSources(
  env: EnvReader,
  readFileSync: (path: string, encoding: 'utf8') => string,
  homedir: () => string,
): Pick<ConfigSources, 'env' | 'readFile' | 'homeDir'> {
  return {
    env,
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch (error: unknown) {
        const code = (error as { code?: string } | null)?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return null;
        throw new CliError(
          'CONFIG_INVALID',
          `Could not read the config file at ${path}: ${code ?? 'read failed'}`,
          { file: path },
        );
      }
    },
    homeDir: () => {
      try {
        const home = homedir();
        return home === '' ? null : home;
      } catch {
        return null;
      }
    },
  };
}
