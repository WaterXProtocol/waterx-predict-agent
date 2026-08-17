/**
 * The signer's contract, which is mostly a contract about refusing.
 *
 * Two properties carry the security of this module and each is asserted directly
 * rather than inferred:
 *
 *   1. **A refusal spawns nothing.** Every test that expects a refusal asserts
 *      the injected runner was never called. A gate checked after the child ran
 *      would already have produced the signature it exists to prevent, and a test
 *      that only checked the thrown error could not tell the two apart.
 *   2. **Nothing leaks.** The signature, the transaction bytes and the child's
 *      stdout appear in no error, no detail object and no diagnostic. Asserted by
 *      searching the serialized error for the values, so a future field that
 *      carried one would fail here rather than in an incident.
 *
 * No process is spawned in this file. `SignerRunner` is the seam; the fakes below
 * are legitimate implementations of it, which is what lets a test say "the
 * keystore timed out" without a keystore.
 */
import { describe, expect, it } from 'vitest';

import type { JobPolicySnapshot } from '../src/job.ts';
import {
  createExternalCommandAuthSigner,
  createExternalCommandSigner,
  isPreSpawnRefusal,
  isSignerError,
  refusePolicy,
  SIGNER_PROTOCOL,
  SignerError,
  type SignerRunResult,
  type SignerRunner,
} from '../src/signer.ts';
import type { StrategySignRequest } from '../src/strategy/gateway.ts';
import { later, T0 } from './harness.ts';

const BYTES = 'c3BvbnNvcmVkLXR4LWJ5dGVz';
const SIGNATURE = 'dGhlLXNpZ25hdHVyZQ==';
const WALLET = '0xagent';
const COMMAND = ['/opt/keystore/bin/waterx-sign', '--slot', '3'] as const;

const DELEGATED: JobPolicySnapshot = {
  mode: 'delegated-auto',
  source: 'file:~/.waterx/policy.json',
  maxOrderNotional: '100.000000',
};

const request = (overrides: Partial<StrategySignRequest> = {}): StrategySignRequest => ({
  jobId: 'job_1',
  legIndex: 0,
  agentWallet: WALLET,
  policy: DELEGATED,
  sponsoredTransactionBytes: BYTES,
  ...overrides,
});

interface Recorder {
  readonly runner: SignerRunner;
  readonly calls: { command: readonly string[]; stdin: string; timeoutMs: number }[];
}

/** Records every invocation, so "was a child started at all" is a real assertion. */
const recorder = (answer: SignerRunResult | Error = ok()): Recorder => {
  const calls: Recorder['calls'] = [];
  return {
    calls,
    runner: async (command, stdin, timeoutMs) => {
      calls.push({ command, stdin, timeoutMs });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
};

const ok = (overrides: Partial<SignerRunResult> = {}): SignerRunResult => ({
  code: 0,
  stdout: JSON.stringify({ signature: SIGNATURE }),
  stderr: '',
  timedOut: false,
  ...overrides,
});

interface Built {
  readonly sign: (
    request?: StrategySignRequest,
    signal?: AbortSignal,
  ) => Promise<string>;
  readonly calls: Recorder['calls'];
  readonly diagnostics: string[];
}

const build = (
  answer: SignerRunResult | Error = ok(),
  options: { now?: string; wallet?: string; timeoutMs?: number } = {},
): Built => {
  const run = recorder(answer);
  const diagnostics: string[] = [];
  const signer = createExternalCommandSigner({
    command: COMMAND,
    agentWallet: options.wallet ?? WALLET,
    run: run.runner,
    now: () => options.now ?? T0,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    onDiagnostic: (text) => diagnostics.push(text),
  });
  return {
    calls: run.calls,
    diagnostics,
    sign: async (input = request(), signal) => signer.sign(input, signal),
  };
};

/** The code, and the fact that nothing was started. Both, always. */
const refusedWithoutSpawning = async (
  built: Built,
  input: StrategySignRequest,
  code: string,
  signal?: AbortSignal,
): Promise<SignerError> => {
  const error = await built.sign(input, signal).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(isSignerError(error)).toBe(true);
  const signerError = error as SignerError;
  expect(signerError.code).toBe(code);
  expect(built.calls).toHaveLength(0);
  expect(isPreSpawnRefusal(signerError.code)).toBe(true);
  return signerError;
};

describe('the authority gate', () => {
  it('signs under a scoped delegated-auto policy, and sends exactly the protocol', async () => {
    const built = build();
    await expect(built.sign()).resolves.toBe(SIGNATURE);

    expect(built.calls).toHaveLength(1);
    const call = built.calls[0];
    expect(call?.command).toEqual(COMMAND);
    // One line, newline-terminated: a child reading a line gets a whole request.
    expect(call?.stdin.endsWith('\n')).toBe(true);
    expect(call?.stdin.split('\n').filter((line) => line !== '')).toHaveLength(1);

    const sent = JSON.parse(call?.stdin ?? '{}') as Record<string, unknown>;
    const expected = SIGNER_PROTOCOL.requests.find((entry) => entry.type === 'TRANSACTION');
    // The descriptor is a claim about behaviour: these are the keys, in order.
    expect(Object.keys(sent)).toEqual([...(expected?.fields ?? [])]);
    expect(sent).toEqual({
      version: 1,
      type: 'TRANSACTION',
      agentWallet: WALLET,
      transactionBytesBase64: BYTES,
    });
  });

  it('refuses an interactive job before spawning anything, because nobody is being asked', async () => {
    const built = build();
    const error = await refusedWithoutSpawning(
      built,
      request({ policy: { mode: 'interactive', source: 'default' } }),
      'POLICY_REQUIRES_APPROVAL',
    );
    // The remedy has to be in the message: an operator reading only the code
    // would reasonably try harder at the keystore.
    expect(error.message).toContain('delegated-auto');
    expect(error.detail).toMatchObject({ mode: 'interactive', jobId: 'job_1', legIndex: 0 });
  });

  it('refuses a read-only job before spawning anything', async () => {
    const built = build();
    await refusedWithoutSpawning(
      built,
      request({ policy: { mode: 'read-only', source: 'flag:--policy' } }),
      'POLICY_READ_ONLY',
    );
  });

  it('refuses a policy mode it does not recognize rather than treating it as permissive', async () => {
    const built = build();
    // A row a newer build wrote. The store is STRICT about types, not about the
    // vocabulary of a future release.
    await refusedWithoutSpawning(
      built,
      request({
        policy: { mode: 'delegated-auto-v2' as JobPolicySnapshot['mode'], source: 'file:x' },
      }),
      'POLICY_MODE_UNRECOGNIZED',
    );
  });

  it('re-reads notAfter at signing time, so a scope that ran out mid-pass does not sign', async () => {
    const expiry = later(T0, 60_000);
    // preflight read the same snapshot at T0 and let the pass proceed; the quote
    // and the create happened; the mandate ended while they were in flight.
    const built = build(ok(), { now: later(T0, 61_000) });
    const error = await refusedWithoutSpawning(
      built,
      request({ policy: { ...DELEGATED, notAfter: expiry } }),
      'POLICY_SCOPE_EXPIRED',
    );
    expect(error.detail).toMatchObject({ notAfter: expiry });
  });

  it('signs while the scope is still open, to the last instant', async () => {
    const expiry = later(T0, 60_000);
    const built = build(ok(), { now: later(T0, 59_999) });
    await expect(built.sign(request({ policy: { ...DELEGATED, notAfter: expiry } }))).resolves.toBe(
      SIGNATURE,
    );
  });

  it('is a pure, total function of the snapshot and the clock', () => {
    // Asserted on `refusePolicy` directly as well as through the signer: the rule
    // is the thing, and reading it off whether a fake spawned is indirect.
    expect(refusePolicy(DELEGATED, T0)).toBeUndefined();
    expect(refusePolicy({ mode: 'interactive', source: 's' }, T0)?.code).toBe(
      'POLICY_REQUIRES_APPROVAL',
    );
    expect(refusePolicy({ mode: 'read-only', source: 's' }, T0)?.code).toBe('POLICY_READ_ONLY');
    expect(refusePolicy({ ...DELEGATED, notAfter: T0 }, T0)?.code).toBe('POLICY_SCOPE_EXPIRED');
  });
});

describe('what else is refused before a child exists', () => {
  it('refuses a job belonging to another agent wallet', async () => {
    const built = build(ok(), { wallet: '0xmine' });
    const error = await refusedWithoutSpawning(
      built,
      request({ agentWallet: '0xtheirs' }),
      'WALLET_MISMATCH',
    );
    // Addresses are public, and an operator debugging a shared store needs both.
    expect(error.detail).toMatchObject({ jobWallet: '0xtheirs', signerWallet: '0xmine' });
  });

  it('refuses empty bytes rather than signing nothing', async () => {
    const built = build();
    await refusedWithoutSpawning(
      built,
      request({ sponsoredTransactionBytes: '' }),
      'NOTHING_TO_SIGN',
    );
  });

  it('refuses once the lease signal has aborted, so a fenced-out Runner authorizes nothing', async () => {
    const built = build();
    const controller = new AbortController();
    controller.abort();
    await refusedWithoutSpawning(built, request(), 'ABORTED', controller.signal);
  });

  it('cannot be constructed without a command or a wallet', () => {
    const run: SignerRunner = async () => ok();
    // At construction, not at the trigger: the worst moment to discover a Runner
    // cannot sign is the instant a target is finally met.
    expect(() => createExternalCommandSigner({ command: [], agentWallet: WALLET, run })).toThrow(
      SignerError,
    );
    expect(() =>
      createExternalCommandSigner({ command: [''], agentWallet: WALLET, run }),
    ).toThrow(SignerError);
    expect(() =>
      createExternalCommandSigner({ command: [...COMMAND], agentWallet: '', run }),
    ).toThrow(SignerError);
  });
});

describe('what the child says', () => {
  it('reports a timeout as its own code, and never as a failure to sign', async () => {
    // The distinction is load-bearing: on a timeout it is unknown whether the
    // key holder signed, and the caller must not treat that as "it did not".
    const built = build(ok({ timedOut: true }), { timeoutMs: 4_000 });
    const error = await built.sign().catch((thrown: unknown) => thrown);
    expect((error as SignerError).code).toBe('SIGNER_TIMEOUT');
    expect(isPreSpawnRefusal((error as SignerError).code)).toBe(false);
    expect((error as SignerError).detail).toMatchObject({ timeoutMs: 4_000 });
    expect(built.calls[0]?.timeoutMs).toBe(4_000);
  });

  it('refuses a non-zero exit without using its output', async () => {
    const built = build(ok({ code: 17, stdout: JSON.stringify({ signature: SIGNATURE }) }));
    const error = (await built.sign().catch((thrown: unknown) => thrown)) as SignerError;
    expect(error.code).toBe('SIGNER_FAILED');
    expect(error.detail).toMatchObject({ exitCode: 17 });
    // The child produced a perfectly well-formed signature and exited non-zero.
    // Using it would be trusting output the provider disowned.
    expect(JSON.stringify(error)).not.toContain(SIGNATURE);
  });

  it('refuses non-JSON stdout, and does not quote it back', async () => {
    const built = build(ok({ stdout: `not json ${SIGNATURE}` }));
    const error = (await built.sign().catch((thrown: unknown) => thrown)) as SignerError;
    expect(error.code).toBe('SIGNER_FAILED');
    // Unparsed stdout may hold anything, including the signature itself, so the
    // error reports a length rather than the text.
    expect(`${error.message}${JSON.stringify(error.detail)}`).not.toContain(SIGNATURE);
    expect(error.detail).toMatchObject({ stdoutBytes: `not json ${SIGNATURE}`.length });
  });

  it('never fabricates a signature from a partial answer', async () => {
    for (const stdout of ['{}', '{"signature":""}', '{"signature":123}', 'null']) {
      const built = build(ok({ stdout }));
      const error = (await built.sign().catch((thrown: unknown) => thrown)) as SignerError;
      expect(error.code).toBe('SIGNER_FAILED');
    }
  });

  it('forwards stderr as a diagnostic and stdout as neither', async () => {
    const built = build(ok({ stderr: '  keystore: slot 3 unlocked  ' }));
    await expect(built.sign()).resolves.toBe(SIGNATURE);
    // Trimmed, and it is the child's own configuration problem — an operator has
    // to be able to see it. It is the caller that redacts and writes it.
    expect(built.diagnostics).toEqual(['keystore: slot 3 unlocked']);
  });

  it('puts no signature, no bytes and no stdout in any diagnostic', async () => {
    const built = build(ok({ stderr: 'signed slot 3' }));
    await built.sign();
    const everything = built.diagnostics.join('|');
    expect(everything).not.toContain(SIGNATURE);
    expect(everything).not.toContain(BYTES);
  });

  it('says nothing when the child says nothing', async () => {
    const built = build(ok({ stderr: '   ' }));
    await built.sign();
    expect(built.diagnostics).toEqual([]);
  });
});

describe('what an error may carry', () => {
  it('never carries the transaction bytes, whatever the failure', async () => {
    const answers: (SignerRunResult | Error)[] = [
      ok({ code: 3 }),
      ok({ timedOut: true }),
      ok({ stdout: 'garbage' }),
      ok({ stdout: '{}' }),
    ];
    for (const answer of answers) {
      const built = build(answer);
      const error = (await built.sign().catch((thrown: unknown) => thrown)) as SignerError;
      const serialized = `${error.message}|${JSON.stringify(error.detail)}`;
      expect(serialized).not.toContain(BYTES);
      expect(serialized).not.toContain(SIGNATURE);
    }
  });

  it('names the executable by base name only, never the configured path', async () => {
    const built = build(ok({ code: 1 }));
    const error = (await built.sign().catch((thrown: unknown) => thrown)) as SignerError;
    expect(error.detail).toMatchObject({ executable: 'waterx-sign' });
    // A full argv can name a home directory, a slot or a hostname.
    expect(JSON.stringify(error.detail)).not.toContain('/opt/keystore');
  });
});

/**
 * The Runner's *authentication* signer, which exists so the client can open a
 * session for days without either handing it a token or handing it a way to sign
 * an order. Both halves matter: it must actually sign the challenge, and it must
 * refuse a transaction in a way no caller can talk it out of.
 */
describe('the authentication signer', () => {
  const authBuild = (
    answer: SignerRunResult | Error = ok(),
  ): { signer: ReturnType<typeof createExternalCommandAuthSigner>; calls: Recorder['calls'] } => {
    const run = recorder(answer);
    return {
      calls: run.calls,
      signer: createExternalCommandAuthSigner({
        command: COMMAND,
        agentWallet: WALLET,
        run: run.runner,
      }),
    };
  };

  it('signs the challenge as a personal message, and says so on the wire', async () => {
    // PERSONAL_MESSAGE, not TRANSACTION: the server verifies this with
    // verifyPersonalMessageSignature, and Sui's intent prefixes differ. A
    // transaction signature here is well-formed over the wrong bytes.
    const built = authBuild();
    const result = await built.signer.signPersonalMessage(new TextEncoder().encode('challenge'));

    expect(result.signature).toBe(SIGNATURE);
    expect(built.calls).toHaveLength(1);
    const sent = JSON.parse(built.calls[0]?.stdin ?? '{}') as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['agentWallet', 'messageBase64', 'type', 'version']);
    expect(sent['type']).toBe('PERSONAL_MESSAGE');
    expect(sent['version']).toBe(SIGNER_PROTOCOL.version);
    expect(sent['messageBase64']).toBe(Buffer.from('challenge').toString('base64'));
  });

  it('refuses a transaction, and starts nothing to refuse it', () => {
    // This is what keeps `executeMarketOrder` from producing an order signature
    // outside a job's policy snapshot: not a convention, a missing road.
    const built = authBuild();
    let thrown: unknown;
    try {
      built.signer.signTransaction(new TextEncoder().encode('an order'));
    } catch (error: unknown) {
      thrown = error;
    }

    expect(isSignerError(thrown)).toBe(true);
    expect(isSignerError(thrown) && thrown.code).toBe('NOT_A_TRANSACTION_SIGNER');
    expect(isSignerError(thrown) && isPreSpawnRefusal(thrown.code)).toBe(true);
    expect(built.calls).toEqual([]);
  });

  it('reports the wallet it signs as, without being asked to prove it', () => {
    expect(authBuild().signer.toSuiAddress()).toBe(WALLET);
  });

  it('carries neither the signature nor the challenge into an error', async () => {
    const built = authBuild(ok({ code: 1, stderr: SIGNATURE }));
    const error = (await built.signer
      .signPersonalMessage(new TextEncoder().encode('challenge'))
      .catch((thrown: unknown) => thrown)) as SignerError;

    const serialized = `${error.message}|${JSON.stringify(error.detail)}`;
    expect(serialized).not.toContain(SIGNATURE);
    expect(error.detail).toMatchObject({ executable: 'waterx-sign' });
  });

  it('refuses to be built without a command or a wallet', () => {
    for (const options of [
      { command: [] as readonly string[], agentWallet: WALLET },
      { command: COMMAND, agentWallet: '  ' },
    ]) {
      expect(() =>
        createExternalCommandAuthSigner({ ...options, run: recorder().runner }),
      ).toThrow(SignerError);
    }
  });
});
