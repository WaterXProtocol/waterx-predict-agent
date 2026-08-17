/**
 * The signer boundary.
 *
 * Three properties here are worth more than the rest of the file put together.
 *
 * First: under a read-only policy `signTransaction` is refused locally, before a
 * process is spawned. A runtime that merely never calls the write path is one
 * bug away from calling it; this one cannot produce a transaction signature.
 *
 * Second: with any other policy, signing a transaction still costs a PERMIT from
 * the signing gate. A code path that reaches the signer without having been
 * authorized does not skip a check — it runs out of permits and refuses.
 *
 * Third: a signer that misbehaves produces an error, never a guess. An empty
 * stdout, a non-zero exit, a hang — each must end the invocation, because the
 * alternative is authenticating with something the key holder did not sign.
 */
import { describe, expect, it, vi } from 'vitest';

import { CliError, describeSigner, EXIT_CODES, loadConfig } from '../src/index.ts';
import { SigningGate, type WriteAuthorization } from '../src/policy.ts';
import { createSigner, SIGNER_PROTOCOL, type SignerRunner } from '../src/signer.ts';
import { AGENT_WALLET, AUTH_OK, CONFIGURED_ENV, invoke } from './harness.ts';

const MARKETS_OK = { status: 200, body: { markets: [] } } as const;

/** Resolved the way a real invocation resolves it, minus the filesystem. */
const configFrom = (env: Record<string, string> = CONFIGURED_ENV) =>
  loadConfig({ env, readFile: () => null, homeDir: () => null });

const runnerReturning = (
  result: Partial<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>,
) =>
  vi.fn<SignerRunner>(() =>
    Promise.resolve({
      code: result.code ?? 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      timedOut: result.timedOut ?? false,
    }),
  );

const READ_ONLY_ENV = { ...CONFIGURED_ENV, WATERX_PREDICT_POLICY: 'read-only' };

const authorization = (permits: number): WriteAuthorization => ({
  permits,
  basis: 'INTERACTIVE_APPROVAL',
  token: 'apv1_test',
  checks: [],
});

describe('policy enforcement in the signer', () => {
  it('refuses to sign a transaction under read-only, without starting the signer', async () => {
    const run = runnerReturning({ stdout: '{"signature":"never-reached"}' });
    const gate = new SigningGate('read-only');
    const signer = createSigner(configFrom(READ_ONLY_ENV), run, () => undefined, gate);

    await expect(signer.signTransaction(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      details: { policy: 'read-only' },
    });
    // The decisive assertion: the key holder was never even asked.
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses under any policy when no order authorized the signature', async () => {
    const run = runnerReturning({ stdout: '{"signature":"never-reached"}' });
    // Interactive, gate installed, and nothing granted: the write path was
    // reached without an authorization, which is the bug this gate exists for.
    const signer = createSigner(configFrom(), run, () => undefined, new SigningGate('interactive'));

    await expect(signer.signTransaction(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('spends exactly one permit per transaction, and no more than were granted', async () => {
    const run = runnerReturning({ stdout: '{"signature":"sig-tx"}' });
    const gate = new SigningGate('interactive');
    gate.grant(authorization(1));
    const signer = createSigner(configFrom(), run, () => undefined, gate);

    const signed = await signer.signTransaction(new Uint8Array([7]));
    expect(signed.signature).toBe('sig-tx');
    expect(JSON.parse(run.mock.calls[0]?.[1] ?? '{}')).toMatchObject({ type: 'TRANSACTION' });
    expect(gate.stats).toEqual({ granted: 1, used: 1, unused: 0 });

    // One approved order buys one signature. The second is refused, and the
    // signer is not started for it.
    await expect(signer.signTransaction(new Uint8Array([8]))).rejects.toMatchObject({
      code: 'POLICY_DENIED',
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('never grants a permit under read-only, even when a command asks for one', () => {
    const gate = new SigningGate('read-only');
    expect(() => gate.grant(authorization(1))).toThrow(CliError);
  });

  it('still signs a personal message, which is what the login challenge is', async () => {
    const run = runnerReturning({ stdout: '{"signature":"sig-abc"}' });
    const signed = await createSigner(configFrom(), run, () => undefined).signPersonalMessage(
      new Uint8Array([1, 2, 3]),
    );

    expect(signed.signature).toBe('sig-abc');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('sends the signer a versioned request that says what is being signed', async () => {
    const run = runnerReturning({ stdout: '{"signature":"s"}' });
    await createSigner(configFrom(), run, () => undefined).signPersonalMessage(
      new Uint8Array([9, 9]),
    );

    // A signer that cannot see the type cannot refuse the type it does not want.
    const request = JSON.parse(run.mock.calls[0]?.[1] ?? '{}') as Record<string, unknown>;
    expect(request).toMatchObject({
      version: 1,
      type: 'PERSONAL_MESSAGE',
      agentWallet: AGENT_WALLET,
    });
    expect(request.messageBase64).toBe(Buffer.from([9, 9]).toString('base64'));
  });

  it('writes exactly the fields the protocol descriptor claims, for both kinds', async () => {
    // What makes SIGNER_PROTOCOL a claim rather than a comment. The Runner
    // asserts the same thing about its own request, and `tests/workspace.test.ts`
    // asserts the two descriptors are equal — so an operator who configured one
    // keystore command for the CLI can point the Runner at it unchanged.
    const gate = new SigningGate('interactive');
    gate.grant(authorization(1));
    const run = runnerReturning({ stdout: '{"signature":"s"}' });
    const signer = createSigner(configFrom(), run, () => undefined, gate);

    await signer.signPersonalMessage(new Uint8Array([1]));
    await signer.signTransaction(new Uint8Array([2]));

    for (const [index, expected] of SIGNER_PROTOCOL.requests.entries()) {
      const written = JSON.parse(run.mock.calls[index]?.[1] ?? '{}') as Record<string, unknown>;
      expect(written.type, expected.type).toBe(expected.type);
      // Exactly these keys: an extra one is an undocumented field a provider
      // cannot know to check, and a missing one is a promise this file broke.
      expect(Object.keys(written).sort(), expected.type).toEqual([...expected.fields].sort());
    }
    expect(SIGNER_PROTOCOL.response.fields).toEqual(['signature']);
  });

  it('reports the address it was configured with rather than deriving one', () => {
    // Deriving would need the key, which is exactly what never enters this process.
    expect(createSigner(configFrom(), runnerReturning({}), () => undefined).toSuiAddress()).toBe(
      AGENT_WALLET,
    );
  });
});

describe('a signer that misbehaves', () => {
  const cases: { name: string; result: Parameters<typeof runnerReturning>[0]; match: RegExp }[] = [
    {
      name: 'exits non-zero',
      result: { code: 3, stdout: '{"signature":"ignored"}' },
      match: /exited with status 3/u,
    },
    {
      name: 'writes something that is not JSON',
      result: { stdout: 'ok, signed!\n' },
      match: /did not write JSON/u,
    },
    { name: 'writes nothing at all', result: { stdout: '' }, match: /did not write JSON/u },
    {
      name: 'writes JSON with no signature',
      result: { stdout: '{"status":"ok"}' },
      match: /no `signature` string/u,
    },
    {
      name: 'writes an empty signature',
      result: { stdout: '{"signature":""}' },
      match: /no `signature` string/u,
    },
    {
      name: 'never responds',
      result: { timedOut: true, stdout: '{"signature":"late"}' },
      match: /did not respond within/u,
    },
  ];

  for (const testCase of cases) {
    it(`fails when the signer ${testCase.name}`, async () => {
      const signer = createSigner(configFrom(), runnerReturning(testCase.result), () => undefined);

      // Never a fabricated signature, and never a silent success.
      await expect(signer.signPersonalMessage(new Uint8Array([1]))).rejects.toMatchObject({
        code: 'SIGNER_FAILED',
      });
      await expect(signer.signPersonalMessage(new Uint8Array([1]))).rejects.toThrow(testCase.match);
    });
  }

  it('surfaces a signer failure as an authentication failure, not an internal error', async () => {
    const result = await invoke(['market', 'list'], {
      env: CONFIGURED_ENV,
      signer: () => ({ code: 1, stderr: 'keystore locked' }),
      routes: {
        'POST /agent-api/v1/auth': AUTH_OK,
        'GET /agent-api/v1/predict/markets': MARKETS_OK,
      },
    });

    expect(result.envelope.error?.code).toBe('SIGNER_FAILED');
    expect(result.envelope.error?.source).toBe('CLI');
    expect(result.exit).toBe(EXIT_CODES.AUTH);
    // Nothing was read, because nothing was authenticated.
    expect(result.fetches.some((call) => call.url.endsWith('/markets'))).toBe(false);
  });

  it('routes the signer’s own diagnostics to stderr and keeps stdout parseable', async () => {
    const result = await invoke(['market', 'list'], {
      env: CONFIGURED_ENV,
      signer: () => ({
        stdout: JSON.stringify({ signature: 'sig' }),
        stderr: 'unlocking /etc/waterx/agent.key',
      }),
      routes: {
        'POST /agent-api/v1/auth': AUTH_OK,
        'GET /agent-api/v1/predict/markets': MARKETS_OK,
      },
    });

    expect(result.stderr).toContain('signer stderr');
    expect(result.writes).toBe(1);
    expect(result.envelope.ok).toBe(true);
    expect(result.stdout).not.toContain('agent.key');
  });
});

describe('a signer that is not there', () => {
  it('refuses to build without a command, and says which setting is missing', () => {
    const config = configFrom({ WATERX_PREDICT_BASE_URL: 'https://x.invalid' });

    expect(() => createSigner(config, runnerReturning({}), () => undefined)).toThrow(CliError);
    expect(() => createSigner(config, runnerReturning({}), () => undefined)).toThrow(
      /WATERX_PREDICT_SIGNER_COMMAND/u,
    );
  });

  it('refuses to build without a wallet rather than guessing one', () => {
    const config = configFrom({
      WATERX_PREDICT_BASE_URL: 'https://x.invalid',
      WATERX_PREDICT_SIGNER_COMMAND: '/bin/sign',
    });

    expect(() => createSigner(config, runnerReturning({}), () => undefined)).toThrow(
      /agent wallet/u,
    );
  });

  it('exits on configuration, not on transport, when an authenticated read is attempted', async () => {
    const result = await invoke(['market', 'list'], {
      env: { WATERX_PREDICT_BASE_URL: 'https://x.invalid' },
    });

    expect(result.envelope.error?.code).toBe('SIGNER_UNAVAILABLE');
    expect(result.exit).toBe(EXIT_CODES.CONFIG);
    expect(result.fetches).toHaveLength(0);
  });
});

describe('describeSigner', () => {
  it('reports transaction signing from the policy, not from wishful thinking', () => {
    expect(describeSigner(configFrom()).canSignTransactions).toBe(true);
    expect(describeSigner(configFrom(READ_ONLY_ENV)).canSignTransactions).toBe(false);
  });

  it('names the executable by base name only, because an argument may be a path', () => {
    const described = describeSigner(
      configFrom({
        ...CONFIGURED_ENV,
        WATERX_PREDICT_SIGNER_COMMAND: '["/opt/waterx/sign","--key","/etc/waterx/agent.key"]',
      }),
    );

    expect(described.executable).toBe('sign');
    expect(JSON.stringify(described)).not.toContain('agent.key');
  });

  it('says what to set when nothing is configured', () => {
    const described = describeSigner(configFrom({}));

    expect(described.kind).toBe('NONE');
    expect(described.configured).toBe(false);
    expect(described.note).toMatch(/WATERX_PREDICT_SIGNER_COMMAND/u);
  });
});
