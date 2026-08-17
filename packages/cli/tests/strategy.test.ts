/**
 * The strategy family, from argv to the Runner's socket and back.
 *
 * These five commands are the only ones in this CLI whose counterparty is a
 * daemon on the same machine rather than the exchange, and everything worth
 * asserting here follows from that. Four properties carry the file:
 *
 * First: a refusal this CLI can reach on its own costs ZERO socket traffic. An
 * ambiguous size, an absent runtime directory, a directory another local account
 * can read — each is decided before a dial, and `runnerDials` is empty. The
 * last of those is not tidiness: a world-readable `~/.waterx/runner` lets someone
 * else's process answer with a plausible job id, having been handed the wallet
 * addresses and the size first.
 *
 * Second: the invariant the whole CLI is built on survives contact with a
 * socket. One parseable document on stdout, always, whatever the daemon did.
 *
 * Third: an outcome that is not "armed and watching" cannot exit zero. A Runner
 * that accepted the job and is not driving it, and a cancellation that was
 * recorded and not applied, are both `ok: true` envelopes with a non-zero exit —
 * because the envelope is what an operator reads afterwards and the exit code is
 * what the shell script branches on now.
 *
 * Fourth: a create whose answer never arrived is AMBIGUOUS, never a failure.
 * The Runner does not deduplicate creates, so a script that retried a
 * "transport error" would arm a second strategy that also trades.
 */
import { describe, expect, it } from 'vitest';

import { EXIT_CODES } from '../src/index.ts';
import { RUNNER_IPC_PROTOCOL } from '../src/runner-ipc.ts';
import {
  ACCOUNT_ID,
  AGENT_WALLET,
  CONFIGURED_ENV,
  invoke,
  RUNNER_DIR,
  RUNNER_TOKEN,
} from './harness.ts';

const OWNER = `0x${'d'.repeat(63)}3`;

/** Every argv below points at the same runtime directory, explicitly. */
const AT_RUNNER = ['--runner-dir', RUNNER_DIR];

const LEG = {
  marketId: 'mkt_server_resolved_1',
  outcomeId: 'YES',
  side: 'BUY',
  buyAmount: '25.00',
  maxSlippageBps: 150,
};

const CREATE_INPUT = {
  ownerAddress: OWNER,
  accountId: ACCOUNT_ID,
  agentWallet: AGENT_WALLET,
  legs: [LEG],
  trigger: { kind: 'PRICE', targetPrice: '0.42', side: 'BUY' },
  expiresAt: '2026-08-14T00:00:00.000Z',
};

const create = (input: Record<string, unknown> = CREATE_INPUT) => [
  'strategy',
  'create',
  ...AT_RUNNER,
  '--input',
  JSON.stringify(input),
];

const CREATED = {
  jobId: 'job_01',
  strategyId: 'job_01',
  state: 'WATCHING',
  expiresAt: CREATE_INPUT.expiresAt,
  driving: true,
};

describe('reaching the Runner', () => {
  it('says which directory holds no Runner, without dialling anything', async () => {
    const result = await invoke(['strategy', 'list', ...AT_RUNNER], { env: CONFIGURED_ENV });

    expect(result.runnerDials).toEqual([]);
    expect(result.writes).toBe(1);
    expect(result.envelope.ok).toBe(false);
    expect(result.envelope.error?.source).toBe('RUNNER');
    expect(result.envelope.error?.code).toBe('RUNNER_UNREACHABLE');
    // The directory has to be in the message. "No Runner is listening" against a
    // machine where one is, because the CLI looked somewhere else, is the single
    // most confusing thing this command can say.
    expect(result.envelope.error?.message).toContain(RUNNER_DIR);
    expect(result.exit).toBe(EXIT_CODES.UNAVAILABLE);
  });

  it('refuses a runtime directory another account can reach, before sending anything', async () => {
    const result = await invoke(['strategy', 'list', ...AT_RUNNER], {
      env: CONFIGURED_ENV,
      runner: {},
      // Group-readable: enough for another local account to steal the token and
      // stand in for the Runner.
      pathStat: () => ({ kind: 'directory', uid: process.getuid?.() ?? 0, mode: 0o750 }),
    });

    expect(result.runnerDials).toEqual([]);
    expect(result.envelope.error?.code).toBe('INSECURE_RUNTIME_DIR');
    expect(result.envelope.error?.message).toContain('chmod 700');
    // CONFIG, not UNAVAILABLE: there may well be a Runner there, and the operator
    // has something to fix rather than something to start.
    expect(result.exit).toBe(EXIT_CODES.CONFIG);
  });

  it('reports a socket file with no daemon behind it as nothing to reach', async () => {
    const result = await invoke(['strategy', 'list', ...AT_RUNNER], {
      env: CONFIGURED_ENV,
      // What a Runner that was killed without unlinking its socket leaves.
      runner: { dialThrows: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) },
    });

    expect(result.runnerDials).toEqual([`${RUNNER_DIR}/runner.sock`]);
    expect(result.envelope.error?.code).toBe('RUNNER_UNREACHABLE');
    expect(result.exit).toBe(EXIT_CODES.UNAVAILABLE);
  });

  it('refuses a Runner speaking another protocol version rather than negotiating down', async () => {
    const result = await invoke(['strategy', 'list', ...AT_RUNNER], {
      env: CONFIGURED_ENV,
      runner: { protocolVersion: RUNNER_IPC_PROTOCOL.version + 1 },
    });

    expect(result.envelope.error?.code).toBe('PROTOCOL_VERSION');
    expect(result.exit).toBe(EXIT_CODES.UNAVAILABLE);
  });

  it('writes exactly the frames the protocol descriptor documents', async () => {
    // The other half of the arrangement that lets this package carry its own copy
    // of the wire: `tests/workspace.test.ts` holds the two descriptors equal and
    // feeds these frames through the Runner's real decoder, and this asserts the
    // frames this file actually writes match the descriptor at all.
    const result = await invoke(['strategy', 'get', ...AT_RUNNER, '--jobId', 'job_01'], {
      env: CONFIGURED_ENV,
      runner: { replies: { 'strategy.get': { result: { jobId: 'job_01', state: 'PAUSED' } } } },
    });

    expect(result.exit).toBe(EXIT_CODES.OK);
    for (const [index, expected] of RUNNER_IPC_PROTOCOL.clientFrames.entries()) {
      const written = result.runnerFrames[index] ?? {};
      expect(written['type'], expected.type).toBe(expected.type);
      // Exactly these keys. An extra one is a field the Runner's decoder rejects;
      // a missing one is a promise the descriptor made and this file broke.
      expect(Object.keys(written).sort(), expected.type).toEqual([...expected.fields].sort());
      expect(written['v'], expected.type).toBe(RUNNER_IPC_PROTOCOL.version);
    }
  });
});

describe('what the Runner decides, and what this CLI does not', () => {
  it('carries an ambiguous size out as the Runner named it, having sent nothing itself', async () => {
    const ambiguous = {
      ...CREATE_INPUT,
      legs: [
        {
          marketId: 'mkt_server_resolved_1',
          outcomeId: 'YES',
          side: 'SELL',
          positionId: 'pos_1',
          sellShares: '10',
          sellFractionOfPosition: '0.5',
          maxSlippageBps: 150,
        },
      ],
    };
    const result = await invoke(create(ambiguous), {
      env: CONFIGURED_ENV,
      runner: {
        replies: {
          'strategy.create': {
            error: {
              code: 'SIZE_AMBIGUOUS',
              message: 'leg 0 names both sellShares and sellFractionOfPosition.',
              detail: { legIndex: 0 },
            },
          },
        },
      },
    });

    // Not re-decided here, and not renamed: the Runner is the one place that
    // knows what "sell half" means, and it is the same place an embedding
    // application calls.
    expect(result.envelope.error?.code).toBe('SIZE_AMBIGUOUS');
    expect(result.envelope.error?.source).toBe('RUNNER');
    expect(result.envelope.error?.details).toMatchObject({ legIndex: 0 });
    expect(result.exit).toBe(EXIT_CODES.INVALID_INPUT);
    // The refusal came from a daemon on this machine. Nothing was asked of the
    // exchange, on any path.
    expect(result.fetches).toEqual([]);
    expect(result.signerRuns).toEqual([]);
  });

  it('lets the Runner refuse a missing expiry rather than defaulting one', async () => {
    const { expiresAt: _dropped, ...noExpiry } = CREATE_INPUT;
    const result = await invoke(create(noExpiry), {
      env: CONFIGURED_ENV,
      runner: {
        replies: {
          'strategy.create': {
            error: {
              code: 'EXPIRY_REQUIRED',
              message: 'expiresAt is required, at most seven days out.',
            },
          },
        },
      },
    });

    // The request reached the Runner: the schema deliberately does not require
    // `expiresAt`, so that the operator gets this sentence rather than an
    // anonymous schema violation — and so that one rule has one enforcer.
    const request = result.runnerFrames[1] ?? {};
    expect(request['command']).toBe('strategy.create');
    expect((request['input'] as Record<string, unknown>)['expiresAt']).toBeUndefined();
    expect(result.envelope.error?.code).toBe('EXPIRY_REQUIRED');
    expect(result.exit).toBe(EXIT_CODES.INVALID_INPUT);
  });

  it('refuses to arm a strategy under a read-only policy, before locating a Runner', async () => {
    const result = await invoke([...create(), '--policy', 'read-only'], {
      env: CONFIGURED_ENV,
      runner: { replies: { 'strategy.create': { result: CREATED } } },
    });

    expect(result.runnerDials).toEqual([]);
    expect(result.runnerFrames).toEqual([]);
    expect(result.envelope.error?.code).toBe('POLICY_DENIED');
    expect(result.envelope.error?.source).toBe('CLI');
    expect(result.exit).toBe(EXIT_CODES.POLICY);
  });
});

describe('arming one', () => {
  it('answers with the job, and names which Runner holds it', async () => {
    const result = await invoke(create(), {
      env: CONFIGURED_ENV,
      runner: { instanceId: 'runner-a', replies: { 'strategy.create': { result: CREATED } } },
    });

    expect(result.writes).toBe(1);
    expect(result.exit).toBe(EXIT_CODES.OK);
    expect(result.envelope.ok).toBe(true);
    expect(result.envelope.data).toMatchObject({
      jobId: 'job_01',
      state: 'WATCHING',
      // A strategy is durable in ONE runtime directory. A job created against
      // another Runner is elsewhere, not absent, and the answer has to say where.
      runner: { instanceId: 'runner-a', socketPath: `${RUNNER_DIR}/runner.sock`, driving: true },
    });
  });

  it('exits UNAVAILABLE when the Runner wrote the job and is not driving it', async () => {
    const result = await invoke(create(), {
      env: CONFIGURED_ENV,
      runner: {
        driving: false,
        replies: {
          'strategy.create': {
            result: { ...CREATED, driving: false, driverGaps: ['signer', 'gateway'] },
          },
        },
      },
    });

    // The envelope is a success, because the job is real and durable and the
    // operator needs its id. The exit code is not, because nothing is watching it.
    expect(result.envelope.ok).toBe(true);
    expect(result.envelope.data).toMatchObject({ jobId: 'job_01' });
    expect(result.exit).toBe(EXIT_CODES.UNAVAILABLE);
    expect(result.stderr).toContain('NOT being watched');
    expect(result.stderr).toContain('signer, gateway');
  });

  it('calls a create with no answer unknown, and points at `strategy list`', async () => {
    const result = await invoke(create(), {
      env: CONFIGURED_ENV,
      // The Runner took the request and died without answering: from here,
      // "never written" and "written but unreported" are the same observation.
      runner: { closesOnRequest: true, replies: { 'strategy.create': { result: CREATED } } },
    });

    expect(result.envelope.error?.code).toBe('CREATE_OUTCOME_UNKNOWN');
    expect(result.envelope.error?.message).toContain('strategy list');
    expect(result.envelope.error?.details).toMatchObject({ underlying: 'CONNECTION_CLOSED' });
    // AMBIGUOUS rather than TRANSPORT. A retry on transport is normal and
    // correct everywhere else in this CLI; here it arms a second strategy.
    expect(result.exit).toBe(EXIT_CODES.AMBIGUOUS);
  });

  it('leaves a read that lost its connection as a plain transport failure', async () => {
    // The same wire failure on a command that writes nothing. Nothing is unknown
    // about a list that did not answer, so it must not claim to be.
    const result = await invoke(['strategy', 'list', ...AT_RUNNER], {
      env: CONFIGURED_ENV,
      runner: { closesOnRequest: true },
    });

    expect(result.envelope.error?.code).toBe('CONNECTION_CLOSED');
    expect(result.exit).toBe(EXIT_CODES.TRANSPORT);
  });
});

describe('cancelling one', () => {
  const cancel = ['strategy', 'cancel', ...AT_RUNNER, '--jobId', 'job_01', '--reason', 'thesis changed'];

  it('exits OK when the cancellation was applied', async () => {
    const result = await invoke(cancel, {
      env: CONFIGURED_ENV,
      runner: {
        replies: {
          'strategy.cancel': { result: { jobId: 'job_01', recorded: true, applied: true, state: 'CANCELLED' } },
        },
      },
    });

    expect(result.exit).toBe(EXIT_CODES.OK);
    expect(result.envelope.data).toMatchObject({ recorded: true, applied: true });
    expect(result.stderr).toBe('');
  });

  it('reports a recorded-but-not-applied cancellation as ambiguous, not as done', async () => {
    const result = await invoke(cancel, {
      env: CONFIGURED_ENV,
      runner: {
        replies: {
          'strategy.cancel': {
            result: { jobId: 'job_01', recorded: true, applied: false, pending: 'IN_FLIGHT' },
          },
        },
      },
    });

    expect(result.writes).toBe(1);
    expect(result.envelope.ok).toBe(true);
    expect(result.envelope.data).toMatchObject({ recorded: true, applied: false });
    // The one case where reporting the record as the stop would be a lie: an
    // order already on its way to the chain cannot be recalled.
    expect(result.stderr).toContain('already begun a write');
    expect(result.exit).toBe(EXIT_CODES.AMBIGUOUS);
  });

  it('distinguishes a lease held by another instance from a write in flight', async () => {
    const result = await invoke(cancel, {
      env: CONFIGURED_ENV,
      runner: {
        replies: {
          'strategy.cancel': {
            result: { jobId: 'job_01', recorded: true, applied: false, pending: 'LEASED_ELSEWHERE' },
          },
        },
      },
    });

    expect(result.stderr).toContain('does not hold the job');
    expect(result.exit).toBe(EXIT_CODES.AMBIGUOUS);
  });
});

describe('reading one', () => {
  it('repeats `driving` on a read, so a WATCHING job nobody moves is visible', async () => {
    const result = await invoke(['strategy', 'get', ...AT_RUNNER, '--jobId', 'job_01'], {
      env: CONFIGURED_ENV,
      runner: {
        driving: false,
        replies: { 'strategy.get': { result: { jobId: 'job_01', state: 'WATCHING' } } },
      },
    });

    expect(result.exit).toBe(EXIT_CODES.OK);
    expect(result.envelope.data).toMatchObject({ state: 'WATCHING', runner: { driving: false } });
  });

  it('reports an unknown job as not found rather than as an empty answer', async () => {
    const result = await invoke(['strategy', 'events', ...AT_RUNNER, '--jobId', 'job_missing'], {
      env: CONFIGURED_ENV,
      runner: {
        replies: {
          'strategy.events': { error: { code: 'UNKNOWN_JOB', message: 'no job job_missing.' } },
        },
      },
    });

    expect(result.envelope.error?.code).toBe('UNKNOWN_JOB');
    expect(result.exit).toBe(EXIT_CODES.NOT_FOUND);
  });

  it('needs no exchange configuration at all: the counterparty is local', async () => {
    // An unconfigured machine can still ask what is armed on it. A strategy
    // command that first demanded a base URL and a signer would be unusable in
    // exactly the moment an operator wants to know what is running.
    const result = await invoke(['strategy', 'list', ...AT_RUNNER], {
      env: {},
      runner: { replies: { 'strategy.list': { result: { strategies: [] } } } },
    });

    expect(result.exit).toBe(EXIT_CODES.OK);
    expect(result.fetches).toEqual([]);
    expect(result.envelope.data).toMatchObject({ strategies: [] });
  });
});

/**
 * The Runner's bearer token, which this CLI is the only thing that reads.
 *
 * It is not the session token: it authenticates to the process that HOLDS the
 * signer, on the same machine, and anyone who has it can arm a strategy that
 * trades. The daemon has had a checked absence for it since it was written; this
 * is the client's half. The point of the assertions below is that they do not
 * depend on this module's own care — the token goes into the redactor the moment
 * it comes off disk, so the leak paths nobody enumerated are covered too.
 */
describe('the Runner token', () => {
  it('reaches the socket and neither stream', async () => {
    const result = await invoke(['strategy', 'list', ...AT_RUNNER], {
      env: CONFIGURED_ENV,
      runner: { replies: { 'strategy.list': { result: { strategies: [] } } } },
    });

    expect(result.exit).toBe(EXIT_CODES.OK);
    // It authenticated: the handshake carried it.
    expect(result.runnerFrames[0]).toMatchObject({ type: 'hello', token: RUNNER_TOKEN });
    expect(result.stdout).not.toContain(RUNNER_TOKEN);
    expect(result.stderr).not.toContain(RUNNER_TOKEN);
  });

  it('is blanked even when the Runner quotes it back inside a refusal', async () => {
    // A daemon that echoes what it was sent is not hypothetical — an argument
    // dump in an error path is the ordinary way this happens, and the CLI prints
    // a Runner's message verbatim by design.
    const result = await invoke(['strategy', 'get', ...AT_RUNNER, '--jobId', 'job_01'], {
      env: CONFIGURED_ENV,
      runner: {
        replies: {
          'strategy.get': {
            error: {
              code: 'UNKNOWN_JOB',
              message: `no job job_01 for token ${RUNNER_TOKEN}.`,
              detail: { token: RUNNER_TOKEN },
            },
          },
        },
      },
    });

    expect(result.exit).toBe(EXIT_CODES.NOT_FOUND);
    expect(result.envelope.error?.code).toBe('UNKNOWN_JOB');
    expect(result.stdout).not.toContain(RUNNER_TOKEN);
    expect(result.stderr).not.toContain(RUNNER_TOKEN);
    // Blanked, not dropped: the operator still sees that a message was there.
    expect(result.envelope.error?.message).toContain('[redacted]');
  });

  it('is blanked in a diagnostic, which is where an armed-and-asleep create prints', async () => {
    const result = await invoke(create(), {
      env: CONFIGURED_ENV,
      runner: {
        driving: false,
        replies: {
          'strategy.create': {
            result: { ...CREATED, driving: false, driverGaps: [`signer (${RUNNER_TOKEN})`] },
          },
        },
      },
    });

    expect(result.exit).toBe(EXIT_CODES.UNAVAILABLE);
    expect(result.stderr).toContain('NOT being watched');
    expect(result.stdout).not.toContain(RUNNER_TOKEN);
    expect(result.stderr).not.toContain(RUNNER_TOKEN);
  });
});
