/**
 * Turning configuration into an SDK client, and SDK failures into envelopes.
 *
 * The client is built lazily: `describe` and `command-schema` answer with no
 * configuration at all, and constructing a client eagerly would make discovery
 * fail on exactly the machine that most needs to run it.
 */
import {
  DirectDeploymentError,
  DirectVerificationError,
  PredictAgentClient,
  PredictAgentTransportError,
  PredictDirectClient,
  isDirectCapabilityUnavailable,
  isPredictAgentApiError,
  isUnresolvedWrite,
  type IntentStore,
  type MarketCatalog,
} from '@waterx/predict-agent-sdk';

import type { ResolvedConfig } from './config.ts';
import { CliError, isCliError, isCliErrorCode } from './errors.ts';
import {
  EXIT_CODES,
  exitCodeForCliError,
  exitCodeForRunnerError,
  exitCodeForServerError,
  type ExitCode,
} from './exit-codes.ts';
import type { EnvelopeError } from './envelope.ts';
import type { SigningGate } from './policy.ts';
import { isRunnerRefusal } from './runner-ipc.ts';
import { createSigner, type SignerRunner } from './signer.ts';

export interface ClientFactoryOptions {
  readonly config: ResolvedConfig;
  readonly fetch: typeof globalThis.fetch;
  readonly runSigner: SignerRunner;
  onDiagnostic(text: string): void;
  /**
   * The invocation's signing gate. Omitted only where no write can occur (the
   * doctor's reachability probe); a signer without one signs no transaction.
   */
  readonly gate?: SigningGate | undefined;
  /**
   * A session token to open with, outranking the configured one.
   *
   * Separate from `config.token` because a cached session is not configuration:
   * it is a credential this runtime minted earlier and may reuse, and the config
   * file is refused outright for holding anything credential-shaped.
   */
  readonly token?: string | undefined;
  /**
   * Direct mode's durable record of what was submitted. Without it a retry in a
   * later process cannot tell a lost answer from an order never sent, so direct
   * mode refuses to trade without one (see `createClient`).
   */
  readonly intentStore?: IntentStore | undefined;
  readonly marketCatalog?: MarketCatalog | undefined;
  /** Accounts the operator named, verified on chain by direct mode (see its client). */
  readonly accountHints?: readonly string[] | undefined;
}

/**
 * What a command holds. The two clients answer the same questions in the same
 * types (ADR-0013); where direct mode has no public source it says so by
 * throwing, and `toEnvelopeError` turns that into CAPABILITY_UNAVAILABLE.
 */
export type TradingClient = PredictAgentClient | PredictDirectClient;

export const isDirectClient = (client: TradingClient): client is PredictDirectClient =>
  client instanceof PredictDirectClient;

export function createClient(options: ClientFactoryOptions): TradingClient {
  const { config } = options;
  if (config.baseUrl === undefined) {
    throw new CliError(
      'NOT_CONFIGURED',
      'No API base URL is configured. Set WATERX_PREDICT_BASE_URL or `baseUrl` in the config file. Nothing was attempted.',
    );
  }
  const signer = createSigner(config, options.runSigner, options.onDiagnostic, options.gate);
  if (config.mode === 'direct') {
    if (config.network === undefined) {
      throw new CliError(
        'NOT_CONFIGURED',
        'Direct mode needs to know which Sui network a custom host serves. Set WATERX_PREDICT_NETWORK to mainnet or testnet, or name the deployment instead of the host.',
      );
    }
    return new PredictDirectClient({
      baseUrl: config.baseUrl,
      network: config.network,
      fetch: options.fetch,
      signer,
      timeoutMs: config.timeoutMs,
      requireIntentStore: true,
      ...(config.deploymentUrl === undefined ? {} : { deploymentUrl: config.deploymentUrl }),
      ...(config.suiGraphqlUrl === undefined ? {} : { suiGraphqlUrl: config.suiGraphqlUrl }),
      ...(options.accountHints === undefined ? {} : { accountHints: options.accountHints }),
      ...(options.intentStore === undefined ? {} : { intentStore: options.intentStore }),
      ...(options.marketCatalog === undefined ? {} : { catalog: options.marketCatalog }),
    });
  }
  return new PredictAgentClient({
    baseUrl: config.baseUrl,
    fetch: options.fetch,
    signer,
    // A supplied token is used as-is and may still be replaced by the SDK's
    // bounded re-authentication when the server rejects it.
    ...(options.token ?? config.token) !== undefined
      ? { token: (options.token ?? config.token) as string }
      : {},
  });
}

/**
 * A deadline for one call.
 *
 * The CLI owns the deadline rather than the SDK because "how long am I willing
 * to wait" is a property of the invocation, not of the API.
 */
export function deadline(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

/**
 * Map a thrown value onto the envelope's error.
 *
 * `retryable` is copied from the server, never re-derived: a local retry table
 * disagreeing with the server's answer is how a definitive refusal gets retried
 * in a loop.
 *
 * A transport failure is reported as TRANSPORT rather than as a refusal, because
 * nothing refused — no response was seen. On a read that is merely a failure; on
 * a write it would mean the outcome is unknown, and collapsing the two would
 * teach a caller the wrong habit here and cost it money there.
 */
/**
 * The handles an unresolved write hands back, for the envelope's `details`.
 *
 * This is the most dangerous outcome this CLI can produce: the order may have
 * landed and nobody knows. The documented recovery is to read — `order
 * reconcile` by execution id — or, failing that, to replay the SAME key with the
 * SAME bytes; a fresh key is how one intent becomes two orders.
 *
 * Both of those need a value the SDK already computed and handed over on the
 * error. Dropping it here left an operator told "we do not know what happened"
 * and holding nothing they could use to find out.
 */
const unresolvedHandles = (error: unknown): Record<string, unknown> => {
  if (!isUnresolvedWrite(error)) return {};
  const executionId = (error as { executionId?: unknown }).executionId;
  return {
    idempotencyKey: error.idempotencyKey,
    ...(typeof executionId === 'string' ? { executionId } : {}),
    recovery:
      'This write is UNRESOLVED, not failed. Read it back with `order reconcile` when an executionId is present; otherwise replay this exact input with `--input` plus `idempotencyKey`. Never resubmit under a fresh key.',
  };
};

export function toEnvelopeError(error: unknown, timeoutMs: number): EnvelopeError {
  if (error instanceof CliError) {
    return {
      code: error.code,
      message: error.message,
      retryable: false,
      source: 'CLI',
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
  }

  // Kept in its own namespace rather than folded into CLI: an operator reading
  // `source: "RUNNER"` knows the exchange was never involved, and that whatever
  // has to change is on this machine.
  if (isRunnerRefusal(error)) {
    return {
      code: error.code,
      message: error.message,
      retryable: false,
      source: 'RUNNER',
      ...(error.detail !== undefined ? { details: error.detail } : {}),
    };
  }

  // Direct mode's own refusals, each in the CLI's vocabulary. None of them
  // reached the chain.
  if (isDirectCapabilityUnavailable(error)) {
    return {
      code: 'CAPABILITY_UNAVAILABLE',
      message: error.message,
      retryable: false,
      source: 'CLI',
      details: { capability: error.capability, mode: 'direct', alternative: 'Set WATERX_PREDICT_MODE=agent-api where the Agent Trading API is enabled.' },
    };
  }
  if (error instanceof DirectVerificationError) {
    return {
      code: 'TRANSACTION_REFUSED',
      message: `${error.message}. Nothing was signed or sent.`,
      retryable: false,
      source: 'CLI',
      details: { rule: error.rule },
    };
  }
  if (error instanceof DirectDeploymentError) {
    return {
      code: 'DEPLOYMENT_UNAVAILABLE',
      message: `${error.message}. Nothing was signed or sent.`,
      retryable: true,
      source: 'CLI',
    };
  }

  if (isPredictAgentApiError(error)) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      source: 'SERVER',
      details: {
        httpStatus: error.httpStatus,
        ...(error.executionId !== undefined ? { executionId: error.executionId } : {}),
        ...unresolvedHandles(error),
      },
    };
  }

  if (error instanceof PredictAgentTransportError) {
    // `AbortSignal.timeout` surfaces here as an aborted fetch. Naming it a
    // timeout is more useful than "the request failed", and it is the same
    // class of outcome either way: no response was seen.
    const timedOut = /abort|timeout/iu.test(error.message + String(error.cause ?? ''));
    return {
      code: timedOut ? 'TIMEOUT' : 'TRANSPORT_FAILED',
      message: timedOut
        ? `The request did not complete within ${String(timeoutMs)}ms. No response was seen, so this says nothing about what the server did.`
        : error.message,
      retryable: false,
      source: 'TRANSPORT',
      // A transport failure normally carries nothing to act on. An UNRESOLVED
      // one does, and it is the case where acting on the wrong thing costs a
      // second order.
      ...(isUnresolvedWrite(error) ? { details: unresolvedHandles(error) } : {}),
    };
  }

  return {
    code: 'INTERNAL',
    message: error instanceof Error ? error.message : 'An unrecognised failure occurred.',
    retryable: false,
    source: 'CLI',
  };
}

/**
 * The exit class for one thrown value.
 *
 * Shared by the dispatcher and by `order execute-many`, whose legs each fail on
 * their own: a per-leg failure must land in the same class it would have landed
 * in as a single command, or a caller's retry logic would have to branch on how
 * the order happened to be submitted.
 */
export function exitCodeForThrown(error: unknown): ExitCode {
  if (isCliError(error)) return exitCodeForCliError(error.code);
  const envelope = toEnvelopeError(error, 0);
  if (envelope.source === 'CLI' && isCliErrorCode(envelope.code)) return exitCodeForCliError(envelope.code);
  if (envelope.source === 'SERVER') return exitCodeForServerError(envelope.code);
  if (envelope.source === 'RUNNER') return exitCodeForRunnerError(envelope.code);
  if (envelope.source === 'TRANSPORT') return EXIT_CODES.TRANSPORT;
  return EXIT_CODES.INTERNAL;
}
