/**
 * Turning a resolved configuration into the three collaborators a daemon drives
 * with — or into nothing at all.
 *
 * This is the only place in the package that constructs a `SchedulerDriver`, and
 * it is deliberately all-or-nothing: {@link buildRunnerDriver} takes a
 * {@link RunnerDriverConfig}, which `resolveRunnerConfig` produces only when every
 * piece is present. There is no code path here that yields a driver with a
 * gateway and no signer. A Runner in that shape would watch a market, meet a
 * target, create an execution and only then discover it cannot authorize it —
 * leaving an order on the server and a local job that can never resolve it. That
 * is the precise ambiguity the side-effect ledger exists to recover from, and
 * manufacturing it on purpose at start-up would be indefensible.
 *
 * ## One session, two sockets, one keystore
 *
 * The gateway is a `PredictAgentClient`, which satisfies `StrategyGateway`
 * structurally. Its quote stream is the client's own (`quoteStream: 'native'`),
 * pulled out through `client.quoteStream()` rather than built beside it, so REST
 * and WS share one session: a token rolled over mid-strategy is the one the next
 * reconnect presents, and nothing here ever handles the token itself.
 *
 * Both signing paths run the same keystore command, and neither can do the
 * other's job. The client authenticates with an `AgentSigner` that signs a
 * `PERSONAL_MESSAGE` and **throws** on `signTransaction`; the driver signs orders
 * with the `StrategySigner`, which emits `TRANSACTION` only and only under a
 * policy that permits unattended signing. So there is exactly one road to an
 * order signature in this process and it runs past the policy gate.
 *
 * ## The session is opened lazily, and re-opened by itself
 *
 * Nothing here authenticates at construction, and `runnerd` does not refuse to
 * start over a server that is merely restarting: a Runner that could only open a
 * session at boot would be a Runner whose durable jobs die of a deploy. Instead
 * every call through the gateway — and every price observation, because the socket
 * handshake presents the same token — first ensures a session exists, joining one
 * mint rather than racing several. Once a token exists the client's own
 * `autoReauthenticate` handles expiry and rejection, which is the path that keeps
 * a logical write's idempotency key and exact bytes across a token dying
 * mid-order.
 *
 * ## What `close` is for
 *
 * The observer holds subscriptions and the client holds a socket, and both keep
 * the event loop alive. A daemon that stopped without releasing them would be a
 * process that will not exit after Ctrl-C — which, for a Runner whose whole
 * disclosure is "this stops when you stop it", is the wrong impression to give.
 */
import { PredictAgentClient, type QuoteStreamConnector } from '@waterx/predict-agent-sdk';

import type { Clock } from './clock.ts';
import { systemClock } from './clock.ts';
import type { RunnerDriverConfig } from './config.ts';
import { QuoteStreamPriceObserver } from './prices.ts';
import type { SchedulerDriver } from './scheduler.ts';
import {
  createExternalCommandAuthSigner,
  createExternalCommandSigner,
  type SignerRunner,
} from './signer.ts';
import type { PriceObserver, StrategyGateway } from './strategy/gateway.ts';

export interface BuildRunnerDriverOptions {
  /**
   * How the keystore command is actually run. Injected, so no test in this
   * package spawns a process; `runnerd` passes the child-process runner.
   */
  readonly run: SignerRunner;
  readonly now?: Clock;
  /**
   * The child's **stderr**, and the observer's own notices. Never a token, a
   * signature or transaction bytes.
   */
  readonly onDiagnostic?: (text: string) => void;
  /** Injectable socket transport, so a test opens no connection. */
  readonly quoteStreamConnector?: QuoteStreamConnector;
  /** How long a topic survives without being asked about. See `prices.ts`. */
  readonly priceIdleMs?: number;
  /**
   * Injectable REST transport, for a test and for a runtime whose `fetch` is not
   * global. `runnerd` leaves it unset.
   */
  readonly fetch?: typeof globalThis.fetch;
}

export interface RunnerDriverBundle {
  readonly driver: SchedulerDriver;
  /**
   * The observer, exposed so the daemon can report topic health. A topic gone
   * permanently quiet under `DEGRADED` otherwise looks exactly like a market
   * nobody is trading.
   */
  readonly prices: QuoteStreamPriceObserver;
  /** Releases the subscriptions and the socket. Idempotent. */
  close(): void;
}

/**
 * "Open a session if there isn't one", collapsed to one handshake.
 *
 * `authenticate()` joins a mint already in flight but starts a fresh one when a
 * token already exists, so asking it on every call would mean a login per tick.
 * `isAuthenticated()` answers the only question that avoids that — and answers it
 * without handing anything the token itself.
 *
 * A failed mint clears the memo rather than being remembered: the server being
 * down for a minute must not leave a seven-day strategy permanently unable to
 * authenticate.
 */
const sessionOpener = (client: PredictAgentClient): (() => Promise<void>) => {
  let opening: Promise<void> | undefined;
  return async () => {
    if (client.isAuthenticated()) return;
    opening ??= client
      .authenticate()
      .then(() => undefined)
      .finally(() => {
        opening = undefined;
      });
    await opening;
  };
};

/**
 * The gateway, with a session guaranteed before each call.
 *
 * Wrapped rather than opened once at start-up because the token is not the only
 * thing that can be absent: a Runner restarted while the API was down would
 * otherwise hold a client that can never authenticate. Every method opens the
 * session *before* it acts, so a failure to authenticate happens before a write
 * exists rather than between a create and its submit.
 */
const authenticating = (client: PredictAgentClient, ensure: () => Promise<void>): StrategyGateway => ({
  getQuote: async (request, signal) => {
    await ensure();
    return await client.getQuote(request, signal);
  },
  createExecution: async (request, callOptions) => {
    await ensure();
    return await client.createExecution(request, callOptions);
  },
  submitExecution: async (executionId, signature, signal) => {
    await ensure();
    return await client.submitExecution(executionId, signature, signal);
  },
  getExecution: async (executionId, signal) => {
    await ensure();
    return await client.getExecution(executionId, signal);
  },
  getMarket: async (marketId, signal) => {
    await ensure();
    return await client.getMarket(marketId, signal);
  },
  getEffectiveLimits: async (accountId, signal) => {
    await ensure();
    return await client.getEffectiveLimits(accountId, signal);
  },
  getPositions: async (accountId, page, signal) => {
    await ensure();
    return await client.getPositions(accountId, page, signal);
  },
});

/**
 * The observer, with a session guaranteed before the first subscription.
 *
 * The socket handshake presents the same bearer token the REST calls do, and the
 * stream retires itself after a few refused handshakes — for the life of the
 * process. Subscribing before a session exists would therefore trade a transient
 * "not authenticated yet" for a permanently dead price feed.
 *
 * A failure here reports *nothing observed*, which is what this observer says
 * about every price it cannot vouch for, and the reason goes to the diagnostic
 * channel so it is not silent. The job waits; it is not ended, because being
 * unable to read a price is not evidence about a market.
 */
const watching = (
  prices: PriceObserver,
  ensure: () => Promise<void>,
  onDiagnostic: ((text: string) => void) | undefined,
): PriceObserver => ({
  observe: async (watch, signal) => {
    try {
      await ensure();
    } catch (error: unknown) {
      onDiagnostic?.(
        `could not open a session to watch prices: ${error instanceof Error ? error.message : 'authentication failed'}`,
      );
      return null;
    }
    return await prices.observe(watch, signal);
  },
});

export const buildRunnerDriver = (
  config: RunnerDriverConfig,
  options: BuildRunnerDriverOptions,
): RunnerDriverBundle => {
  const now = options.now ?? systemClock;

  const client = new PredictAgentClient({
    baseUrl: config.baseUrl,
    // Personal-message only. It refuses `signTransaction`, which is what stops
    // `executeMarketOrder` from ever producing an order outside a job's policy.
    signer: createExternalCommandAuthSigner({
      command: config.signerCommand,
      agentWallet: config.agentWallet,
      run: options.run,
      timeoutMs: config.signerTimeoutMs,
      ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
    }),
    quoteStream: 'native',
    ...(options.quoteStreamConnector === undefined
      ? {}
      : { quoteStreamConnector: options.quoteStreamConnector }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  const stream = client.quoteStream();
  /* c8 ignore next 5 -- unreachable: `quoteStream: 'native'` above always yields one */
  if (stream === undefined) {
    throw new Error(
      'the client was configured with a native quote stream but returned none; a driver with no price source must not be built',
    );
  }

  const prices = new QuoteStreamPriceObserver({
    stream,
    now,
    ...(options.priceIdleMs === undefined ? {} : { idleMs: options.priceIdleMs }),
  });

  const signer = createExternalCommandSigner({
    command: config.signerCommand,
    agentWallet: config.agentWallet,
    run: options.run,
    timeoutMs: config.signerTimeoutMs,
    now,
    ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
  });

  const ensureSession = sessionOpener(client);

  return {
    driver: {
      gateway: authenticating(client, ensureSession),
      signer,
      prices: watching(prices, ensureSession, options.onDiagnostic),
    },
    prices,
    close: () => {
      // Subscriptions first, then the socket they were held on.
      prices.close();
      client.close();
    },
  };
};
