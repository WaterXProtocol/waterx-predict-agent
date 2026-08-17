/**
 * Where a shipped `runnerd` gets the three things it needs to drive a job.
 *
 * A daemon drives only when it is handed a gateway, a price source and a signer
 * *together* (`daemon.ts`). Until this file existed the process could build none
 * of them: there was no format that said which server to talk to, which wallet it
 * trades as, or which keystore command holds the key. That — not the collaborators
 * themselves — was the last gap between a Runner that answers and a Runner that
 * runs.
 *
 * ## All three or none
 *
 * {@link resolveRunnerConfig} either produces a complete driver configuration or
 * names, in `gaps`, every piece that is missing. There is deliberately no partial
 * form. A Runner with a gateway and no signer would watch a market, meet a target,
 * create an execution and then discover it cannot authorize it — an order sitting
 * on the server with a local job that can never resolve it, which is the exact
 * ambiguity the whole side-effect ledger exists to avoid manufacturing. Refusing
 * to start a driver costs a strategy nothing: the job stays where recovery put it
 * and the next correctly configured Runner picks it up under the same key.
 *
 * ## What this file will not hold
 *
 * **No key material.** The config names an *argv*; the key stays inside whatever
 * the child process is (ADR-0001 §6). A credential-shaped key anywhere in the
 * file — at any depth — is a hard refusal naming the key path and never the value.
 *
 * ## The mandate is configuration, never a request
 *
 * A durable strategy signs while nobody is watching, so the authority it runs
 * under has to be something the operator wrote down on this machine. That is what
 * the `policy` block is: {@link RunnerPolicyConfig} is read here and handed to the
 * daemon, and every job admitted over the local socket carries *this* snapshot.
 * Nothing a client sends can name a mode, raise a notional ceiling or push out a
 * `notAfter` — a socket peer that could would be granting itself the mandate,
 * which is the failure ADR-0003 §1 exists to prevent.
 *
 * The default is `interactive`, and that is deliberate: it is the mode
 * `requirePolicyThatCanSignUnattended` refuses. An operator who has not decided
 * gets a Runner that answers, recovers and drives the jobs it already has, and
 * refuses to arm a new one — rather than one that quietly signs because a default
 * was convenient.
 *
 * **No session token, from anywhere.** Not from the file and not from the
 * environment. A seven-day strategy outlives any token, so a Runner that was
 * handed one would stop being able to read a market halfway through a mandate it
 * still holds. It authenticates itself instead, through the same keystore command,
 * and re-authenticates when the server rejects a token — which keeps a logical
 * write's idempotency key and bytes intact. That is why `token` is absent from
 * {@link RUNNER_ENV_KEYS} rather than merely unset.
 *
 * ## Precedence
 *
 * Environment over file, and nothing else: there are no flags, because `runnerd`
 * takes none — a long-lived process's configuration should be a document an
 * operator can review and a service manager can set, not an argv nobody can read
 * back after the terminal is gone.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { isIsoInstant } from './strategy/intent.ts';

/**
 * Every variable this process reads. Listed as data so the test that asserts no
 * token variable exists is checking the surface rather than a comment.
 */
export const RUNNER_ENV_KEYS = {
  runtimeDir: 'WATERX_RUNNER_DIR',
  storePath: 'WATERX_RUNNER_STORE',
  configPath: 'WATERX_RUNNER_CONFIG',
  baseUrl: 'WATERX_RUNNER_BASE_URL',
  agentWallet: 'WATERX_RUNNER_AGENT_WALLET',
  signerCommand: 'WATERX_RUNNER_SIGNER_COMMAND',
  signerTimeoutMs: 'WATERX_RUNNER_SIGNER_TIMEOUT_MS',
  tickIntervalMs: 'WATERX_RUNNER_TICK_INTERVAL_MS',
  maxJobs: 'WATERX_RUNNER_MAX_JOBS',
  policyMode: 'WATERX_RUNNER_POLICY_MODE',
} as const;

/** The settings the JSON file may carry. Anything else is a refusal, not a warning. */
export const RUNNER_FILE_KEYS: readonly string[] = [
  'baseUrl',
  'agentWallet',
  'signerCommand',
  'signerTimeoutMs',
  'tickIntervalMs',
  'maxJobs',
  'policy',
];

/** The keys inside `policy`. Closed for the same reason the top level is. */
export const RUNNER_POLICY_KEYS: readonly string[] = ['mode', 'maxOrderNotional', 'notAfter'];

/**
 * The three modes a job may be admitted under, matching {@link JobPolicySnapshot}.
 *
 * Two of them refuse: only `delegated-auto` can sign for a trigger nobody is
 * present for, and `requirePolicyThatCanSignUnattended` is the one place that
 * says so. They are accepted here rather than rejected at start-up because an
 * operator running a Runner purely to *watch and reconcile* the jobs it already
 * has is a legitimate configuration — it is arming a new one that is refused.
 */
export const RUNNER_POLICY_MODES = ['read-only', 'interactive', 'delegated-auto'] as const;

export type RunnerPolicyMode = (typeof RUNNER_POLICY_MODES)[number];

/**
 * The mandate this process admits a strategy under.
 *
 * Assignable to `JobPolicySnapshot` as-is: what is resolved here is exactly what
 * is written onto the durable job, so an audit reads the authority back rather
 * than a summary of it.
 *
 * `maxRunNotional` is absent on purpose. `JobPolicySnapshot` has the field and
 * nothing in this build enforces it — `preflight` reads `maxOrderNotional` and
 * the signer re-reads `notAfter`, and offering an operator a third setting that
 * bounds nothing would be a cap that exists only in a config file.
 */
export interface RunnerPolicyConfig {
  readonly mode: RunnerPolicyMode;
  /** Where the mandate came from, recorded on every job admitted under it. */
  readonly source: string;
  /** Per-order ceiling on a BUY's committed budget. Decimal string, never a number. */
  readonly maxOrderNotional?: string;
  /** The instant the mandate ends. Re-read by the signer at signing time. */
  readonly notAfter?: string;
}

/**
 * Anything matching this in a key name is treated as a credential. Broad on
 * purpose: a false positive costs an operator a rename, a false negative puts a
 * key in a file that gets committed, backed up and shipped to a log aggregator.
 */
const SECRET_KEY_PATTERN =
  /(private|secret|mnemonic|seed|passphrase|password|token|credential|apikey|api_key)/iu;

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;
const MIN_TICK_MS = 250;
const MAX_TICK_MS = 600_000;
const MAX_JOBS_CEILING = 10_000;

/** Every way this file refuses to produce a configuration. */
export type RunnerConfigErrorCode =
  /** The file is unreadable, not JSON, not an object, or holds an unknown key. */
  | 'CONFIG_INVALID'
  /** The file holds a credential-shaped key. Named, never quoted. */
  | 'CONFIG_CONTAINS_SECRET';

export class RunnerConfigError extends Error {
  override readonly name = 'RunnerConfigError';

  constructor(
    readonly code: RunnerConfigErrorCode,
    message: string,
    readonly detail?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}

export const isRunnerConfigError = (value: unknown): value is RunnerConfigError =>
  value instanceof RunnerConfigError;

/** A piece a driver cannot be built without, named the way `driverGaps` reports it. */
export type RunnerDriverGap =
  /** No base URL, so there is no server to quote, create or submit against. */
  | 'base-url'
  /** No agent wallet, so nothing can be authenticated or refused as another agent's. */
  | 'agent-wallet'
  /** No keystore command, so nothing can authorize an order. */
  | 'signer-command';

export interface RunnerDriverConfig {
  readonly baseUrl: string;
  readonly agentWallet: string;
  /** argv, run without a shell. Nothing in it is ever interpreted. */
  readonly signerCommand: readonly string[];
  readonly signerTimeoutMs: number;
}

export interface RunnerConfig {
  readonly runtimeDir: string;
  readonly storePath: string;
  /** Which file was read, or `null` when none existed. Never invented. */
  readonly configPath: string | null;
  /**
   * Present only when every piece is there. Absent means this process starts a
   * daemon that answers and recovers but drives nothing — see `gaps`.
   */
  readonly driver: RunnerDriverConfig | undefined;
  /** Empty exactly when `driver` is present. Ordered, so a diagnostic is stable. */
  readonly gaps: readonly RunnerDriverGap[];
  /**
   * What was actually resolved, whether or not it added up to a driver.
   *
   * For the start-up diagnostic only, and deliberately not something a client is
   * built from — a partial driver must not exist. It exists because an operator
   * who set the base URL and forgot the wallet needs to see the URL they set;
   * printing `null` for everything whenever anything is missing reads as "none of
   * this took effect", which sends them to fix the wrong line.
   */
  readonly resolved: {
    readonly baseUrl: string | undefined;
    readonly agentWallet: string | undefined;
    readonly signerCommand: readonly string[] | undefined;
  };
  readonly tickIntervalMs: number | undefined;
  readonly maxJobs: number | undefined;
  /**
   * The mandate every strategy admitted through this process is written under.
   *
   * Always present, because "no policy" is not a state a Runner can be in: the
   * absence of one is `interactive`, which refuses. Independent of `driver` on
   * purpose — a process may be fully configured to trade and still not be allowed
   * to arm anything, and that has to be visible as two facts rather than one.
   */
  readonly policy: RunnerPolicyConfig;
  readonly warnings: readonly string[];
}

export type RunnerEnv = Readonly<Record<string, string | undefined>>;

export interface RunnerConfigSources {
  readonly env: RunnerEnv;
  /** Returns `null` when the path does not exist. Throws only on a real read error. */
  readFile(path: string): string | null;
  /** `null` on a system with no resolvable home directory. */
  homeDir(): string | null;
}

/* ── Reading the file ──────────────────────────────────────────────────────── */

/**
 * Walks the parsed file for credential-shaped names, at every depth.
 *
 * Recursive because nesting one level down would otherwise slip past, and the
 * point is a key that reaches this process's memory at all.
 */
const assertNoConfigSecrets = (value: unknown, path: string, filePath: string): void => {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertNoConfigSecrets(item, `${path}[${String(index)}]`, filePath);
    });
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    const keyPath = path === '' ? key : `${path}.${key}`;
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new RunnerConfigError(
        'CONFIG_CONTAINS_SECRET',
        `the Runner config holds a credential-shaped key (${keyPath}); a signing key belongs behind the signer command, and this process holds no session token at all`,
        // The key path, never the value. A refusal that quoted the secret would
        // have leaked it into every log the refusal reaches.
        { file: filePath, key: keyPath },
      );
    }
    assertNoConfigSecrets(nested, keyPath, filePath);
  }
};

const configPathFor = (sources: RunnerConfigSources, runtimeDir: string): string => {
  const explicit = sources.env[RUNNER_ENV_KEYS.configPath];
  if (explicit !== undefined && explicit.trim() !== '') return explicit.trim();
  return join(runtimeDir, 'runner.json');
};

interface FileConfig {
  baseUrl?: unknown;
  agentWallet?: unknown;
  signerCommand?: unknown;
  signerTimeoutMs?: unknown;
  tickIntervalMs?: unknown;
  maxJobs?: unknown;
  policy?: unknown;
}

const readConfigFile = (
  sources: RunnerConfigSources,
  path: string,
): { path: string | null; config: FileConfig } => {
  const raw = sources.readFile(path);
  // A default location with no file simply means "not configured yet", and the
  // gaps below say so precisely. An explicit WATERX_RUNNER_CONFIG naming a file
  // that is not there is a mistake worth stopping for.
  if (raw === null) {
    const explicit = sources.env[RUNNER_ENV_KEYS.configPath];
    if (explicit !== undefined && explicit.trim() !== '') {
      throw new RunnerConfigError('CONFIG_INVALID', `no Runner config file at ${path}`, {
        file: path,
      });
    }
    return { path: null, config: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error: unknown) {
    throw new RunnerConfigError(
      'CONFIG_INVALID',
      `the Runner config at ${path} is not valid JSON: ${error instanceof Error ? error.message : 'parse failed'}`,
      { file: path },
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RunnerConfigError(
      'CONFIG_INVALID',
      `the Runner config at ${path} must be a JSON object`,
      { file: path },
    );
  }
  // Secrets before unknown keys: `privateKey` should be refused as a credential
  // rather than as a typo, because the two send an operator to different places.
  assertNoConfigSecrets(parsed, '', path);
  for (const key of Object.keys(parsed)) {
    if (!RUNNER_FILE_KEYS.includes(key)) {
      throw new RunnerConfigError(
        'CONFIG_INVALID',
        `\`${key}\` in ${path} is not a known Runner setting; known settings: ${RUNNER_FILE_KEYS.join(', ')}`,
        { file: path, key },
      );
    }
  }
  return { path, config: parsed as FileConfig };
};

/* ── Coercion-free readers ─────────────────────────────────────────────────── */

const asString = (value: unknown, key: string, where: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RunnerConfigError('CONFIG_INVALID', `\`${key}\` in ${where} must be a non-empty string`, {
      key,
    });
  }
  return value.trim();
};

/**
 * A signer command is argv, not a shell string: nothing here ever invokes a
 * shell, so a bare executable name is accepted and anything with arguments must
 * be a JSON array. Splitting on spaces would break the first path containing one
 * and quietly change which program runs.
 */
const asCommand = (value: unknown, key: string, where: string): readonly string[] | undefined => {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    if (trimmed.startsWith('[')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new RunnerConfigError('CONFIG_INVALID', `\`${key}\` in ${where} is not valid JSON`, {
          key,
        });
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
    throw new RunnerConfigError(
      'CONFIG_INVALID',
      `\`${key}\` in ${where} must be a non-empty executable name or a JSON array of argv strings`,
      { key },
    );
  }
  return value as readonly string[];
};

const asInteger = (
  value: unknown,
  key: string,
  where: string,
  min: number,
  max: number,
): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new RunnerConfigError(
      'CONFIG_INVALID',
      `\`${key}\` in ${where} must be a whole number between ${String(min)} and ${String(max)}`,
      { key },
    );
  }
  return parsed;
};

/**
 * Plaintext HTTP to anything but the loopback interface puts the session token on
 * the wire in clear. A warning rather than a refusal, because a local mock server
 * on a container hostname is a legitimate test setup — and this daemon runs for
 * days, so an operator gets to see it once at start-up rather than never.
 */
const plaintextWarning = (baseUrl: string | undefined): string | null => {
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
  return `baseUrl uses plaintext http:// to ${host}; the session token is sent in clear over that connection, and so is every quote frame`;
};

const DEFAULT_SIGNER_TIMEOUT_MS = 15_000;

/* ── The mandate ───────────────────────────────────────────────────────────── */

/**
 * A non-negative decimal, as a string.
 *
 * A JSON *number* is refused rather than accepted and stringified: money at this
 * scale does not survive an IEEE-754 round trip, and a ceiling that silently
 * became `100.00000000000001` is a ceiling nobody set.
 */
const DECIMAL = /^\d+(\.\d{1,18})?$/;

const asDecimal = (value: unknown, key: string, where: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !DECIMAL.test(value)) {
    throw new RunnerConfigError(
      'CONFIG_INVALID',
      `\`${key}\` in ${where} must be a non-negative decimal *string*, e.g. "100.000000"`,
      { key },
    );
  }
  return value;
};

/**
 * Resolve the mandate: the file's `policy` block, with the mode overridable from
 * the environment so a service manager can set it without rewriting the file.
 *
 * The caps are file-only. They are the part an operator should have to write down
 * and be able to read back, and a notional ceiling that lives in an environment
 * nobody can inspect after the fact is not a reviewable mandate.
 */
const resolvePolicy = (
  env: RunnerEnv,
  raw: unknown,
  where: string,
  filePath: string | null,
): RunnerPolicyConfig => {
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
    throw new RunnerConfigError('CONFIG_INVALID', `\`policy\` in ${where} must be a JSON object`, {
      key: 'policy',
    });
  }
  const block = (raw ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(block)) {
    if (!RUNNER_POLICY_KEYS.includes(key)) {
      throw new RunnerConfigError(
        'CONFIG_INVALID',
        `\`policy.${key}\` in ${where} is not a known Runner policy setting; known settings: ${RUNNER_POLICY_KEYS.join(', ')}`,
        { key: `policy.${key}` },
      );
    }
  }

  const envMode = asString(env[RUNNER_ENV_KEYS.policyMode], RUNNER_ENV_KEYS.policyMode, 'the environment');
  const fileMode = asString(block['mode'], 'policy.mode', where);
  const named = envMode ?? fileMode;
  if (named !== undefined && !RUNNER_POLICY_MODES.includes(named as RunnerPolicyMode)) {
    // Refused at start-up rather than at the first strategy: an unrecognized
    // authority is not an authority, and an operator who typed `delegated_auto`
    // should learn it now instead of when a trigger fires.
    throw new RunnerConfigError(
      'CONFIG_INVALID',
      `policy mode \`${named}\` is not one this build recognizes; known modes: ${RUNNER_POLICY_MODES.join(', ')}`,
      { key: 'policy.mode', mode: named },
    );
  }

  const maxOrderNotional = asDecimal(block['maxOrderNotional'], 'policy.maxOrderNotional', where);
  const notAfter = asString(block['notAfter'], 'policy.notAfter', where);
  if (notAfter !== undefined && !isIsoInstant(notAfter)) {
    throw new RunnerConfigError(
      'CONFIG_INVALID',
      `\`policy.notAfter\` in ${where} must be an ISO-8601 instant with a zone (e.g. 2026-08-24T12:00:00Z), got ${notAfter}`,
      { key: 'policy.notAfter' },
    );
  }

  return {
    mode: (named ?? 'interactive') as RunnerPolicyMode,
    // Named precisely, because this string is what an audit reads back off the
    // job to answer "who said this Runner could sign that".
    source:
      envMode !== undefined
        ? `env:${RUNNER_ENV_KEYS.policyMode}`
        : fileMode !== undefined && filePath !== null
          ? `file:${filePath}`
          : 'default:interactive',
    ...(maxOrderNotional === undefined ? {} : { maxOrderNotional }),
    ...(notAfter === undefined ? {} : { notAfter }),
  };
};

/* ── The resolver ──────────────────────────────────────────────────────────── */

export const resolveRunnerConfig = (sources: RunnerConfigSources): RunnerConfig => {
  const env = sources.env;
  const runtimeDir =
    asString(env[RUNNER_ENV_KEYS.runtimeDir], RUNNER_ENV_KEYS.runtimeDir, 'the environment') ??
    join(sources.homeDir() ?? '.', '.waterx', 'runner');
  const { path, config } = readConfigFile(sources, configPathFor(sources, runtimeDir));
  const where = path ?? 'the config file';
  const warnings: string[] = [];

  const storePath =
    asString(env[RUNNER_ENV_KEYS.storePath], RUNNER_ENV_KEYS.storePath, 'the environment') ??
    join(runtimeDir, 'jobs.sqlite');

  const baseUrl = (
    asString(env[RUNNER_ENV_KEYS.baseUrl], RUNNER_ENV_KEYS.baseUrl, 'the environment') ??
    asString(config.baseUrl, 'baseUrl', where)
  )?.replace(/\/+$/u, '');
  const agentWallet =
    asString(env[RUNNER_ENV_KEYS.agentWallet], RUNNER_ENV_KEYS.agentWallet, 'the environment') ??
    asString(config.agentWallet, 'agentWallet', where);
  const signerCommand =
    asCommand(env[RUNNER_ENV_KEYS.signerCommand], RUNNER_ENV_KEYS.signerCommand, 'the environment') ??
    asCommand(config.signerCommand, 'signerCommand', where);
  const signerTimeoutMs =
    asInteger(
      env[RUNNER_ENV_KEYS.signerTimeoutMs],
      RUNNER_ENV_KEYS.signerTimeoutMs,
      'the environment',
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    ) ??
    asInteger(config.signerTimeoutMs, 'signerTimeoutMs', where, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS) ??
    DEFAULT_SIGNER_TIMEOUT_MS;

  const warning = plaintextWarning(baseUrl);
  if (warning !== null) warnings.push(warning);

  // Ordered, and computed from the same values the driver is built from, so a
  // diagnostic and a `driverGaps` reply can never disagree about what is missing.
  const gaps: RunnerDriverGap[] = [];
  if (baseUrl === undefined) gaps.push('base-url');
  if (agentWallet === undefined) gaps.push('agent-wallet');
  if (signerCommand === undefined) gaps.push('signer-command');

  return {
    runtimeDir,
    storePath,
    configPath: path,
    // All three or none. There is no half-driver: see this file's header.
    driver:
      baseUrl === undefined || agentWallet === undefined || signerCommand === undefined
        ? undefined
        : { baseUrl, agentWallet, signerCommand, signerTimeoutMs },
    gaps,
    resolved: { baseUrl, agentWallet, signerCommand },
    tickIntervalMs:
      asInteger(
        env[RUNNER_ENV_KEYS.tickIntervalMs],
        RUNNER_ENV_KEYS.tickIntervalMs,
        'the environment',
        MIN_TICK_MS,
        MAX_TICK_MS,
      ) ?? asInteger(config.tickIntervalMs, 'tickIntervalMs', where, MIN_TICK_MS, MAX_TICK_MS),
    maxJobs:
      asInteger(env[RUNNER_ENV_KEYS.maxJobs], RUNNER_ENV_KEYS.maxJobs, 'the environment', 1, MAX_JOBS_CEILING) ??
      asInteger(config.maxJobs, 'maxJobs', where, 1, MAX_JOBS_CEILING),
    policy: resolvePolicy(env, config.policy, where, path),
    warnings,
  };
};

/**
 * What a resolved configuration is safe to print at start-up.
 *
 * The keystore executable appears by **base name only**: a full argv may hold a
 * path that identifies the operator, a hardware token slot, or an account label,
 * and this line goes to stderr where a service manager archives it. The agent
 * wallet is a public address and is printed in full, because an operator
 * debugging two Runners against one store needs to see which is which.
 */
export interface RunnerConfigDiagnostics {
  readonly runtimeDir: string;
  readonly storePath: string;
  readonly configPath: string | null;
  readonly baseUrl: string | null;
  readonly agentWallet: string | null;
  /** The executable's base name, never the argv. `null` when none is configured. */
  readonly signerExecutable: string | null;
  readonly driverConfigured: boolean;
  readonly gaps: readonly RunnerDriverGap[];
  /**
   * The mandate, printed in full: none of it is a credential, and an operator
   * whose Runner refuses to arm a strategy needs to see the mode that refused.
   * `admitsStrategies` is the same fact stated the way an operator asks it.
   */
  readonly policy: RunnerPolicyConfig & { readonly admitsStrategies: boolean };
  readonly warnings: readonly string[];
}

export const describeRunnerConfig = (config: RunnerConfig): RunnerConfigDiagnostics => {
  // From `resolved`, not from `driver`: what an operator set is worth printing
  // even when it did not add up to a driver, because that is how they find the
  // line they still have to write.
  const executable = config.resolved.signerCommand?.[0];
  return {
    runtimeDir: config.runtimeDir,
    storePath: config.storePath,
    configPath: config.configPath,
    baseUrl: config.resolved.baseUrl ?? null,
    agentWallet: config.resolved.agentWallet ?? null,
    signerExecutable: executable === undefined ? null : (executable.split('/').pop() ?? executable),
    driverConfigured: config.driver !== undefined,
    gaps: config.gaps,
    policy: { ...config.policy, admitsStrategies: config.policy.mode === 'delegated-auto' },
    warnings: config.warnings,
  };
};

/** Read the config file with the real filesystem, treating "absent" as `null`. */
export const createNodeRunnerConfigSources = (
  env: RunnerEnv,
  readFileSync: (path: string, encoding: 'utf8') => string,
): RunnerConfigSources => ({
  env,
  readFile: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch (error: unknown) {
      const code = (error as { code?: string } | null)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw new RunnerConfigError(
        'CONFIG_INVALID',
        `could not read the Runner config at ${path}: ${code ?? 'read failed'}`,
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
});
