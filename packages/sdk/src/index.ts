/**
 * @waterx/predict-agent-sdk — TypeScript client for the WaterX Predict Agent
 * Trading API.
 *
 * Global `fetch` for HTTP, `node:crypto` for idempotency keys, and a structural
 * signer interface a Sui `Keypair` already satisfies. Nothing here touches the
 * chain — the backend builds every PTB.
 *
 * ONE runtime dependency, `socket.io-client`, and only the execution stream uses
 * it. It is imported lazily, so a caller that never streams never loads it — see
 * `execution-stream.ts` for why re-implementing the protocol was the worse trade.
 */
export { compareDecimal, targetReached, toScaled } from './decimal.ts';
export {
  type ExecutionStream,
  SocketExecutionStream,
  type SocketExecutionStreamOptions,
  type StreamConnectOptions,
  type StreamConnector,
  type StreamHandshake,
  type StreamSocket,
} from './execution-stream.ts';
export {
  PredictAgentClient,
  type PriceWatcher,
  type WaitForExecutionOptions,
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
  type ExecutionFeeFacts,
  type ExecutionOutcome,
  isTerminalExecutionStatus,
  toExecutionOutcome,
  toFeeFacts,
} from './execution-facts.ts';
export {
  PredictAgentApiError,
  PredictAgentTransportError,
  isPredictAgentApiError,
  isRetryable,
  isUnauthenticated,
} from './errors.ts';
export { hasMorePages, isExhausted, pageQuery } from './pagination.ts';
export { buildAuthMessage, type AgentSigner, type SignatureWithBytes } from './signer.ts';
export type { RetryOptions, TransportOptions } from './transport.ts';
export type * from './contract.ts';
