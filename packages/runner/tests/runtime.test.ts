/**
 * Turning a configuration into the three collaborators a scheduler drives with.
 *
 * What this file is really asserting is that the seams line up:
 *
 *   1. **One session, one socket.** The price observer runs over the *client's*
 *      own quote stream, so REST and WS present the same token and a rollover
 *      mid-strategy is not two independent re-authentications.
 *   2. **One keystore, two signers, and only one road to an order.** Both signing
 *      paths run the configured command; the client's authentication signer
 *      refuses `signTransaction` outright, so nothing in this process can produce
 *      an order signature except the strategy signer, which reads the policy the
 *      job was admitted under.
 *   3. **`close` really releases.** A daemon that stopped without dropping the
 *      subscriptions and the socket would be a process that will not exit after
 *      Ctrl-C, which for a Runner is precisely the wrong impression.
 *
 * Nothing here spawns a process, opens a socket or binds a port: the signer
 * runner, the socket transport and `fetch` are all injected.
 */
import { describe, expect, it } from 'vitest';

import type { QuoteSocket } from '@waterx/predict-agent-sdk';

import type { RunnerDriverConfig } from '../src/config.ts';
import type { JobPolicySnapshot } from '../src/job.ts';
import { buildRunnerDriver, type RunnerDriverBundle } from '../src/runtime.ts';
import type { SignerRunResult, SignerRunner } from '../src/signer.ts';
import type { StrategySignRequest, WatchKey } from '../src/strategy/gateway.ts';
import { T0 } from './harness.ts';

const SIGNATURE = 'dGhlLXNpZ25hdHVyZQ==';
const WALLET = '0xagent';
const CONFIG: RunnerDriverConfig = {
  baseUrl: 'https://predict.test/api',
  agentWallet: WALLET,
  signerCommand: ['/opt/keystore/bin/waterx-sign', '--slot', '3'],
  signerTimeoutMs: 4_000,
};

const BUY: WatchKey = { marketId: 'mkt_1', outcomeId: 'YES', side: 'BUY' };

const DELEGATED: JobPolicySnapshot = {
  mode: 'delegated-auto',
  source: 'file:~/.waterx/policy.json',
  maxOrderNotional: '100.000000',
};

const signRequest = (): StrategySignRequest => ({
  jobId: 'job_1',
  legIndex: 0,
  agentWallet: WALLET,
  policy: DELEGATED,
  sponsoredTransactionBytes: 'c3BvbnNvcmVkLXR4LWJ5dGVz',
});

/**
 * Let the connection the observer started finish.
 *
 * `observe` deliberately does not wait for a socket — a job's first pass buys a
 * subscription rather than an answer — so the connect, the handshake and the
 * subscribe land on later microtasks.
 */
const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

/** A socket whose lifecycle this test observes; it never connects to anything. */
class FakeSocket implements QuoteSocket {
  readonly sent: { event: string; payload: unknown }[] = [];
  disconnects = 0;

  on(): void {
    /* the stream registers handlers; this test never delivers a frame */
  }

  emit(event: string, payload: unknown): void {
    this.sent.push({ event, payload });
  }

  disconnect(): void {
    this.disconnects += 1;
  }
}

interface Built {
  readonly bundle: RunnerDriverBundle;
  readonly sockets: FakeSocket[];
  readonly handshakes: { url: string; token: string }[];
  readonly runs: { command: readonly string[]; stdin: string; timeoutMs: number }[];
  readonly diagnostics: string[];
}

const build = (
  answer: SignerRunResult = { code: 0, stdout: JSON.stringify({ signature: SIGNATURE }), stderr: '', timedOut: false },
): Built => {
  const runs: Built['runs'] = [];
  const sockets: FakeSocket[] = [];
  const handshakes: Built['handshakes'] = [];
  const diagnostics: string[] = [];

  const run: SignerRunner = async (command, stdin, timeoutMs) => {
    runs.push({ command, stdin, timeoutMs });
    return answer;
  };

  const bundle = buildRunnerDriver(CONFIG, {
    run,
    now: () => T0,
    onDiagnostic: (text) => diagnostics.push(text),
    quoteStreamConnector: async ({ url, handshake }) => {
      // The real connector asks for the credential the same way: a function, so
      // a reconnect re-reads the session rather than replaying a stale token.
      handshakes.push({ url, token: (await handshake()).token });
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    // The only route this test's client ever reaches: the one that mints a token.
    fetch: (async () =>
      new Response(JSON.stringify({ token: 'session-token', expiresIn: 3_600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof globalThis.fetch,
  });

  return { bundle, sockets, handshakes, runs, diagnostics };
};

describe('a driver is built whole or not at all', () => {
  it('supplies a gateway, a signer and a price source together', () => {
    const { bundle } = build();
    try {
      expect(bundle.driver.gateway).toBeDefined();
      expect(bundle.driver.signer).toBeDefined();
      expect(bundle.driver.prices).toBeDefined();
    } finally {
      bundle.close();
    }
  });

  it('hands the executor the narrow gateway, not the whole client', () => {
    const { bundle } = build();
    try {
      // `executeMarketOrder` creates, signs and submits in one call, with the
      // client's own signer and no policy snapshot in sight. It is not reachable
      // from the driver: the executor gets create and submit as separate calls
      // because it must persist the execution id between them.
      expect((bundle.driver.gateway as unknown as Record<string, unknown>)['executeMarketOrder']).toBeUndefined();
      expect(typeof bundle.driver.gateway.createExecution).toBe('function');
      expect(typeof bundle.driver.gateway.submitExecution).toBe('function');
    } finally {
      bundle.close();
    }
  });

  it('starts nothing while it is being built', () => {
    // No child process, no socket, no request. A Runner that authenticated at
    // construction would fail to start over a server that was merely restarting.
    const { runs, sockets } = build();
    expect(runs).toEqual([]);
    expect(sockets).toEqual([]);
  });
});

describe('one session, one socket', () => {
  it('watches prices over the client’s own stream, authenticating through the keystore', async () => {
    const built = build();
    try {
      // The first pass buys a subscription, not an answer.
      expect(await built.bundle.driver.prices.observe(BUY)).toBeNull();
      await settle();

      expect(built.sockets).toHaveLength(1);
      expect(built.handshakes).toHaveLength(1);
      expect(built.handshakes[0]?.url).toContain('predict.test');
      // Authenticated by signing a personal message with the configured keystore
      // command — the Runner holds no token from its configuration, because a
      // seven-day mandate outlives any token it could have been given.
      expect(built.runs).toHaveLength(1);
      expect(built.runs[0]?.command).toEqual(CONFIG.signerCommand);
      const stdin = JSON.parse(built.runs[0]?.stdin ?? '{}') as Record<string, unknown>;
      expect(stdin['type']).toBe('PERSONAL_MESSAGE');
      expect(stdin['agentWallet']).toBe(WALLET);
    } finally {
      built.bundle.close();
    }
  });

  it('opens one socket for however many topics it watches', async () => {
    const built = build();
    try {
      await built.bundle.driver.prices.observe(BUY);
      await settle();
      await built.bundle.driver.prices.observe({ marketId: 'mkt_2', outcomeId: 'NO', side: 'SELL' });
      await settle();
      expect(built.sockets).toHaveLength(1);
    } finally {
      built.bundle.close();
    }
  });
});

describe('one keystore, two signers', () => {
  it('signs an order through the strategy signer, under the configured timeout', async () => {
    const built = build();
    try {
      const signature = await built.bundle.driver.signer.sign(signRequest());
      expect(signature).toBe(SIGNATURE);
      expect(built.runs).toHaveLength(1);
      expect(built.runs[0]?.timeoutMs).toBe(CONFIG.signerTimeoutMs);
      const stdin = JSON.parse(built.runs[0]?.stdin ?? '{}') as Record<string, unknown>;
      expect(stdin['type']).toBe('TRANSACTION');
    } finally {
      built.bundle.close();
    }
  });

  it('opens one session for many calls rather than one per call', async () => {
    const built = build();
    try {
      await built.bundle.driver.gateway.getMarket('mkt_1').catch(() => undefined);
      await built.bundle.driver.gateway.getMarket('mkt_1').catch(() => undefined);
      await built.bundle.driver.prices.observe(BUY);
      await settle();

      // One keystore invocation: a login per tick would be a signature request per
      // tick, which for a keystore that prompts is an operator's afternoon.
      const personal = built.runs.filter(
        (call) => (JSON.parse(call.stdin) as { type?: string }).type === 'PERSONAL_MESSAGE',
      );
      expect(personal).toHaveLength(1);
    } finally {
      built.bundle.close();
    }
  });
});

describe('close releases what it took', () => {
  it('drops the subscriptions and disconnects the socket', async () => {
    const built = build();
    await built.bundle.driver.prices.observe(BUY);
      await settle();
    expect(built.bundle.prices.topics()).toHaveLength(1);

    built.bundle.close();

    expect(built.bundle.prices.topics()).toEqual([]);
    expect(built.sockets[0]?.disconnects).toBeGreaterThanOrEqual(1);
    // And a closed observer reports nothing rather than resurrecting a topic.
    expect(await built.bundle.driver.prices.observe(BUY)).toBeNull();
      await settle();
  });

  it('is idempotent, because a daemon may stop twice', async () => {
    const built = build();
    await built.bundle.driver.prices.observe(BUY);
      await settle();
    built.bundle.close();
    expect(() => built.bundle.close()).not.toThrow();
  });
});
