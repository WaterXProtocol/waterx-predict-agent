/**
 * What a `runnerd` process will and will not accept as its configuration.
 *
 * Three properties carry weight here and each is asserted against the surface
 * rather than against a comment:
 *
 *   1. **No credential ever enters this process through configuration.** There is
 *      no token variable to set, a credential-shaped key at any depth of the file
 *      is a hard refusal, and the refusal names the key path and never the value.
 *   2. **All three or none.** `driver` is present exactly when `gaps` is empty,
 *      because a Runner with a gateway and no signer would create an order it
 *      could not authorize.
 *   3. **The start-up diagnostic is safe to archive.** The keystore appears by
 *      base name, never as an argv that may carry a slot or an account label.
 *
 * The filesystem and the environment are both injected, so nothing here reads a
 * real file or depends on the machine it runs on.
 */
import { describe, expect, it } from 'vitest';

import {
  describeRunnerConfig,
  isRunnerConfigError,
  resolveRunnerConfig,
  RUNNER_ENV_KEYS,
  RUNNER_FILE_KEYS,
  type RunnerConfig,
  type RunnerConfigSources,
  type RunnerEnv,
} from '../src/config.ts';

const DIR = '/tmp/waterx-runner-test';
const WALLET = '0xagent';
const URL_ = 'https://predict.example/api';

const sources = (env: RunnerEnv, files: Readonly<Record<string, string>> = {}): RunnerConfigSources => ({
  env,
  readFile: (path) => files[path] ?? null,
  homeDir: () => '/home/tester',
});

const fileAt = (dir = DIR): string => `${dir}/runner.json`;

const complete = (overrides: Readonly<Record<string, unknown>> = {}): RunnerEnv => ({
  [RUNNER_ENV_KEYS.runtimeDir]: DIR,
  [RUNNER_ENV_KEYS.baseUrl]: URL_,
  [RUNNER_ENV_KEYS.agentWallet]: WALLET,
  [RUNNER_ENV_KEYS.signerCommand]: '/opt/keystore/bin/waterx-sign',
  ...overrides,
});

const resolve = (env: RunnerEnv, files?: Readonly<Record<string, string>>): RunnerConfig =>
  resolveRunnerConfig(sources(env, files));

const refusal = (env: RunnerEnv, files?: Readonly<Record<string, string>>): Error => {
  try {
    resolve(env, files);
  } catch (error: unknown) {
    return error as Error;
  }
  throw new Error('expected the configuration to be refused');
};

describe('no credential reaches this process through configuration', () => {
  it('names no session-token variable at all', () => {
    // Not "is unset" — absent from the surface. A seven-day strategy outlives any
    // token, so a Runner handed one would go blind halfway through a mandate it
    // still holds; it authenticates itself through the keystore instead.
    const names = Object.values(RUNNER_ENV_KEYS).join(' ').toLowerCase();
    expect(names).not.toMatch(/token|secret|private|key(?!store)/u);
    expect(RUNNER_FILE_KEYS.join(' ').toLowerCase()).not.toMatch(/token|secret|private/u);
  });

  it('refuses a credential-shaped key and quotes the path, never the value', () => {
    const secret = 'suiprivkey1qqqqqqqqqqqqqqqqqqqqqqqq';
    const error = refusal(complete(), {
      [fileAt()]: JSON.stringify({ privateKey: secret }),
    });

    expect(isRunnerConfigError(error)).toBe(true);
    expect(isRunnerConfigError(error) && error.code).toBe('CONFIG_CONTAINS_SECRET');
    expect(isRunnerConfigError(error) && error.detail?.['key']).toBe('privateKey');
    // Serialized whole, so a future field that carried the value fails here.
    expect(JSON.stringify({ message: error.message, detail: (error as { detail?: unknown }).detail })).not.toContain(
      secret,
    );
  });

  it('finds a credential nested below the top level', () => {
    const error = refusal(complete(), {
      [fileAt()]: JSON.stringify({ signerCommand: { env: { KEYSTORE_PASSPHRASE: 'hunter2' } } }),
    });
    expect(isRunnerConfigError(error) && error.code).toBe('CONFIG_CONTAINS_SECRET');
    expect(isRunnerConfigError(error) && error.detail?.['key']).toBe('signerCommand.env.KEYSTORE_PASSPHRASE');
  });

  it('calls a credential a credential rather than a typo', () => {
    // `privateKey` is not a known setting *and* is credential-shaped. The two
    // refusals send an operator to different places, so the order matters.
    const error = refusal(complete(), { [fileAt()]: JSON.stringify({ privateKey: 'x' }) });
    expect(isRunnerConfigError(error) && error.code).toBe('CONFIG_CONTAINS_SECRET');
  });
});

describe('all three or none', () => {
  it('builds a driver when every piece is present', () => {
    const config = resolve(complete());
    expect(config.gaps).toEqual([]);
    expect(config.driver).toEqual({
      baseUrl: URL_,
      agentWallet: WALLET,
      signerCommand: ['/opt/keystore/bin/waterx-sign'],
      signerTimeoutMs: 15_000,
    });
  });

  it.each([
    [RUNNER_ENV_KEYS.baseUrl, 'base-url'],
    [RUNNER_ENV_KEYS.agentWallet, 'agent-wallet'],
    [RUNNER_ENV_KEYS.signerCommand, 'signer-command'],
  ])('withholds the whole driver when %s is missing', (key, gap) => {
    const env = { ...complete() } as Record<string, string | undefined>;
    delete env[key];
    const config = resolve(env);

    expect(config.driver).toBeUndefined();
    expect(config.gaps).toContain(gap);
  });

  it('names every missing piece, in a stable order', () => {
    const config = resolve({ [RUNNER_ENV_KEYS.runtimeDir]: DIR });
    expect(config.gaps).toEqual(['base-url', 'agent-wallet', 'signer-command']);
    expect(config.driver).toBeUndefined();
  });

  it('keeps `driver` present exactly when `gaps` is empty', () => {
    for (const env of [complete(), { [RUNNER_ENV_KEYS.runtimeDir]: DIR }, complete({ [RUNNER_ENV_KEYS.agentWallet]: undefined })]) {
      const config = resolve(env);
      expect(config.driver === undefined).toBe(config.gaps.length > 0);
    }
  });
});

describe('precedence and file handling', () => {
  it('prefers the environment over the file', () => {
    const config = resolve(complete({ [RUNNER_ENV_KEYS.baseUrl]: URL_ }), {
      [fileAt()]: JSON.stringify({ baseUrl: 'https://stale.example' }),
    });
    expect(config.driver?.baseUrl).toBe(URL_);
    expect(config.configPath).toBe(fileAt());
  });

  it('reads the file when the environment says nothing', () => {
    const config = resolve({ [RUNNER_ENV_KEYS.runtimeDir]: DIR }, {
      [fileAt()]: JSON.stringify({
        baseUrl: URL_,
        agentWallet: WALLET,
        signerCommand: ['/opt/keystore/bin/waterx-sign', '--slot', '3'],
        signerTimeoutMs: 30_000,
        tickIntervalMs: 500,
        maxJobs: 4,
      }),
    });
    expect(config.driver).toEqual({
      baseUrl: URL_,
      agentWallet: WALLET,
      signerCommand: ['/opt/keystore/bin/waterx-sign', '--slot', '3'],
      signerTimeoutMs: 30_000,
    });
    expect(config.tickIntervalMs).toBe(500);
    expect(config.maxJobs).toBe(4);
  });

  it('treats an absent default file as unconfigured, not as an error', () => {
    const config = resolve({ [RUNNER_ENV_KEYS.runtimeDir]: DIR });
    expect(config.configPath).toBeNull();
    expect(config.gaps.length).toBe(3);
  });

  it('refuses when an explicitly named config file is not there', () => {
    // Silently ignoring this would start a Runner that drives nothing while an
    // operator believes they configured one.
    const error = refusal({ [RUNNER_ENV_KEYS.runtimeDir]: DIR, [RUNNER_ENV_KEYS.configPath]: '/etc/waterx/absent.json' });
    expect(isRunnerConfigError(error) && error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain('/etc/waterx/absent.json');
  });

  it('refuses an unknown setting rather than ignoring it', () => {
    const error = refusal(complete(), { [fileAt()]: JSON.stringify({ baseUlr: URL_ }) });
    expect(isRunnerConfigError(error) && error.code).toBe('CONFIG_INVALID');
    expect(error.message).toContain('baseUlr');
  });

  it.each([['not json', '{'], ['not an object', '[]'], ['null', 'null']])(
    'refuses a config file that is %s',
    (_name, raw) => {
      const error = refusal(complete(), { [fileAt()]: raw });
      expect(isRunnerConfigError(error) && error.code).toBe('CONFIG_INVALID');
    },
  );

  it('defaults the runtime directory and the store under the home directory', () => {
    const config = resolve({});
    expect(config.runtimeDir).toBe('/home/tester/.waterx/runner');
    expect(config.storePath).toBe('/home/tester/.waterx/runner/jobs.sqlite');
  });
});

describe('a signer command is argv, never a shell string', () => {
  it('takes a bare executable name as a one-element argv', () => {
    expect(resolve(complete({ [RUNNER_ENV_KEYS.signerCommand]: 'waterx-sign' })).driver?.signerCommand).toEqual([
      'waterx-sign',
    ]);
  });

  it('never splits on spaces', () => {
    // A path with a space is a path, not two arguments. Splitting would quietly
    // change which program runs.
    const command = resolve(complete({ [RUNNER_ENV_KEYS.signerCommand]: '/opt/My Keys/sign' })).driver?.signerCommand;
    expect(command).toEqual(['/opt/My Keys/sign']);
  });

  it('accepts a JSON array for a command with arguments', () => {
    const command = resolve(
      complete({ [RUNNER_ENV_KEYS.signerCommand]: '["/opt/keystore/bin/sign","--slot","3"]' }),
    ).driver?.signerCommand;
    expect(command).toEqual(['/opt/keystore/bin/sign', '--slot', '3']);
  });

  it.each([['["unterminated"', 'malformed JSON'], ['[]', 'an empty argv'], ['["ok",""]', 'an empty element']])(
    'refuses %s (%s)',
    (raw) => {
      const error = refusal(complete({ [RUNNER_ENV_KEYS.signerCommand]: raw }));
      expect(isRunnerConfigError(error) && error.code).toBe('CONFIG_INVALID');
    },
  );
});

describe('bounds', () => {
  it.each([
    [RUNNER_ENV_KEYS.signerTimeoutMs, '999'],
    [RUNNER_ENV_KEYS.signerTimeoutMs, '600001'],
    [RUNNER_ENV_KEYS.tickIntervalMs, '10'],
    [RUNNER_ENV_KEYS.maxJobs, '0'],
    [RUNNER_ENV_KEYS.maxJobs, '1.5'],
  ])('refuses %s=%s', (key, value) => {
    const error = refusal(complete({ [key]: value }));
    expect(isRunnerConfigError(error) && error.code).toBe('CONFIG_INVALID');
  });

  it('leaves the daemon defaults alone when nothing is set', () => {
    const config = resolve(complete());
    expect(config.tickIntervalMs).toBeUndefined();
    expect(config.maxJobs).toBeUndefined();
  });

  it('trims a trailing slash off the base URL rather than doubling it later', () => {
    expect(resolve(complete({ [RUNNER_ENV_KEYS.baseUrl]: 'https://predict.example/api/' })).driver?.baseUrl).toBe(URL_);
  });
});

describe('warnings, which are not refusals', () => {
  it('warns about plaintext http to a remote host', () => {
    const config = resolve(complete({ [RUNNER_ENV_KEYS.baseUrl]: 'http://predict.example' }));
    expect(config.warnings.join(' ')).toContain('plaintext');
    expect(config.driver).toBeDefined();
  });

  it('says nothing about loopback, which is a normal test setup', () => {
    expect(resolve(complete({ [RUNNER_ENV_KEYS.baseUrl]: 'http://127.0.0.1:8080' })).warnings).toEqual([]);
  });
});

describe('the start-up diagnostic is safe to archive', () => {
  it('prints the keystore by base name and never the argv', () => {
    const config = resolve(
      complete({ [RUNNER_ENV_KEYS.signerCommand]: '["/home/tester/keys/slot-3/waterx-sign","--account","alice"]' }),
    );
    const printed = describeRunnerConfig(config);

    expect(printed.signerExecutable).toBe('waterx-sign');
    const serialized = JSON.stringify(printed);
    expect(serialized).not.toContain('slot-3');
    expect(serialized).not.toContain('alice');
  });

  it('reports the gaps it was given, not a guess', () => {
    const printed = describeRunnerConfig(resolve({ [RUNNER_ENV_KEYS.runtimeDir]: DIR }));
    expect(printed.driverConfigured).toBe(false);
    expect(printed.gaps).toEqual(['base-url', 'agent-wallet', 'signer-command']);
    expect(printed.signerExecutable).toBeNull();
    expect(printed.baseUrl).toBeNull();
  });

  it('still prints what an operator did set when the driver is incomplete', () => {
    // Printing `null` for everything whenever anything is missing reads as "none
    // of this took effect", and sends them to fix the line that was already right.
    const env = { ...complete() } as Record<string, string | undefined>;
    delete env[RUNNER_ENV_KEYS.agentWallet];
    const printed = describeRunnerConfig(resolve(env));

    expect(printed.driverConfigured).toBe(false);
    expect(printed.gaps).toEqual(['agent-wallet']);
    expect(printed.baseUrl).toBe(URL_);
    expect(printed.signerExecutable).toBe('waterx-sign');
    expect(printed.agentWallet).toBeNull();
  });

  it('prints the agent wallet, which is public and identifies the instance', () => {
    expect(describeRunnerConfig(resolve(complete())).agentWallet).toBe(WALLET);
  });
});
