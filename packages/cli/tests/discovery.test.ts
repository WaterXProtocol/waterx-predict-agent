/**
 * Discovery must work on a machine where nothing else does.
 *
 * `describe` and `command-schema` are how an unfamiliar host learns what this
 * runtime is before it can possibly be configured. If either needed a base URL,
 * a signer or a network, the first thing a new agent would meet is a failure it
 * has no way to interpret.
 */
import { describe, expect, it } from 'vitest';

import { CLI_VERSION, EXIT_CODES } from '../src/index.ts';
import { BASE_URL, CONFIGURED_ENV, invoke } from './harness.ts';
import manifest from '../package.json' with { type: 'json' };

interface Described {
  runtime: { name: string; version: string; node: string; supportedPlatforms: string[] };
  api: { configured: boolean; baseUrl: string | null; deploymentSource: string; version: string };
  signer: { configured: boolean; canSignTransactions: boolean; policy: string };
  policy: {
    mode: string;
    source: string;
    enforced: boolean;
    writesAllowed: boolean;
    approval: { required: boolean; isNotAuthentication?: string };
  };
  capabilities: { id: string; status: string }[];
  exitCodes: { name: string; code: number; meaning: string }[];
  serverCapabilities: {
    source: string;
    note: string;
    marketTextSearch: boolean;
    cursorPagination: boolean;
  };
  limitations: string[];
  commandContract: { commandCount: number; schemaVersion: string };
}

describe('describe', () => {
  it('answers with no configuration, no signer and no network', async () => {
    const result = await invoke(['describe']);
    const data = result.envelope.data as Described;

    expect(result.exit).toBe(EXIT_CODES.OK);
    expect(result.fetches).toHaveLength(0);
    expect(result.signerRuns).toHaveLength(0);
    // Nothing named means production — mainnet — by default (ADR-0011), and
    // `describe` says where that default came from. It still sends nothing.
    expect(data.api.configured).toBe(true);
    expect(data.api.baseUrl).toBe('https://api.waterx.app');
    expect(data.api.deploymentSource).toBe('DEFAULT');
    expect(result.envelope.meta?.warnings?.join(' ')).toMatch(/mainnet.*real funds/u);
    expect(data.signer.configured).toBe(false);
  });

  it('treats mainnet as a name for production, and warns only about a default', async () => {
    const result = await invoke(['describe'], {
      env: { WATERX_PREDICT_ENVIRONMENT: 'mainnet', WATERX_PREDICT_POLICY: 'interactive' },
    });
    const data = result.envelope.data as Described;
    expect(data.api.baseUrl).toBe('https://api.waterx.app');
    expect(data.api.deploymentSource).toBe('NAMED');
    expect(result.envelope.meta).toBeUndefined();
  });

  it('places nothing on mainnet until the operator says it may (ADR-0017)', async () => {
    const mainnet = await invoke(['describe'], { env: { WATERX_PREDICT_ENVIRONMENT: 'mainnet' } });
    const data = mainnet.envelope.data as Described;
    expect(data.policy).toMatchObject({ mode: 'read-only', source: 'DEFAULT', writesAllowed: false });
    // The warning rides on every answer, so it names a COMMAND: an `export` is
    // advice a tool host cannot follow (ADR-0021).
    const warning = mainnet.envelope.meta?.warnings?.join(' ') ?? '';
    expect(warning).toMatch(/read-only on mainnet.*waterx-predict policy/u);
    expect(warning).not.toMatch(/WATERX_PREDICT_POLICY=/u);

    // Testnet, and a host whose network nobody named, keep the interactive default.
    const testnet = (await invoke(['describe'], { env: { WATERX_PREDICT_ENVIRONMENT: 'testnet' } })).envelope
      .data as Described;
    expect(testnet.policy).toMatchObject({ mode: 'interactive', source: 'DEFAULT' });
  });

  it('does not send a label it does not know to mainnet', async () => {
    // Somebody named a network. That it is not one this build knows is no
    // reason to trade on production instead.
    const result = await invoke(['describe'], { env: { WATERX_PREDICT_ENVIRONMENT: 'staging' } });
    const data = result.envelope.data as Described;
    expect(data.api.configured).toBe(false);
    expect(data.api.baseUrl).toBeNull();
    expect(data.api.deploymentSource).toBe('NONE');
  });

  it('defaults to the interactive policy off mainnet and says an approval is not authentication', async () => {
    const data = (await invoke(['describe'], { env: { WATERX_PREDICT_ENVIRONMENT: 'testnet' } })).envelope
      .data as Described;

    expect(data.policy.mode).toBe('interactive');
    expect(data.policy.source).toBe('DEFAULT');
    expect(data.policy.enforced).toBe(true);
    expect(data.policy.writesAllowed).toBe(true);
    expect(data.policy.approval.required).toBe(true);
    // The load-bearing disclaimer: a host that read this as authentication would
    // build a human-in-the-loop guarantee on top of a value any caller can
    // compute. It has to be stated where the policy is reported.
    expect(data.policy.approval.isNotAuthentication).toMatch(/not that a person saw/iu);
  });

  it('reports a narrowed policy as read-only, and the signer as unable to sign', async () => {
    const configured = (await invoke(['describe'], { env: CONFIGURED_ENV })).envelope
      .data as Described;
    expect(configured.signer.canSignTransactions).toBe(true);

    const narrowed = (
      await invoke(['describe', '--policy', 'read-only'], { env: CONFIGURED_ENV })
    ).envelope.data as Described;

    expect(narrowed.policy.mode).toBe('read-only');
    expect(narrowed.policy.source).toBe('FLAG');
    expect(narrowed.policy.writesAllowed).toBe(false);
    // Not a promise to behave: `signTransaction` throws before it spawns.
    expect(narrowed.signer.canSignTransactions).toBe(false);
  });

  it('claims only the platforms the plan has committed to', async () => {
    const data = (await invoke(['describe'])).envelope.data as Described;
    expect(data.runtime.supportedPlatforms).toEqual(['darwin', 'linux']);
  });

  it('labels its server-capability claims as its own, not as the server’s', async () => {
    const data = (await invoke(['describe'])).envelope.data as Described;

    // The flags are this build's beliefs about the API and move as the server
    // grows — `marketTextSearch` became true when B2 landed. What must never
    // move is the label: nothing here was advertised by a server, so a caller
    // that hits a disagreement should believe the server's error, not this.
    expect(data.serverCapabilities.source).toBe('STATIC');
    expect(data.serverCapabilities.note).toMatch(/not something the server advertised/u);
  });

  it('reports cursor paging as available, because the server grew it', async () => {
    const data = (await invoke(['describe'])).envelope.data as Described;

    expect(data.serverCapabilities.cursorPagination).toBe(true);
    // And says plainly where it does NOT apply, so an agent does not go looking
    // for a cursor on the catalog and read its absence as a bug.
    expect(data.limitations.join(' ')).toMatch(/catalog pages by `limit` only/u);
  });

  it('publishes the exit-code table so a caller need not hard-code it', async () => {
    const data = (await invoke(['describe'])).envelope.data as Described;

    expect(data.exitCodes.length).toBeGreaterThan(5);
    expect(data.exitCodes.find((entry) => entry.name === 'OK')?.code).toBe(EXIT_CODES.OK);
    // Every entry explains itself, so a caller branching on a number is not guessing.
    for (const entry of data.exitCodes) expect(entry.meaning.length).toBeGreaterThan(0);
  });

  it('lists what it cannot do alongside what it can', async () => {
    const data = (await invoke(['describe'])).envelope.data as Described;

    const limitations = data.limitations.join(' ');
    expect(limitations).toMatch(/cannot be cancelled/iu);
    expect(limitations).toMatch(/never atomic/iu);
    expect(data.capabilities.some((entry) => entry.status !== 'AVAILABLE')).toBe(true);
  });

  it('reports the configuration it did find', async () => {
    const data = (
      await invoke(['describe'], { env: { WATERX_PREDICT_BASE_URL: BASE_URL } })
    ).envelope.data as Described;

    expect(data.api.configured).toBe(true);
    expect(data.api.baseUrl).toBe(BASE_URL);
  });

  it('reports the version the package actually ships', async () => {
    const data = (await invoke(['describe'])).envelope.data as Described;

    expect(data.runtime.version).toBe(CLI_VERSION);
    expect(CLI_VERSION).toBe(manifest.version);
  });
});

describe('command-schema', () => {
  it('returns the whole contract without configuration', async () => {
    const result = await invoke(['command-schema']);
    const data = result.envelope.data as { commands: { name: string }[]; $defs: object };

    expect(result.exit).toBe(EXIT_CODES.OK);
    expect(result.fetches).toHaveLength(0);
    expect(data.commands.length).toBeGreaterThan(5);
    expect(data.$defs).toBeTypeOf('object');
  });

  it('returns one command with its definitions still attached', async () => {
    const result = await invoke(['command-schema', '--command', 'market.quote']);
    const data = result.envelope.data as { commands: { name: string }[]; $defs: object };

    expect(data.commands).toHaveLength(1);
    expect(data.commands[0]?.name).toBe('market.quote');
    // Without $defs the fragment would carry unresolvable $refs.
    expect(Object.keys(data.$defs).length).toBeGreaterThan(0);
  });

  it('rejects a command name it does not have', async () => {
    const result = await invoke(['command-schema', '--command', 'order.teleport']);

    expect(result.envelope.error?.code).toBe('UNKNOWN_COMMAND');
    expect(result.exit).toBe(EXIT_CODES.USAGE);
  });

  it('agrees with describe about how many commands exist', async () => {
    const described = (await invoke(['describe'])).envelope.data as Described;
    const schema = (await invoke(['command-schema'])).envelope.data as {
      commands: unknown[];
      schemaVersion: string;
    };

    expect(described.commandContract.commandCount).toBe(schema.commands.length);
    expect(described.commandContract.schemaVersion).toBe(schema.schemaVersion);
  });
});

describe('--version', () => {
  it('answers in the envelope rather than as bare text', async () => {
    const result = await invoke(['--version']);

    expect(result.envelope.ok).toBe(true);
    expect(result.envelope.data).toEqual({ name: 'waterx-predict', version: CLI_VERSION });
    expect(result.exit).toBe(EXIT_CODES.OK);
  });
});
