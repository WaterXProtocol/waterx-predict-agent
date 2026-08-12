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
      positions: 'agent-api/v1/predict/accounts/:accountId/positions',
      fills: 'agent-api/v1/predict/accounts/:accountId/fills',
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
});
