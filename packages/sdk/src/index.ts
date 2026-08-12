/**
 * @waterx/predict-agent-sdk — TypeScript client for the WaterX Predict Agent
 * Trading API.
 *
 * Zero runtime dependencies: global `fetch` for HTTP, `node:crypto` for
 * idempotency keys, and a structural signer interface a Sui `Keypair` already
 * satisfies. Nothing here touches the chain — the backend builds every PTB.
 */
export { compareDecimal, targetReached, toScaled } from './decimal.ts';
export {
  PredictAgentClient,
  type ExecutionStream,
  type PriceWatcher,
  type WaitForPriceIntent,
  type WaitForPriceOptions,
  type ExecuteManyOptions,
  type ExecuteManyResult,
  type ExecuteMarketOrderIntent,
  type ExecuteMarketOrderOptions,
  type ExecuteMarketOrderResult,
  type PredictAgentClientOptions,
} from './client.ts';
export {
  PredictAgentApiError,
  PredictAgentTransportError,
  isPredictAgentApiError,
  isRetryable,
} from './errors.ts';
export { buildAuthMessage, type AgentSigner, type SignatureWithBytes } from './signer.ts';
export type { RetryOptions, TransportOptions } from './transport.ts';
export type * from './contract.ts';
