/**
 * Pins the vendored wire contract.
 *
 * src/contract.ts is a COPY of the backend's agent-api.contract.ts. A separate
 * repo cannot import across, so nothing but these assertions stands between an
 * accidental edit here and every SDK call hitting the wrong URL. The backend has
 * the mirror of this test against the routes Nest actually registers.
 */
import { describe, expect, it } from 'vitest';

import {
  IDEMPOTENCY_KEY_HEADER,
  PREDICT_AGENT_API_ROUTES,
  PREDICT_QUOTE_HEARTBEAT,
  PREDICT_QUOTE_STREAM,
  PREDICT_QUOTE_STREAM_HEARTBEAT_MS,
  PREDICT_QUOTE_STREAM_MAX_SUBSCRIBE_RATE,
  PREDICT_QUOTE_STREAM_MAX_TOPICS,
  PREDICT_QUOTE_SUBSCRIBE,
  PREDICT_QUOTE_SUBSCRIPTION,
  PREDICT_QUOTE_UNSUBSCRIBE,
  RETRYABLE_PREDICT_AGENT_ERROR_CODES,
} from '../src/contract.ts';

describe('vendored wire contract', () => {
  it('pins every route path', () => {
    expect(PREDICT_AGENT_API_ROUTES).toEqual({
      auth: 'agent-api/v1/auth',
      markets: 'agent-api/v1/predict/markets',
      market: 'agent-api/v1/predict/markets/:marketId',
      quotes: 'agent-api/v1/predict/quotes',
      executions: 'agent-api/v1/predict/executions',
      submitExecution: 'agent-api/v1/predict/executions/:executionId/submit',
      getExecution: 'agent-api/v1/predict/executions/:executionId',
      allowance: 'agent-api/v1/predict/accounts/:accountId/allowance',
      effectiveLimits: 'agent-api/v1/predict/accounts/:accountId/effective-limits',
      positions: 'agent-api/v1/predict/accounts/:accountId/positions',
      fills: 'agent-api/v1/predict/accounts/:accountId/fills',
      performance: 'agent-api/v1/predict/accounts/:accountId/performance',
      listExecutions: 'agent-api/v1/predict/accounts/:accountId/executions',
      riskProfile: 'agent-api/v1/predict/accounts/:accountId/agents/:agentWallet/risk-profile',
      listRiskProfiles: 'agent-api/v1/predict/accounts/agents/risk-profiles',
    });
  });

  it('pins the idempotency header name', () => {
    // The server reads this header exactly; a casing change silently disables
    // idempotency and a retry becomes a second order.
    expect(IDEMPOTENCY_KEY_HEADER).toBe('Idempotency-Key');
  });

  it('documents the retryable codes without the SDK depending on the list', () => {
    // The SDK trusts the server's per-response `retryable` flag; this list is
    // documentation, so it must stay in sync but is never the decision input.
    expect([...RETRYABLE_PREDICT_AGENT_ERROR_CODES]).toEqual([
      'QUOTE_EXPIRED',
      'QUOTE_UNAVAILABLE',
      'SLIPPAGE_EXCEEDED',
      'RATE_LIMITED',
      'SPONSOR_UNAVAILABLE',
      'EXECUTION_TIMEOUT',
    ]);
  });

  it('pins the quote-stream event names', () => {
    // No client here speaks this yet (backlog 2.3). The names are pinned anyway:
    // a Socket.IO event is matched by string, so a typo produces a socket that
    // connects, subscribes to nothing, and reports no error at all.
    expect({
      stream: PREDICT_QUOTE_STREAM,
      subscribe: PREDICT_QUOTE_SUBSCRIBE,
      unsubscribe: PREDICT_QUOTE_UNSUBSCRIBE,
      subscription: PREDICT_QUOTE_SUBSCRIPTION,
      heartbeat: PREDICT_QUOTE_HEARTBEAT,
    }).toEqual({
      stream: 'predict.quotes.v1',
      subscribe: 'predict.quotes.subscribe',
      unsubscribe: 'predict.quotes.unsubscribe',
      subscription: 'predict.quotes.subscription',
      heartbeat: 'predict.quotes.heartbeat',
    });
  });

  it('pins the bounds a future client has to respect', () => {
    // These are server-enforced. A client that batches past either gets per-topic
    // rejections it must read, not an exception it can retry.
    expect(PREDICT_QUOTE_STREAM_MAX_TOPICS).toBe(32);
    expect(PREDICT_QUOTE_STREAM_MAX_SUBSCRIBE_RATE).toBe(60);
    // A client that misses two in a row should reconnect, so this value is part
    // of the liveness contract, not a tuning detail.
    expect(PREDICT_QUOTE_STREAM_HEARTBEAT_MS).toBe(15_000);
  });
});
