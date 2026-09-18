/**
 * `next` — the command an agent host runs in a loop and obeys.
 *
 * "Do what it says" is only safe if what it says is bounded, so the properties
 * protected here are about the boundary rather than the prose:
 *
 * - every suggestion is a READ in the contract, with argv the CLI would accept;
 * - a person's step stops the loop and names the person;
 * - a value a person must choose is asked for, never filled in;
 * - nothing new is offered while something is unsettled, whatever else is true;
 * - every degraded state is an answer with exit 0, and costs no more traffic
 *   than it needs to.
 */
import { describe, expect, it } from 'vitest';

import { getCommand, validateCommandInput } from '@waterx/predict-agent-schema';
import { AGENT_REQUIREMENTS } from '@waterx/predict-agent-sdk';

import { decideNext, NEXT_STATES, type NextFacts } from '../src/commands/next.ts';
import { EXIT_CODES } from '../src/index.ts';
import {
  ACCOUNT_ID,
  AGENT_WALLET,
  AUTH_OK,
  CONFIGURED_ENV,
  EFFECTIVE_LIMITS_OK,
  RUNNER_DIR,
  invoke,
  type InvokeOptions,
  type RouteResponse,
} from './harness.ts';

interface Suggestion {
  command: string;
  input: Record<string, unknown>;
  argv: string[];
  invocation: string;
  classification: string;
  why: string;
  needsFromUser?: { field: string; why: string }[];
}

interface Answer {
  state: string;
  headline: string;
  actor: string;
  stop: boolean;
  handOver?: {
    to: string;
    message: string;
    steps?: { run: string; why: string }[];
    authorizationUrl?: string;
    settings?: { requirement: string; supplyWith: string[] }[];
  };
  agentSteps?: { run: string; command?: string; why: string; safeBecause: string }[];
  suggestions: Suggestion[];
  facts: {
    deployment: { source: string; name: string | null; baseUrl: string | null; realFunds: boolean };
    session: string;
    policy: { mode: string; writes: string };
    accountId: string | null;
    account: { status: string; unsettledExecutions?: { executionId: string }[] } | null;
    runner: { status: string } | null;
    signer: { kind: string; configured?: boolean; installed?: boolean; agent?: string; keystore?: { status: string } };
  };
  requirements: { id: string; state: string }[];
  nextStep: { actor: string; action: string };
}

const OTHER_ACCOUNT = `0x${'d'.repeat(63)}3`;
const ACCOUNTS = 'GET /agent-api/v1/predict/accounts';
const LIMITS = `GET /agent-api/v1/predict/accounts/${ACCOUNT_ID}/effective-limits`;
const EXECUTIONS = `GET /agent-api/v1/predict/accounts/${ACCOUNT_ID}/executions`;
const POSITIONS = `GET /agent-api/v1/predict/accounts/${ACCOUNT_ID}/positions`;
const CONSOLE_ENV = { ...CONFIGURED_ENV, WATERX_PREDICT_CONSOLE_URL: 'https://console.test.invalid' };
const SERVER_DOWN: RouteResponse = {
  status: 503,
  body: { error: { code: 'SERVICE_UNAVAILABLE', message: 'down', retryable: true } },
};

const account = (overrides: Record<string, unknown> = {}) => ({
  accountId: ACCOUNT_ID,
  ownerAddress: `0x${'e'.repeat(63)}4`,
  isSuspended: false,
  policyVersion: 2,
  delegation: { mayPlaceOrder: true, mayRequestClose: true, checkedAt: '2026-08-01T00:00:00.000Z' },
  grantedAt: '2026-07-01T00:00:00.000Z',
  updatedAt: '2026-07-02T00:00:00.000Z',
  ...overrides,
});

const listing = (...accounts: unknown[]): RouteResponse => ({ status: 200, body: { accounts } });

const execution = (status: string, id = 'exec_open_0000000000001') => ({
  executionId: id,
  status,
  side: 'BUY',
  marketId: `0x${'2'.repeat(64)}`,
  outcomeId: 'YES',
  size: '5',
  strategyId: null,
  clientOrderId: null,
  enforcedWorstPrice: '0.55',
  transactionDigest: null,
  positionId: null,
  createdAt: '2026-08-11T23:59:00.000Z',
  terminalAt: null,
});

const executions = (...rows: unknown[]): RouteResponse => ({
  status: 200,
  body: { executions: rows, nextCursor: null },
});

const positions = (count: number): RouteResponse => ({
  status: 200,
  body: {
    positions: Array.from({ length: count }, (_, index) => ({
      positionId: `0x${String(index).repeat(64).slice(0, 64)}`,
      marketId: `0x${'2'.repeat(64)}`,
      outcomeId: 'YES',
      shares: '10',
    })),
    nextCursor: null,
  },
});

const limitsWith = (blockers: string[]): RouteResponse => ({
  status: 200,
  body: { ...EFFECTIVE_LIMITS_OK.body, blockers },
});

/** A fully authorized account with nothing in flight. */
const READY_ROUTES: Record<string, RouteResponse> = {
  'POST /agent-api/v1/auth': AUTH_OK,
  [ACCOUNTS]: listing(account()),
  [LIMITS]: EFFECTIVE_LIMITS_OK,
  [EXECUTIONS]: executions(execution('FILLED', 'exec_done_0000000000001')),
  [POSITIONS]: positions(0),
};

async function next(options: InvokeOptions, extra: readonly string[] = []) {
  const result = await invoke(['next', '--json', ...extra], options);
  return { result, answer: result.envelope.data as Answer };
}

/**
 * The boundary, checked on every answer this suite produces.
 *
 * A suggestion the CLI would refuse to parse, or a write, is the failure that
 * turns "do what it says" into either a dead loop or a trade nobody approved.
 */
function assertBounded(answer: Answer): void {
  expect(NEXT_STATES).toContain(answer.state);
  expect(answer.stop).toBe(answer.actor !== 'AGENT');
  expect(answer.handOver !== undefined).toBe(answer.stop);
  if (answer.handOver !== undefined) expect(answer.handOver.to).toBe(answer.actor);
  expect(answer.suggestions.length).toBeGreaterThan(0);

  for (const suggestion of answer.suggestions) {
    const spec = getCommand(suggestion.command);
    expect(spec, suggestion.command).toBeDefined();
    if (spec === undefined) continue;
    expect(spec.classification).toBe('read');
    expect(suggestion.classification).toBe('read');
    const path = spec.cli.split(' ');
    expect(suggestion.argv.slice(0, path.length)).toEqual(path);
    expect(suggestion.invocation.startsWith(`waterx-predict ${spec.cli}`)).toBe(true);

    // Every field any branch of the input declares — `order preview` is a oneOf.
    const fields = new Set([
      ...Object.keys(spec.input.properties ?? {}),
      ...(spec.input.oneOf ?? []).flatMap((branch) => Object.keys(branch.properties ?? {})),
    ]);
    const input: Record<string, unknown> = {};
    const flags = suggestion.argv.slice(path.length);
    if (flags[0] === '--input') {
      // Structured: the known values travel as the document, and nothing else.
      expect(flags).toHaveLength(2);
      Object.assign(input, JSON.parse(flags[1] ?? '{}') as Record<string, unknown>);
      for (const field of Object.keys(input)) expect([...fields], field).toContain(field);
      flags.length = 0;
    } else {
      // Typed flags are only valid on a command with top-level fields.
      const flaggable = Object.keys(spec.input.properties ?? {});
      for (const flag of flags) {
        if (flag.startsWith('--')) expect(flaggable, `${suggestion.command} ${flag}`).toContain(flag.slice(2));
      }
    }
    for (let index = 0; index < flags.length; index += 1) {
      const flag = flags[index] ?? '';
      expect(flag.startsWith('--'), flag).toBe(true);
      const field = flag.slice(2);
      const value = flags[index + 1];
      if (value === undefined || value.startsWith('--')) {
        input[field] = true;
      } else {
        input[field] = value;
        index += 1;
      }
    }
    for (const need of suggestion.needsFromUser ?? []) {
      expect([...fields], `${suggestion.command} needs ${need.field}`).toContain(need.field);
      expect(input[need.field]).toBeUndefined();
    }
    expect(input).toEqual(suggestion.input);
    // Complete suggestions must validate as they stand: the agent is told to run
    // them verbatim.
    if (suggestion.needsFromUser === undefined) {
      const verdict = validateCommandInput(spec.name, input);
      expect(verdict.ok, `${suggestion.invocation}: ${verdict.ok ? '' : verdict.message}`).toBe(true);
    }
  }
}

describe('next, before anything is configured', () => {
  it('answers with the operator settings, and sends nothing anywhere', async () => {
    const { result, answer } = await next({ env: {} });

    expect(result.exit).toBe(EXIT_CODES.OK);
    expect(result.envelope.ok).toBe(true);
    expect(result.writes).toBe(1);
    expect(answer.state).toBe('SETUP_INCOMPLETE');
    expect(answer.stop).toBe(true);
    expect(answer.handOver?.to).toBe('AGENT_OPERATOR');
    // The network is no longer asked for: it defaults to mainnet (ADR-0011),
    // and the answer says so where a host cannot miss it.
    expect(answer.handOver?.settings?.map((setting) => setting.requirement)).toEqual(['agentWallet', 'signer']);
    expect(answer.handOver?.message).toMatch(/Do not do them yourself/u);
    expect(answer.handOver?.message).toMatch(/production \(mainnet\).*real funds/u);
    expect(answer.facts.deployment).toEqual({
      source: 'DEFAULT',
      name: 'production',
      baseUrl: 'https://api.waterx.app',
      realFunds: true,
      mode: 'agent-api',
      network: 'mainnet',
    });
    expect(result.envelope.meta?.warnings?.join(' ')).toMatch(/mainnet/u);
    expect(answer.suggestions[0]?.argv).toEqual(['next']);
    expect(answer.facts.session).toBe('NOT_ATTEMPTED');
    // The owner-side requirements were never looked at, and must not read as absent.
    expect(answer.requirements.filter((row) => row.state === 'UNCHECKED').map((row) => row.id)).toEqual([
      'authorizedAccount',
      'delegation',
      'riskProfile',
    ]);
    expect(result.fetches).toEqual([]);
    expect(result.signerRuns).toEqual([]);
    expect(result.runnerDials).toEqual([]);
    assertBounded(answer);
  });

  it('names only what is actually missing', async () => {
    const { answer } = await next({
      env: { WATERX_PREDICT_ENVIRONMENT: 'testnet', WATERX_PREDICT_AGENT_WALLET: AGENT_WALLET },
    });
    expect(answer.state).toBe('SETUP_INCOMPLETE');
    expect(answer.handOver?.settings?.map((setting) => setting.requirement)).toEqual(['signer']);
  });

  it('still asks for the network when the name given is not one it knows', async () => {
    const { result, answer } = await next({ env: { WATERX_PREDICT_ENVIRONMENT: 'staging' } });
    expect(answer.handOver?.settings?.map((setting) => setting.requirement)).toEqual([
      'deployment',
      'agentWallet',
      'signer',
    ]);
    expect(answer.facts.deployment).toMatchObject({ source: 'NONE', baseUrl: null, realFunds: false });
    expect(result.fetches).toEqual([]);
  });

  it('reports a named testnet as practice money', async () => {
    const { answer } = await next({ env: { WATERX_PREDICT_ENVIRONMENT: 'testnet' } });
    expect(answer.facts.deployment).toMatchObject({ source: 'NAMED', name: 'testnet', realFunds: false });
  });

  it('carries a named account into the re-ask', async () => {
    const { answer } = await next({ env: {} }, ['--accountId', ACCOUNT_ID]);
    expect(answer.suggestions[0]?.argv).toEqual(['next', '--accountId', ACCOUNT_ID]);
  });
});

/**
 * The keystore signer, which ships beside the CLI (ADR-0012).
 *
 * What is protected: the operator is handed the steps this machine still
 * needs, as commands, in order — and nothing is signed until they are done,
 * because a signature that was always going to fail reads as an auth problem.
 */
describe('next, walking an operator through the keystore signer', () => {
  const HOME = '/home/op';
  const DIR = `${HOME}/.waterx/keystore`;
  const KEYSTORE_ADDRESS = `0x${'b'.repeat(63)}7`;
  const KEYSTORE_FILE = { [`${DIR}/keystore.json`]: JSON.stringify({ version: 1, address: KEYSTORE_ADDRESS, cipherBase64: 'secret-bits' }) };
  const SIGNER = '["waterx-predict-keystore","sign"]';
  const socketUp = (path: string) =>
    path === `${DIR}/keystore.sock` ? ({ kind: 'other', uid: 0, mode: 0o600 } as const) : null;
  const keystoreEnv = (wallet: string = KEYSTORE_ADDRESS) => ({
    WATERX_PREDICT_ENVIRONMENT: 'testnet',
    WATERX_PREDICT_AGENT_WALLET: wallet,
    WATERX_PREDICT_SIGNER_COMMAND: SIGNER,
  });
  const runs = (answer: Answer): string[] => (answer.handOver?.steps ?? []).map((step) => step.run);
  /** The steps the agent may run itself — a separate list, deliberately (ADR-0020). */
  const own = (answer: Answer): string[] => (answer.agentSteps ?? []).map((step) => step.run);

  it('starts from nothing: the operator installs, and the agent does the rest itself', async () => {
    const { result, answer } = await next({ env: {}, homeDir: HOME });
    expect(answer.state).toBe('SETUP_INCOMPLETE');
    // Installing software on someone's machine is theirs. Everything after it
    // creates an empty wallet and writes a local file, so it is the agent's.
    expect(runs(answer)).toEqual([
      'npm install github:WaterXProtocol/waterx-predict-agent   # or <release-asset-url>/waterx-predict-agent-signer-keystore-0.1.0.tgz',
    ]);
    expect(own(answer)).toEqual([
      'npx --no waterx-predict-keystore init --no-passphrase',
      'waterx-predict configure --fromKeystore',
    ]);
    // A person's list and the agent's are never merged, and the agent's says
    // why each step is one it may take.
    expect(answer.agentSteps?.[0]?.safeBecause).toMatch(/holds no funds/u);
    // The owner's key is the one thing an operator must not put there.
    expect(answer.agentSteps?.[0]?.why).toMatch(/perp agent/u);
    expect(answer.agentSteps?.[0]?.safeBecause).toMatch(/Never import an existing key/u);
    expect(answer.facts.signer).toMatchObject({ kind: 'KEYSTORE', installed: false, configured: false, agent: 'NO_SOCKET' });
    expect(result.fetches).toEqual([]);
    assertBounded(answer);
  });

  it('skips what is done, and fills in the address the keystore already holds', async () => {
    const { answer, result } = await next({
      env: {},
      homeDir: HOME,
      executables: ['waterx-predict-keystore'],
      files: KEYSTORE_FILE,
    });
    // The sealed keystore still needs a person to unlock it; the settings do not.
    expect(runs(answer)).toEqual(['npx --no waterx-predict-keystore agent']);
    expect(own(answer)).toEqual(['waterx-predict configure --fromKeystore']);
    expect(answer.agentSteps?.[0]?.why).toContain(KEYSTORE_ADDRESS);
    // Only the public address is read; nothing sealed ever reaches an output.
    expect(result.stdout).not.toContain('secret-bits');
    expect(result.stderr).not.toContain('secret-bits');
  });

  it('honours WATERX_KEYSTORE_DIR, as the keystore itself does', async () => {
    const { answer } = await next({
      env: { WATERX_KEYSTORE_DIR: '/srv/ks' },
      homeDir: HOME,
      executables: ['waterx-predict-keystore'],
      files: { '/srv/ks/keystore.json': JSON.stringify({ address: KEYSTORE_ADDRESS }) },
    });
    expect(own(answer)).toContain('waterx-predict configure --fromKeystore');
    expect(answer.agentSteps?.[0]?.why).toContain(KEYSTORE_ADDRESS);
  });

  it('will not sign while the agent is not running', async () => {
    const { result, answer } = await next({
      env: keystoreEnv(),
      homeDir: HOME,
      executables: ['waterx-predict-keystore'],
      files: KEYSTORE_FILE,
      routes: READY_ROUTES,
    });
    expect(answer.state).toBe('SETUP_INCOMPLETE');
    expect(answer.headline).toContain('The keystore agent is not running');
    expect(runs(answer)).toEqual(['npx --no waterx-predict-keystore agent']);
    expect(result.signerRuns).toEqual([]);
    expect(result.fetches).toEqual([]);
    assertBounded(answer);
  });

  it('catches an agent wallet the keystore does not hold, before the first signature', async () => {
    const { result, answer } = await next({
      env: keystoreEnv(AGENT_WALLET),
      homeDir: HOME,
      executables: ['waterx-predict-keystore'],
      files: KEYSTORE_FILE,
      pathStat: socketUp,
      routes: READY_ROUTES,
    });
    expect(answer.state).toBe('SETUP_INCOMPLETE');
    expect(answer.headline).toContain(`but the keystore holds ${KEYSTORE_ADDRESS}`);
    // The agent step rides along: a socket file is not proof one is running.
    expect(runs(answer)).toEqual(['npx --no waterx-predict-keystore agent']);
    // `--replace`, because the wrong wallet is already configured and a write
    // that silently repointed a runtime would be the more dangerous default.
    expect(own(answer)).toEqual(['waterx-predict configure --fromKeystore --replace']);
    expect(result.signerRuns).toEqual([]);
  });

  it('says a keystore file with no readable address is one, and moves it aside rather than deleting it', async () => {
    const { answer } = await next({
      env: keystoreEnv(),
      homeDir: HOME,
      executables: ['waterx-predict-keystore'],
      files: { [`${DIR}/keystore.json`]: '{ not json' },
    });
    expect(answer.headline).toContain('cannot be read');
    expect(runs(answer)[0]).toMatch(/^mv .*keystore\.json .*\.unreadable$/u);
    expect(own(answer)).toContain('npx --no waterx-predict-keystore init --no-passphrase');
  });

  it('sends a signer that did not answer back to the operator, not to doctor alone', async () => {
    const { answer } = await next({
      env: keystoreEnv(),
      homeDir: HOME,
      executables: ['waterx-predict-keystore'],
      files: KEYSTORE_FILE,
      // The socket file is there; the agent behind it is not.
      pathStat: socketUp,
      signer: () => ({ code: 1, stderr: 'waterx-predict-keystore: no agent at the socket' }),
      routes: READY_ROUTES,
    });
    expect(answer.state).toBe('SESSION_FAILED');
    expect(answer.handOver?.to).toBe('AGENT_OPERATOR');
    expect(runs(answer)).toEqual(['npx --no waterx-predict-keystore agent']);
    expect(answer.suggestions.map((row) => row.command)).toEqual(['runtime.doctor']);
    assertBounded(answer);
  });

  it('still lists the agent step when only a socket file says one ran', async () => {
    // A socket outlives the agent that made it, and this runtime will not dial
    // it to find out. A real host followed a hand-over that skipped this step
    // on a machine whose socket was a month stale; the first signature is
    // where that would have surfaced.
    const { answer } = await next({
      env: {},
      homeDir: HOME,
      executables: ['waterx-predict-keystore'],
      files: KEYSTORE_FILE,
      pathStat: socketUp,
    });
    expect(runs(answer)[0]).toBe('npx --no waterx-predict-keystore agent');
    expect(answer.handOver?.steps?.[0]?.why).toMatch(/does not prove an agent is behind it/u);
  });

  it('gets out of the way once every step is done', async () => {
    const { result, answer } = await next({
      env: keystoreEnv(),
      homeDir: HOME,
      executables: ['waterx-predict-keystore'],
      files: KEYSTORE_FILE,
      pathStat: socketUp,
      routes: READY_ROUTES,
    });
    expect(answer.state).toBe('READY');
    expect(answer.facts.signer).toMatchObject({ kind: 'KEYSTORE', configured: true, installed: true, agent: 'SOCKET_PRESENT' });
    // It signed exactly once — the login challenge — through the keystore command.
    expect(result.signerRuns.map((run) => run.command)).toEqual([['waterx-predict-keystore', 'sign']]);
  });

  it('leaves a different signer alone', async () => {
    const { answer } = await next({ env: CONFIGURED_ENV, homeDir: HOME, files: KEYSTORE_FILE, routes: READY_ROUTES });
    expect(answer.state).toBe('READY');
    expect(answer.facts.signer).toEqual({ kind: 'EXTERNAL_COMMAND' });
  });
});

describe('next, when the server does not cooperate', () => {
  it('sends a failed session to doctor, and reads nothing else', async () => {
    const { result, answer } = await next({
      env: CONFIGURED_ENV,
      routes: {
        'POST /agent-api/v1/auth': {
          status: 401,
          body: { error: { code: 'UNAUTHENTICATED', message: 'bad signature', retryable: false } },
        },
      },
    });

    expect(result.exit).toBe(EXIT_CODES.OK);
    expect(answer.state).toBe('SESSION_FAILED');
    expect(answer.facts.session).toBe('UNAUTHENTICATED');
    expect(answer.suggestions.map((row) => row.command)).toEqual(['runtime.doctor']);
    expect(result.fetches.map((call) => call.method)).toEqual(['POST']);
    assertBounded(answer);
  });

  it('relays the server\'s own sentence when the agent API is switched off on a deployment', async () => {
    // The backend refuses the login on a deployment without the agent API
    // enabled using RECONCILIATION_REQUIRED — a code that means something else.
    // Only the message says what happened, so it is relayed, not reinterpreted.
    const { answer } = await next({
      env: CONFIGURED_ENV,
      routes: {
        'POST /agent-api/v1/auth': {
          status: 409,
          body: {
            error: {
              code: 'RECONCILIATION_REQUIRED',
              message: 'The Predict Agent API is not configured on this deployment',
              retryable: false,
            },
          },
        },
      },
    });
    expect(answer.state).toBe('SESSION_FAILED');
    expect(answer.headline).toContain('RECONCILIATION_REQUIRED: The Predict Agent API is not configured on this deployment');
    expect(answer.suggestions.map((row) => row.command)).not.toContain('order.reconcile');
  });

  it('does not read a failed listing as "nothing granted"', async () => {
    const { answer } = await next({
      env: CONSOLE_ENV,
      routes: { 'POST /agent-api/v1/auth': AUTH_OK, [ACCOUNTS]: SERVER_DOWN },
    });

    // AWAITING_OWNER here would send an owner to re-sign a grant they may
    // already have made.
    expect(answer.state).toBe('AUTHORIZATION_UNKNOWN');
    expect(answer.stop).toBe(false);
    expect(answer.handOver).toBeUndefined();
    expect(answer.requirements.find((row) => row.id === 'delegation')?.state).toBe('UNCHECKED');
    assertBounded(answer);
  });

  it('does not read a failed chain read as a missing delegation', async () => {
    const { answer } = await next({
      env: CONSOLE_ENV,
      routes: {
        'POST /agent-api/v1/auth': AUTH_OK,
        [ACCOUNTS]: listing(
          account({ delegation: { mayPlaceOrder: null, mayRequestClose: null, checkedAt: '2026-08-01T00:00:00.000Z' } }),
        ),
      },
    });
    expect(answer.state).toBe('AUTHORIZATION_UNKNOWN');
    expect(answer.stop).toBe(false);
    assertBounded(answer);
  });

  it('refuses to vouch for an account it could not read', async () => {
    const { answer } = await next({
      env: CONFIGURED_ENV,
      routes: { ...READY_ROUTES, [EXECUTIONS]: SERVER_DOWN },
    });

    // The execution read is what proves nothing is in flight. Without it, READY
    // would offer an order beside one that may still be filling.
    expect(answer.state).toBe('ACCOUNT_UNREADABLE');
    expect(answer.facts.account).toEqual({ status: 'UNREAD', reason: 'SERVICE_UNAVAILABLE' });
    expect(answer.suggestions.map((row) => row.command)).not.toContain('order.preview');
    assertBounded(answer);
  });
});

describe('next, when a person has to act', () => {
  it('hands the owner a link that grants nothing, and waits', async () => {
    const { result, answer } = await next(
      { env: CONSOLE_ENV, routes: { 'POST /agent-api/v1/auth': AUTH_OK, [ACCOUNTS]: listing() } },
      ['--label', 'momentum-bot'],
    );

    expect(result.exit).toBe(EXIT_CODES.OK);
    expect(answer.state).toBe('AWAITING_OWNER');
    expect(answer.stop).toBe(true);
    expect(answer.actor).toBe('ACCOUNT_OWNER');
    const url = new URL(answer.handOver?.authorizationUrl ?? '');
    expect(url.origin).toBe('https://console.test.invalid');
    expect(url.searchParams.get('agent')).toBe(AGENT_WALLET);
    expect([...url.searchParams.keys()].sort()).toEqual(['agent', 'label']);
    expect(answer.handOver?.message).toMatch(/never ask for their key/u);
    // What the agent may do meanwhile is wait — a read.
    expect(answer.suggestions[0]?.argv).toEqual(['onboard', '--wait']);
    expect(answer.nextStep.actor).toBe('ACCOUNT_OWNER');
    // The link is for a person, so it is on stderr as well as in the document.
    expect(result.stderr).toContain(url.toString());
    assertBounded(answer);
  });

  it('says there is no link rather than inventing a console host', async () => {
    const { answer } = await next({
      env: CONFIGURED_ENV,
      routes: { 'POST /agent-api/v1/auth': AUTH_OK, [ACCOUNTS]: listing() },
    });
    expect(answer.state).toBe('AWAITING_OWNER');
    expect(answer.handOver?.authorizationUrl).toBeUndefined();
    expect(answer.handOver?.message).toContain('WATERX_PREDICT_CONSOLE_URL');
    assertBounded(answer);
  });

  it('tells a suspended agent that only the owner can lift it', async () => {
    const { answer } = await next({
      env: CONSOLE_ENV,
      routes: { 'POST /agent-api/v1/auth': AUTH_OK, [ACCOUNTS]: listing(account({ isSuspended: true })) },
    });
    expect(answer.state).toBe('AWAITING_OWNER');
    expect(answer.headline).toMatch(/suspended/u);
    expect(answer.handOver?.to).toBe('ACCOUNT_OWNER');
    assertBounded(answer);
  });

  it('asks which account rather than choosing whose money trades', async () => {
    const { result, answer } = await next({
      env: CONFIGURED_ENV,
      routes: {
        'POST /agent-api/v1/auth': AUTH_OK,
        [ACCOUNTS]: listing(account(), account({ accountId: OTHER_ACCOUNT })),
      },
    });

    expect(answer.state).toBe('ACCOUNT_CHOICE_NEEDED');
    expect(answer.handOver?.to).toBe('AGENT_OPERATOR');
    expect(answer.handOver?.message).toContain(ACCOUNT_ID);
    expect(answer.handOver?.message).toContain(OTHER_ACCOUNT);
    expect(answer.suggestions[0]?.needsFromUser?.map((need) => need.field)).toEqual(['accountId']);
    expect(answer.facts.accountId).toBeNull();
    // No account was chosen, so no account was read.
    expect(result.fetches.map((call) => new URL(call.url).pathname)).toEqual([
      '/agent-api/v1/auth',
      '/agent-api/v1/predict/accounts',
    ]);
    assertBounded(answer);
  });

  it('settles the choice once the user has made it', async () => {
    const { answer } = await next(
      {
        env: CONFIGURED_ENV,
        routes: { ...READY_ROUTES, [ACCOUNTS]: listing(account(), account({ accountId: OTHER_ACCOUNT })) },
      },
      ['--accountId', ACCOUNT_ID],
    );
    expect(answer.state).toBe('READY');
    expect(answer.facts.accountId).toBe(ACCOUNT_ID);
  });
});

describe('next, when something is in flight', () => {
  it('puts an unsettled execution ahead of everything, and offers no order', async () => {
    const { result, answer } = await next({
      env: CONFIGURED_ENV,
      routes: {
        ...READY_ROUTES,
        // Blocked AND holding positions AND an order still filling: the order
        // still filling is the one that matters.
        [LIMITS]: limitsWith(['ORDERS_PER_HOUR_EXHAUSTED']),
        [POSITIONS]: positions(2),
        [EXECUTIONS]: executions(
          execution('PENDING_FILL', 'exec_open_0000000000001'),
          execution('FILLED', 'exec_done_0000000000001'),
          execution('SUBMITTED', 'exec_open_0000000000002'),
        ),
      },
    });

    expect(result.exit).toBe(EXIT_CODES.OK);
    expect(answer.state).toBe('UNSETTLED_EXECUTION');
    expect(answer.stop).toBe(false);
    expect(answer.suggestions.map((row) => row.argv)).toEqual([
      ['order', 'reconcile', '--executionId', 'exec_open_0000000000001'],
      ['order', 'reconcile', '--executionId', 'exec_open_0000000000002'],
    ]);
    expect(answer.facts.account?.unsettledExecutions?.map((row) => row.executionId)).toEqual([
      'exec_open_0000000000001',
      'exec_open_0000000000002',
    ]);
    // The page size is what bounds the scan, and it is asked for explicitly.
    const executionsCall = result.fetches.find((call) => call.url.includes('/executions'));
    expect(new URL(executionsCall?.url ?? 'https://x.invalid').searchParams.get('limit')).toBe('50');
    assertBounded(answer);
  });

  it('never proposes a write, and never signs one', async () => {
    const { result } = await next({
      env: CONFIGURED_ENV,
      routes: { ...READY_ROUTES, [EXECUTIONS]: executions(execution('AWAITING_SIGNATURE')) },
    });
    expect(result.fetches.filter((call) => call.method !== 'GET').map((call) => call.url)).toEqual([
      'https://predict.test.invalid/agent-api/v1/auth',
    ]);
    // One signature: the login challenge. Never a transaction.
    expect(result.signerRuns).toHaveLength(1);
    expect(result.signerRuns[0]?.input).not.toMatch(/TRANSACTION/u);
    expect(result.stdout).not.toContain('session-token-that-must-never-be-printed');
    expect(result.stderr).not.toContain('session-token-that-must-never-be-printed');
  });

  it('reports a Runner job of unknown outcome before any blocker', async () => {
    const { result, answer } = await next(
      {
        env: CONFIGURED_ENV,
        routes: { ...READY_ROUTES, [LIMITS]: limitsWith(['NO_BUY_CAPACITY']) },
        runner: {
          replies: {
            'strategy.list': {
              result: {
                strategies: [
                  { jobId: 'job_watching_000000001', state: 'WATCHING', terminal: false },
                  { jobId: 'job_unknown_0000000001', state: 'UNKNOWN_PENDING', terminal: false },
                  { jobId: 'job_done_00000000000001', state: 'FILLED', terminal: true },
                ],
              },
            },
          },
        },
      },
      ['--runner-dir', RUNNER_DIR],
    );

    expect(answer.state).toBe('STRATEGY_NEEDS_ATTENTION');
    expect(answer.suggestions.map((row) => row.argv)).toEqual([
      ['strategy', 'get', '--jobId', 'job_unknown_0000000001'],
    ]);
    // The Runner was asked to list, filtered to this account, and nothing else.
    const requests = result.runnerFrames.filter((frame) => frame['type'] === 'request');
    expect(requests).toEqual([
      expect.objectContaining({ command: 'strategy.list', input: { accountId: ACCOUNT_ID } }),
    ]);
    assertBounded(answer);
  });

  it('calls live jobs on a Runner that is not driving armed and asleep', async () => {
    const { answer } = await next(
      {
        env: CONFIGURED_ENV,
        routes: READY_ROUTES,
        runner: {
          driving: false,
          replies: {
            'strategy.list': {
              result: { strategies: [{ jobId: 'job_watching_000000001', state: 'WATCHING', terminal: false }] },
            },
          },
        },
      },
      ['--runner-dir', RUNNER_DIR],
    );
    expect(answer.state).toBe('STRATEGY_NEEDS_ATTENTION');
    expect(answer.handOver?.to).toBe('AGENT_OPERATOR');
    expect(answer.handOver?.message).toMatch(/not driving/u);
    assertBounded(answer);
  });

  it('treats no Runner as the ordinary case, without dialling', async () => {
    const { result, answer } = await next({ env: CONFIGURED_ENV, routes: READY_ROUTES });
    expect(answer.state).toBe('READY');
    expect(answer.facts.runner).toEqual({ status: 'ABSENT' });
    expect(result.runnerDials).toEqual([]);
  });

  it('reports a Runner it could not read, and still answers', async () => {
    const { answer } = await next(
      {
        env: CONFIGURED_ENV,
        routes: READY_ROUTES,
        runner: { replies: {} },
        // World-readable: refused before any dial.
        pathStat: (path) =>
          path === RUNNER_DIR ? { kind: 'directory', uid: process.getuid?.() ?? 0, mode: 0o777 } : null,
      },
      ['--runner-dir', RUNNER_DIR],
    );
    expect(answer.state).toBe('READY');
    expect(answer.facts.runner?.status).toBe('UNREADABLE');
  });
});

describe('next, when the limits say no', () => {
  it('sends an owner-only blocker to the owner', async () => {
    const { answer } = await next({
      env: CONFIGURED_ENV,
      routes: { ...READY_ROUTES, [LIMITS]: limitsWith(['NO_BUY_CAPACITY']), [POSITIONS]: positions(1) },
    });
    expect(answer.state).toBe('TRADING_BLOCKED');
    expect(answer.handOver?.to).toBe('ACCOUNT_OWNER');
    // No buying power is not no selling power.
    expect(answer.suggestions.map((row) => row.command)).toEqual(['account.risk-limits', 'account.positions']);
    assertBounded(answer);
  });

  it('lets a rolling window roll, without bothering anyone', async () => {
    const { answer } = await next({
      env: CONFIGURED_ENV,
      routes: { ...READY_ROUTES, [LIMITS]: limitsWith(['ORDERS_PER_HOUR_EXHAUSTED']) },
    });
    expect(answer.state).toBe('TRADING_BLOCKED');
    expect(answer.stop).toBe(false);
    expect(answer.suggestions.map((row) => row.command)).toEqual(['account.risk-limits']);
    assertBounded(answer);
  });
});

describe('next, when nothing stands in the way', () => {
  it('asks the user what to trade, and previews rather than places', async () => {
    const { result, answer } = await next({
      env: CONFIGURED_ENV,
      routes: { ...READY_ROUTES, [POSITIONS]: positions(2) },
    });

    expect(result.exit).toBe(EXIT_CODES.OK);
    expect(answer.state).toBe('READY');
    expect(answer.stop).toBe(false);
    expect(answer.facts.accountId).toBe(ACCOUNT_ID);
    expect(answer.facts.policy).toEqual({ mode: 'interactive', writes: 'NEEDS_APPROVAL' });
    expect(answer.suggestions.map((row) => row.command)).toEqual([
      'market.search',
      'order.preview',
      'account.positions',
    ]);
    const [search, preview] = answer.suggestions;
    expect(search?.argv).toEqual(['market', 'search', '--tradeable']);
    expect(search?.needsFromUser?.map((need) => need.field)).toEqual(['search']);
    // `order preview` takes a structured document, so the account rides in it.
    expect(preview?.argv).toEqual(['order', 'preview', '--input', JSON.stringify({ accountId: ACCOUNT_ID })]);
    expect(preview?.input).toEqual({ accountId: ACCOUNT_ID });
    expect(preview?.invocation).toContain(`"accountId":"${ACCOUNT_ID}","marketId":<marketId>`);
    // Everything that decides the money is the user's.
    expect(preview?.needsFromUser?.map((need) => need.field)).toEqual([
      'marketId',
      'outcomeId',
      'side',
      'size',
      'maxSlippageBps',
    ]);
    expect(preview?.why).toMatch(/approval is theirs/u);
    expect(answer.requirements.every((row) => row.state === 'SATISFIED')).toBe(true);
    expect(answer.nextStep.actor).toBe('NOBODY');
    assertBounded(answer);
  });

  it('offers no order under a read-only policy, and says why', async () => {
    const { answer } = await next({ env: CONFIGURED_ENV, routes: READY_ROUTES }, ['--policy', 'read-only']);
    expect(answer.state).toBe('READY');
    expect(answer.facts.policy.writes).toBe('REFUSED');
    expect(answer.suggestions.map((row) => row.command)).toEqual(['market.search']);
    expect(answer.headline).toMatch(/read-only/u);
    assertBounded(answer);
  });
});

/**
 * "Run it verbatim" is a claim about the CLI's parser, not about this module, so
 * it is checked against the parser: each suggestion goes back through the CLI
 * and must not be refused as malformed. What it does next — a network error in
 * a harness with no routes — is beside the point.
 */
describe('next, as something the CLI will accept back', () => {
  const MALFORMED = new Set(['USAGE', 'UNKNOWN_COMMAND', 'INVALID_INPUT']);
  const scenarios: [string, InvokeOptions, readonly string[]][] = [
    ['unconfigured', { env: {} }, []],
    ['awaiting owner', { env: CONSOLE_ENV, routes: { 'POST /agent-api/v1/auth': AUTH_OK, [ACCOUNTS]: listing() } }, []],
    ['unsettled', { env: CONFIGURED_ENV, routes: { ...READY_ROUTES, [EXECUTIONS]: executions(execution('SUBMITTED')) } }, []],
    ['blocked', { env: CONFIGURED_ENV, routes: { ...READY_ROUTES, [LIMITS]: limitsWith(['NO_BUY_CAPACITY']), [POSITIONS]: positions(1) } }, []],
    ['ready', { env: CONFIGURED_ENV, routes: { ...READY_ROUTES, [POSITIONS]: positions(1) } }, []],
  ];

  it.each(scenarios)('parses every complete suggestion from %s', async (_name, options, extra) => {
    const { answer } = await next(options, extra);
    for (const suggestion of answer.suggestions.filter((row) => row.needsFromUser === undefined)) {
      const rerun = await invoke(suggestion.argv, { env: {} });
      expect(MALFORMED.has(rerun.envelope.error?.code ?? ''), `${suggestion.invocation}: ${rerun.envelope.error?.message ?? ''}`).toBe(false);
    }
  });

  it('parses the preview once the user has filled in what it asked for', async () => {
    const { answer } = await next({ env: CONFIGURED_ENV, routes: READY_ROUTES });
    const preview = answer.suggestions.find((row) => row.command === 'order.preview');
    const chosen: Record<string, unknown> = {
      marketId: `0x${'2'.repeat(64)}`,
      outcomeId: 'YES',
      side: 'BUY',
      size: { buyAmount: '5' },
      maxSlippageBps: 100,
    };
    expect(Object.keys(chosen)).toEqual(preview?.needsFromUser?.map((need) => need.field));
    const document = { ...preview?.input, ...chosen };
    expect(validateCommandInput('order.preview', document).ok).toBe(true);
    const rerun = await invoke(['order', 'preview', '--input', JSON.stringify(document)], { env: {} });
    expect(MALFORMED.has(rerun.envelope.error?.code ?? '')).toBe(false);
  });
});

/**
 * The order, pinned without a server.
 *
 * Each case sets every later condition too, so a reordering that let a later
 * state win would be caught here even if no end-to-end case happened to combine
 * the two.
 */
describe('decideNext precedence', () => {
  const satisfied = AGENT_REQUIREMENTS.map((requirement) => ({
    ...requirement,
    state: 'SATISFIED' as const,
    evidence: 'fixture',
  }));
  const ready = {
    status: 'READY' as const,
    account: account() as never,
    accounts: [account() as never],
    nextStep: { actor: 'NOBODY' as const, action: '' },
  };
  const blockedAccount = {
    limits: { ...EFFECTIVE_LIMITS_OK.body, blockers: ['SUSPENDED'] } as never,
    unsettled: [execution('PENDING_FILL') as never],
    positions: 3,
  };
  const everythingWrong: NextFacts = {
    requirements: satisfied,
    writes: 'NEEDS_APPROVAL',
    session: { ok: true },
    onboarding: ready,
    account: blockedAccount,
    runner: {
      status: 'ANSWERED',
      driving: false,
      strategies: [{ jobId: 'job_unknown_0000000001', state: 'UNKNOWN_PENDING', terminal: false }],
    },
  };

  it('reports setup first, even with an owner gap and an unsettled order', () => {
    const facts: NextFacts = {
      ...everythingWrong,
      requirements: satisfied.map((row) => (row.id === 'signer' ? { ...row, state: 'MISSING' } : row)),
    };
    expect(decideNext(facts).state).toBe('SETUP_INCOMPLETE');
  });

  it('reports an unsettled execution ahead of the Runner and the limits', () => {
    expect(decideNext(everythingWrong).state).toBe('UNSETTLED_EXECUTION');
  });

  it('reports an unknown Runner outcome ahead of an idle Runner and the limits', () => {
    const facts: NextFacts = {
      ...everythingWrong,
      account: { ...blockedAccount, unsettled: [] },
    };
    const decided = decideNext(facts);
    expect(decided.state).toBe('STRATEGY_NEEDS_ATTENTION');
    expect(decided.stop).toBe(false);
  });

  it('reports the limits only once nothing is in flight', () => {
    const facts: NextFacts = {
      ...everythingWrong,
      account: { ...blockedAccount, unsettled: [] },
      runner: { status: 'ABSENT' },
    };
    expect(decideNext(facts).state).toBe('TRADING_BLOCKED');
  });

  it('never suggests a write in any state', () => {
    const { account: _account, ...unread } = everythingWrong;
    const { session: _session, ...unconfigured } = everythingWrong;
    const variants: NextFacts[] = [
      everythingWrong,
      unread,
      { ...everythingWrong, session: { ok: false, code: 'TRANSPORT_FAILED', message: 'no route' } },
      unconfigured,
      { ...everythingWrong, onboarding: { failed: 'SERVICE_UNAVAILABLE' } },
      { ...everythingWrong, writes: 'WITHIN_SCOPE', runner: { status: 'ABSENT' }, account: {
        limits: EFFECTIVE_LIMITS_OK.body as never, unsettled: [], positions: 0,
      } },
    ];
    for (const facts of variants) {
      for (const suggestion of decideNext(facts).suggestions) {
        expect(getCommand(suggestion.command)?.classification).toBe('read');
      }
    }
  });
});
