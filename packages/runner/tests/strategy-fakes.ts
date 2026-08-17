/**
 * The gateway, signer and price source every strategy test runs against.
 *
 * Shared by the driver's tests and the scheduler's so the two cannot drift into
 * disagreeing about what a healthy server looks like. Every one of these is a
 * script with no socket, no process and no timer: a suite that needed a server
 * to prove the executor would be proving the server.
 */
import type {
  CreateExecutionRequestBody,
  CreateExecutionResponseBody,
  CreateQuoteRequestBody,
  GetMarketResponseBody,
  ListPositionsResponseBody,
  PredictAgentMarket,
  PredictEffectiveLimitsResponseBody,
  PredictQuote,
  SubmitExecutionResponseBody,
} from '@waterx/predict-agent-sdk';
import { PredictAgentApiError } from '@waterx/predict-agent-sdk';

import type { PriceObserver, StrategyGateway, StrategySigner } from '../src/strategy/gateway.ts';
import { later, T0 } from './harness.ts';

export const INSTANCE = 'run_1';
export const MARKET = 'mkt_btts_yes';
export const NOW = later(T0, 60_000);
/** Sponsored bytes, as a value that would be a secret if it were real. */
export const BYTES = 'c3BvbnNvcmVk';
export const SIGNATURE = 'c2lnbmF0dXJl';

export const TRIGGER = {
  kind: 'PRICE',
  targetPrice: '0.820000',
  observe: 'BID',
  marketId: MARKET,
  outcomeId: 'YES',
  side: 'SELL',
} as const;

/* ── Fakes ─────────────────────────────────────────────────────────────────── */

export const market = (overrides: Partial<PredictAgentMarket> = {}): PredictAgentMarket => ({
  marketId: MARKET,
  title: 'Both teams to score',
  category: 'football',
  status: 'IN_PLAY',
  tradeable: true,
  event: { eventId: 'evt_1' },
  outcomes: [],
  aliases: [],
  closesAt: null,
  updatedAt: T0,
  ...overrides,
});

export const limits = (
  overrides: Partial<PredictEffectiveLimitsResponseBody> = {},
): PredictEffectiveLimitsResponseBody => ({
  accountId: 'acct_1',
  agentWallet: '0xagent',
  limits: {
    allowanceLimit: '1000.000000',
    maxOrderAmount: null,
    maxSlippageBps: null,
    maxOrdersPerHour: null,
    maxNotionalPerHour: null,
    maxInFlightExecutions: null,
    isSuspended: false,
    policyVersion: 3,
    updatedAt: T0,
  },
  allowance: {
    apiAllowance: {
      limit: '1000.000000',
      reserved: '0.000000',
      deployed: '0.000000',
      available: '1000.000000',
    },
    accountSpendableBalance: '1000.000000',
    effectiveBuyCapacity: '1000.000000',
  },
  usage: {
    windowSeconds: 3600,
    ordersInWindow: 0,
    notionalInWindow: '0.000000',
    inFlightExecutions: 0,
  },
  delegation: { mayPlaceOrder: true, mayRequestClose: true, checkedAt: T0 },
  blockers: [],
  asOf: T0,
  ...overrides,
});

export const quote = (overrides: Partial<PredictQuote> = {}): PredictQuote => ({
  quoteId: 'q_1',
  marketId: MARKET,
  outcomeId: 'YES',
  side: 'SELL',
  expectedPrice: '0.830000',
  expectedFillSize: '25.000000',
  availableSize: '100.000000',
  feeAmount: null,
  liquidityTier: 'A',
  qualityFlags: [],
  asOf: NOW,
  expiresAt: later(NOW, 30_000),
  onchainMarketIdHex: '0xdead',
  onchainSelection: 'YES',
  ...overrides,
});

export const created = (executionId: string): CreateExecutionResponseBody => ({
  executionId,
  status: 'AWAITING_SIGNATURE',
  sponsoredTransactionBytes: BYTES,
  sponsoredDigest: '0xsponsored',
  signatureExpiresAt: later(NOW, 120_000),
  referenceQuoteId: 'q_1',
  submissionQuoteId: 'q_1s',
  enforcedWorstPrice: '0.825000',
});

export const apiError = (code = 'SLIPPAGE_EXCEEDED', httpStatus = 409): PredictAgentApiError =>
  new PredictAgentApiError(httpStatus, {
    code: code as PredictAgentApiError['code'],
    message: 'refused',
    retryable: false,
  });

export interface Script {
  readonly markets?: readonly PredictAgentMarket[];
  readonly limits?: PredictEffectiveLimitsResponseBody;
  readonly positions?: ListPositionsResponseBody;
  readonly quotes?: readonly PredictQuote[];
  /** One answer per create call, in order. An Error is thrown instead. */
  readonly creates?: readonly (CreateExecutionResponseBody | Error)[];
  readonly submits?: readonly (SubmitExecutionResponseBody | Error)[];
  readonly executions?: Readonly<Record<string, SubmitExecutionResponseBody>>;
}

export interface Recorder extends StrategyGateway {
  readonly createCalls: {
    body: CreateExecutionRequestBody;
    idempotencyKey: string;
  }[];
  readonly submitCalls: string[];
  readonly quoteCalls: CreateQuoteRequestBody[];
  readonly marketCalls: string[];
}

export const next = <T,>(answers: readonly (T | Error)[] | undefined, index: number, what: string): T => {
  const answer = answers?.[Math.min(index, answers.length - 1)];
  if (answer === undefined) throw new Error(`no scripted ${what} answer`);
  if (answer instanceof Error) throw answer;
  return answer;
};

export const gatewayOf = (script: Script = {}): Recorder => {
  const createCalls: Recorder['createCalls'] = [];
  const submitCalls: string[] = [];
  const quoteCalls: CreateQuoteRequestBody[] = [];
  const marketCalls: string[] = [];
  return {
    createCalls,
    submitCalls,
    quoteCalls,
    marketCalls,
    getMarket: async (marketId): Promise<GetMarketResponseBody> => {
      marketCalls.push(marketId);
      const found = (script.markets ?? [market()]).find((m) => m.marketId === marketId);
      return { market: found ?? market({ marketId }) };
    },
    getEffectiveLimits: async () => script.limits ?? limits(),
    getPositions: async () => script.positions ?? { positions: [], nextCursor: null },
    getQuote: async (request) => {
      quoteCalls.push(request);
      return next(script.quotes, quoteCalls.length - 1, 'quote');
    },
    createExecution: async (body, options) => {
      createCalls.push({ body, idempotencyKey: options.idempotencyKey });
      return next(script.creates, createCalls.length - 1, 'create');
    },
    submitExecution: async (executionId) => {
      submitCalls.push(executionId);
      return next(script.submits, submitCalls.length - 1, 'submit');
    },
    getExecution: async (executionId) => {
      const found = script.executions?.[executionId];
      if (found === undefined) throw new Error(`no scripted execution ${executionId}`);
      return found;
    },
  };
};

/** The one seam that may see key material. A script; no key exists here. */
export const signer: StrategySigner = { sign: async () => SIGNATURE };

export const pricesAt = (...observed: (string | null)[]): PriceObserver => {
  let index = 0;
  return {
    observe: async () => observed[Math.min(index++, observed.length - 1)] ?? null,
  };
};
