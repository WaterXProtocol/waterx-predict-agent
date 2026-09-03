/**
 * @waterx/predict-agent-sdk — TypeScript client for the WaterX Predict Agent
 * Trading API.
 *
 * Global `fetch` for HTTP, `node:crypto` for idempotency keys, and a structural
 * signer interface a Sui `Keypair` already satisfies. Nothing here touches the
 * chain — the backend builds every PTB.
 *
 * ONE runtime dependency, `socket.io-client`, used only by the two streams. It is
 * imported lazily, so a caller that never streams never loads it — see
 * `execution-stream.ts` for why re-implementing the protocol was the worse trade.
 */
export { compareDecimal, fromScaled, targetReached, toScaled } from './decimal.ts';
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
  type PriceWatcher,
  type QuoteListener,
  type QuoteSocket,
  type QuoteStream,
  type QuoteStreamConnector,
  type QuoteStreamEvent,
  QuoteStreamPriceWatcher,
  type QuoteStreamPriceWatcherOptions,
  type QuoteUnavailableReason,
  SocketQuoteStream,
  type SocketQuoteStreamOptions,
  streamTriggerPrice,
} from './quote-stream.ts';
export {
  PredictAgentClient,
  type PredictAgentEndpoint,
  resolveBaseUrl,
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
  type AgentDiagnosis,
  diagnose,
  type DiagnosableClient,
  type DiagnoseOptions,
  type WriteGate,
  type WriteGateStatus,
} from './diagnosis.ts';
export {
  canonicalJson,
  createFileIntentStore,
  createMemoryIntentStore,
  type FileIntentStoreOptions,
  INTENT_DIGEST_EXCLUDED_FIELDS,
  intentDigest,
  type IntentRecord,
  type IntentRecordStatus,
  type IntentReservation,
  type IntentStore,
  normalizeIntent,
} from './intent-store.ts';
export {
  DECIMAL_SCALE,
  IDENTIFIER_MAX_LENGTH,
  IDENTIFIER_MIN_LENGTH,
  MAX_SLIPPAGE_BPS_MAX,
  MAX_SLIPPAGE_BPS_MIN,
  POSITIVE_DECIMAL_AMOUNT_PATTERN,
  PROBABILITY_PRICE_PATTERN,
  SUI_ADDRESS_PATTERN,
  unrecoverableIntentReason,
  unusableIdempotencyKeyReason,
} from './intent-shape.ts';
export {
  type MarketCandidate,
  type MarketNarrowing,
  type MarketResolution,
  type MarketSearcher,
  resolveMarket,
  type ResolveMarketQuery,
} from './market-resolution.ts';
export {
  describeQuoteCost,
  type DescribeQuoteCostOptions,
  describeSpread,
  type FeeBasis,
  type PriceSpread,
  type QuoteCost,
  type QuoteFeeFacts,
  type SizeConfidence,
} from './quote-cost.ts';
export {
  type ExecutionFeeFacts,
  type ExecutionOutcome,
  isTerminalExecutionStatus,
  needsAgentSignature,
  toExecutionOutcome,
  toFeeFacts,
} from './execution-facts.ts';
export {
  PredictAgentApiError,
  PredictAgentUnresolvedTransport,
  PredictAgentUnresolvedWrite,
  isUnresolvedWrite,
  PredictAgentTransportError,
  isPredictAgentApiError,
  isAmbiguousOutcome,
  isRetryable,
  isUnauthenticated,
} from './errors.ts';
export {
  type DescribeInstallationOptions,
  describeInstallation,
  type InstallationPackage,
  type InstallationReport,
  type SurfaceAvailability,
} from './installation.ts';
export {
  AGENT_REQUIREMENTS,
  type AgentRequirement,
  REQUIREMENT_IDS,
  type RequirementId,
  type RequirementState,
  type RequirementSupplier,
  requirementFor,
  type ResolvedRequirement,
  nextStepFor,
} from './provisioning.ts';
export {
  type AuthorizationPoller,
  type AuthorizationUrlOptions,
  type AuthorizationWaitResult,
  buildAuthorizationUrl,
  type DescribeOnboardingOptions,
  describeOnboarding,
  type OnboardingActor,
  type OnboardingClient,
  type OnboardingHandle,
  type OnboardingState,
  type OnboardingStatus,
  PREDICT_AGENT_AUTHORIZE_PATH,
  PREDICT_AGENT_CONSOLE_ENDPOINTS,
  startOnboarding,
  type StartOnboardingOptions,
  waitForAuthorization,
  type WaitForAuthorizationOptions,
} from './onboarding.ts';
export { hasMorePages, isExhausted, pageQuery } from './pagination.ts';
export {
  buildAuthMessage,
  signBase64,
  type AgentSigner,
  type SignatureWithBytes,
} from './signer.ts';
export type { RetryOptions, TransportOptions } from './transport.ts';
export type * from './contract.ts';
/**
 * The contract's runtime values, exported separately because `export type *`
 * carries none of them.
 *
 * They were unreachable from a published consumer: the `exports` map admits
 * only `.`, so `@waterx/predict-agent-sdk/dist/src/contract.js` is blocked, and
 * the entry point re-exported the module for types only. A caller that wanted
 * to know the route it was about to call, the header the server reads for
 * idempotency, or the subscription cap a stream enforces had to hard-code the
 * value the SDK already holds — and a hard-coded copy is a copy that drifts.
 */
export {
  IDEMPOTENCY_KEY_HEADER,
  PREDICT_AGENT_API_ROUTES,
  PREDICT_AGENT_ENDPOINTS,
  PREDICT_AGENT_STREAM_NAMESPACE,
  PREDICT_EXECUTION_STREAM,
  PREDICT_QUOTE_HEARTBEAT,
  PREDICT_QUOTE_STREAM,
  PREDICT_QUOTE_STREAM_HEARTBEAT_MS,
  PREDICT_QUOTE_STREAM_MAX_SUBSCRIBE_RATE,
  PREDICT_QUOTE_STREAM_MAX_TOPICS,
  PREDICT_QUOTE_SUBSCRIBE,
  PREDICT_QUOTE_SUBSCRIPTION,
  PREDICT_QUOTE_UNSUBSCRIBE,
  PREDICT_STREAM_READY,
  RETRYABLE_PREDICT_AGENT_ERROR_CODES,
} from './contract.ts';
