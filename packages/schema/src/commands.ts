/**
 * THE AGENT COMMAND CONTRACT — one source of truth for CLI validation, JSON
 * Schema emission and every function-calling adapter (ADR-0001 §5, plan §8).
 *
 * Two contracts exist in this system and they are not the same thing:
 *   - the backend WIRE contract (`@waterx/predict-agent-sdk`'s `contract.ts`),
 *     vendored from the backend and authoritative for request/response shapes;
 *   - this AGENT COMMAND contract, the higher-level intent an agent host states.
 *
 * This file is the second one. It compiles down to the first via
 * `implementation`, which is what keeps two hosts issuing the same intent from
 * producing two different requests (ADR-0001 §3).
 *
 * SCOPE OF v1: only commands the execution core can actually perform today. The
 * `strategy` family is named in the plan but has no implementation, and a schema
 * entry is exactly what an adapter would turn into an advertised tool. Those are
 * added when they exist — the document is versioned and adding a command is
 * backwards-compatible.
 *
 * `market history` is absent for a different reason: the API has no endpoint
 * behind it (D-25). The CLI still answers it, with a symbolic
 * `CAPABILITY_UNAVAILABLE` — that is capability negotiation, not a command, and
 * listing it here would advertise a tool that can only refuse.
 */
import {
  COMMAND_SCHEMA_DEFS,
  ORDER_INTENT_PROPERTIES,
  ORDER_INTENT_REQUIRED,
  ORDER_INTENT_RULES,
} from './defs.ts';
import type { JsonSchema } from './json-schema.ts';

/** Bumped only for a breaking change to a command input. Additions are not breaking. */
export const AGENT_COMMAND_SCHEMA_VERSION = '1';

/** Whether the command can move funds. `write` covers anything that can. */
export type AgentCommandClassification = 'read' | 'write';

export type AgentCommandSideEffect =
  /** Nothing on the server changes. */
  | 'NONE'
  /**
   * Deliberately signs the authentication challenge as a PERSONAL MESSAGE, which
   * has no funds effect and is not a transaction signature. Every authenticated
   * command may do this incidentally when its session has expired; this marker is
   * for the ones whose entire purpose is to exercise it.
   */
  | 'AUTHENTICATES'
  /** Creates a short-lived executable quote. No funds move and nothing is signed. */
  | 'MINTS_QUOTE'
  /** The agent wallet signs sponsored transaction bytes. */
  | 'SIGNS_TRANSACTION'
  /** Can result in an on-chain trade. */
  | 'MOVES_FUNDS';

export type AgentCommandConfirmation =
  | 'NOT_REQUIRED'
  /** Interactive policy (the default) requires one explicit approval per call. */
  | 'REQUIRED_UNLESS_DELEGATED';

export interface AgentCommandIdempotency {
  /** True when the command must carry a key for a retry to be safe. */
  readonly required: boolean;
  readonly callerSupplied: 'UNSUPPORTED' | 'OPTIONAL';
  readonly note: string;
}

export interface AgentCommandExample {
  readonly title: string;
  /** Placeholder data only. Never a real account, market, key or token. */
  readonly input: Readonly<Record<string, unknown>>;
}

/**
 * What a surface must actually call to honour the command.
 *
 * `sdk` is the normal case and the reason this contract exists: two hosts issuing
 * the same intent make the same `PredictAgentClient` call (ADR-0001 §1).
 *
 * `runtime` covers the commands that have no single SDK method because they are
 * about the runtime rather than the API — discovery, diagnostics, and reads the
 * runtime composes from more than one call. They still belong here: an adapter
 * that could not advertise `describe` would leave every host to invent its own
 * discovery, which is exactly the divergence this document prevents. A `runtime`
 * command must never be a second way to trade — it may compose SDK reads and
 * report local facts, and nothing else.
 */
export type AgentCommandImplementation =
  | { readonly kind: 'sdk'; readonly method: string }
  | { readonly kind: 'runtime'; readonly note: string };

export interface AgentCommandSpec {
  /** Stable dotted identifier, e.g. `order.execute`. Adapters key on this. */
  readonly name: string;
  /** The CLI invocation for the same command. */
  readonly cli: string;
  readonly summary: string;
  readonly description: string;
  readonly classification: AgentCommandClassification;
  readonly sideEffects: readonly AgentCommandSideEffect[];
  /** True when the call may stay open long enough to need an abort/timeout story. */
  readonly longRunning: boolean;
  readonly idempotency: AgentCommandIdempotency;
  readonly confirmation: AgentCommandConfirmation;
  /** What honouring this command actually calls (ADR-0001 §1). */
  readonly implementation: AgentCommandImplementation;
  readonly input: JsonSchema;
  readonly examples: readonly AgentCommandExample[];
}

/* ── Placeholder values for examples ─────────────────────────────────────────
 * Deliberately obvious fakes. An example is copied by agents, so it must never
 * carry an address, market or credential that resolves anywhere real. */
const EXAMPLE_ACCOUNT_ID = `0x${'11'.repeat(32)}`;
const EXAMPLE_MARKET_ID = `0x${'22'.repeat(32)}`;
const EXAMPLE_POSITION_ID = `0x${'33'.repeat(32)}`;
const EXAMPLE_QUOTE_ID = 'quo_example_0000000000';
const EXAMPLE_EXECUTION_ID = 'exec_example_000000000';

const NO_IDEMPOTENCY: AgentCommandIdempotency = {
  required: false,
  callerSupplied: 'UNSUPPORTED',
  note: 'A read is safe to repeat; no key applies.',
};

const readOnly = {
  classification: 'read',
  sideEffects: ['NONE'],
  longRunning: false,
  idempotency: NO_IDEMPOTENCY,
  confirmation: 'NOT_REQUIRED',
} as const satisfies Partial<AgentCommandSpec>;

const accountScopedList = (rowDescription: string): JsonSchema => ({
  type: 'object',
  required: ['accountId'],
  additionalProperties: false,
  properties: {
    accountId: { $ref: '#/$defs/accountId' },
    limit: { $ref: '#/$defs/limit' },
  },
  description: rowDescription,
});

const marketList: AgentCommandSpec = {
  ...readOnly,
  name: 'market.list',
  cli: 'market list',
  summary: 'List the tradeable market catalog.',
  description:
    'Server-resolved market identity: this is how an agent obtains a marketId, and it must never construct one. Outcome prices in the result are INDICATIVE top-of-book and are not executable — call market.quote before acting on one. The status and tradeable filters are applied after the page is assembled, so a filtered page can be shorter than limit without the catalog being exhausted. Passing search adds a resolution block that says whether the text named exactly one market; market.search is the same call with that answer put first.',
  implementation: { kind: 'sdk', method: 'getMarkets' },
  input: {
    type: 'object',
    additionalProperties: false,
    properties: {
      limit: { $ref: '#/$defs/limit' },
      category: {
        title: 'Category',
        description: 'Server-defined catalog category, matched exactly.',
        type: 'string',
        minLength: 1,
        maxLength: 128,
        'x-waterx-open-set': ['FOOTBALL', 'BASKETBALL'],
      },
      status: {
        title: 'Market status',
        description: 'A closed set on this API version.',
        type: 'string',
        enum: ['PREGAME', 'IN_PLAY', 'CLOSED', 'RESOLVED'],
      },
      tradeable: {
        title: 'Tradeable only',
        description: 'Restrict to markets currently accepting orders.',
        type: 'boolean',
      },
      updatedAfter: {
        title: 'Updated after',
        description: 'ISO-8601 UTC instant. Only markets whose definition changed after it.',
        type: 'string',
        minLength: 1,
      },
      search: { $ref: '#/$defs/searchText' },
    },
  },
  examples: [
    { title: 'Tradeable football markets', input: { category: 'FOOTBALL', tradeable: true, limit: 20 } },
  ],
};

const marketSearch: AgentCommandSpec = {
  ...readOnly,
  name: 'market.search',
  cli: 'market search',
  summary: 'Resolve free text to one market id, or say it did not.',
  description:
    'Name-to-id resolution, decided BY THE SERVER against each market’s published aliases — the runtime never matches text against a page it fetched, because a locally-chosen id is an id nothing resolved. status is RESOLVED only when exactly one market matched, and marketId is null on anything else: AMBIGUOUS returns the candidates so the caller can narrow, and picking one for them is the hallucinated identity this contract exists to prevent. matchCount is counted over the whole filtered catalog before limit truncates the page, so a page of one is never mistaken for a unique answer. The candidate order is match specificity, then the round clock, then the id — a reproducible tie-break, not a judgement about which market is worth trading.',
  implementation: { kind: 'sdk', method: 'searchMarkets' },
  input: {
    type: 'object',
    required: ['search'],
    additionalProperties: false,
    properties: {
      search: { $ref: '#/$defs/searchText' },
      limit: { $ref: '#/$defs/limit' },
      category: {
        title: 'Category',
        description: 'Server-defined catalog category, matched exactly. Narrows before the search.',
        type: 'string',
        minLength: 1,
        maxLength: 128,
        'x-waterx-open-set': ['FOOTBALL', 'BASKETBALL'],
      },
      status: {
        title: 'Market status',
        description: 'A closed set on this API version.',
        type: 'string',
        enum: ['PREGAME', 'IN_PLAY', 'CLOSED', 'RESOLVED'],
      },
      tradeable: {
        title: 'Tradeable only',
        description: 'Restrict to markets currently accepting orders.',
        type: 'boolean',
      },
    },
  },
  examples: [
    { title: 'Resolve a fixture by name', input: { search: 'arsenal chelsea' } },
    {
      title: 'Resolve within tradeable football only',
      input: { search: 'arsenal', category: 'FOOTBALL', tradeable: true },
    },
  ],
};

const marketGet: AgentCommandSpec = {
  ...readOnly,
  name: 'market.get',
  cli: 'market get',
  summary: 'Read one market by its server-resolved id.',
  description:
    'Confirms a market resolved from market.list before an order. A closed market still resolves; an unknown id is an error rather than an empty result.',
  implementation: { kind: 'sdk', method: 'getMarket' },
  input: {
    type: 'object',
    required: ['marketId'],
    additionalProperties: false,
    properties: { marketId: { $ref: '#/$defs/marketId' } },
  },
  examples: [{ title: 'Read one market', input: { marketId: EXAMPLE_MARKET_ID } }],
};

const marketQuote: AgentCommandSpec = {
  ...readOnly,
  name: 'market.quote',
  cli: 'market quote',
  summary: 'Mint a short-lived executable quote.',
  description:
    'The only price an order may be built on. A quote lives seconds and is never extended, so fetch it immediately before order.execute rather than caching it. Quotes are size-blind today: availableSize, expectedFillSize and feeAmount come back null and qualityFlags carries TOP_OF_BOOK_ONLY, so a large order can be correctly priced and still fail to fill.',
  sideEffects: ['MINTS_QUOTE'],
  implementation: { kind: 'sdk', method: 'getQuote' },
  input: {
    type: 'object',
    required: ['marketId', 'outcomeId', 'side', 'size'],
    additionalProperties: false,
    properties: {
      marketId: { $ref: '#/$defs/marketId' },
      outcomeId: { $ref: '#/$defs/outcomeId' },
      side: { $ref: '#/$defs/side' },
      size: { $ref: '#/$defs/orderSize' },
    },
    allOf: [{ $ref: '#/$defs/sideSizeAgreement' }],
  },
  examples: [
    {
      title: 'Price a 50 wxUSD buy',
      input: {
        marketId: EXAMPLE_MARKET_ID,
        outcomeId: 'YES',
        side: 'BUY',
        size: { buyAmount: '50' },
      },
    },
    {
      title: 'Price closing 100 shares',
      input: {
        marketId: EXAMPLE_MARKET_ID,
        outcomeId: 'YES',
        side: 'SELL',
        size: { sellShares: '100' },
      },
    },
  ],
};

const accountAllowance: AgentCommandSpec = {
  ...readOnly,
  name: 'account.allowance',
  cli: 'account allowance',
  summary: 'Read the remaining API allowance and spendable balance.',
  description:
    'apiAllowance and accountSpendableBalance are separate facts — a direct-chain spend moves one without the other — so size against effectiveBuyCapacity, the smaller of the two. The API allowance is a WaterX policy, not an on-chain security boundary.',
  implementation: { kind: 'sdk', method: 'getAllowance' },
  input: {
    type: 'object',
    required: ['accountId'],
    additionalProperties: false,
    properties: { accountId: { $ref: '#/$defs/accountId' } },
  },
  examples: [{ title: 'Read allowance', input: { accountId: EXAMPLE_ACCOUNT_ID } }],
};

const accountRiskLimits: AgentCommandSpec = {
  ...readOnly,
  name: 'account.risk-limits',
  cli: 'account risk-limits',
  summary: 'Read the mandate this agent trades under, and what would refuse a write now.',
  description:
    'The owner-configured limits, the allowance, the hour already consumed, the on-chain delegation and the reasons a write would be refused — one server read, one asOf. limits is null when no owner granted this agent a mandate, and absence is denial rather than an unlimited default. A null delegation permission means the chain read FAILED and not that it was denied; the two lead a strategy to opposite actions. An empty blockers list is not a promise of a fill: the market must still be tradeable, the quote still executable, and the chain still decides last. Nothing here is settable from an agent credential (spec §7.3).',
  implementation: { kind: 'sdk', method: 'getEffectiveLimits' },
  input: {
    type: 'object',
    required: ['accountId'],
    additionalProperties: false,
    properties: { accountId: { $ref: '#/$defs/accountId' } },
  },
  examples: [{ title: 'Read the effective mandate', input: { accountId: EXAMPLE_ACCOUNT_ID } }],
};

const accountPositions: AgentCommandSpec = {
  ...readOnly,
  name: 'account.positions',
  cli: 'account positions',
  summary: 'List positions this agent opened, with cost basis and unrealized PnL.',
  description:
    'A SELL needs the positionId from here. Scope is API-attributed activity: a direct-chain trade by the same delegated key is not included.',
  implementation: { kind: 'sdk', method: 'getPositions' },
  input: accountScopedList('Positions on one account, newest first.'),
  examples: [{ title: 'List positions', input: { accountId: EXAMPLE_ACCOUNT_ID, limit: 50 } }],
};

const accountExecutions: AgentCommandSpec = {
  ...readOnly,
  name: 'account.executions',
  cli: 'account executions',
  summary: 'List this agent’s executions on one account.',
  description:
    'Order history including non-terminal rows. SUBMITTED and PENDING_FILL are not fills — read the terminal status before reporting a trade as done. Paging is limit-only today; there is no cursor, so a complete history cannot be reconstructed past the cap.',
  implementation: { kind: 'sdk', method: 'listExecutions' },
  input: accountScopedList('Executions on one account, newest first.'),
  examples: [{ title: 'List executions', input: { accountId: EXAMPLE_ACCOUNT_ID, limit: 50 } }],
};

const accountFills: AgentCommandSpec = {
  ...readOnly,
  name: 'account.fills',
  cli: 'account fills',
  summary: 'List confirmed fills, with the quote each was priced against.',
  description:
    'Authoritative fill facts: filled amount, shares, average price and the keeper transaction that settled it — which is a different transaction from the agent’s submission. actualFee is null rather than zero, because the published price is already fee-adjusted and no separate fee is observable.',
  implementation: { kind: 'sdk', method: 'getFills' },
  input: accountScopedList('Fills on one account, newest first.'),
  examples: [{ title: 'List fills', input: { accountId: EXAMPLE_ACCOUNT_ID, limit: 50 } }],
};

/**
 * The preview intent: the order intent, minus the two fields a preview cannot
 * take a position on.
 *
 * `referenceQuoteId` is absent because preview MINTS the quote it prices
 * against — asking a caller to supply one would mean previewing a quote that had
 * already aged. `idempotencyKey` is absent because a preview is not a logical
 * write and has nothing to make replayable.
 */
const PREVIEW_PROPERTIES: Readonly<Record<string, JsonSchema>> = Object.fromEntries(
  Object.entries(ORDER_INTENT_PROPERTIES).filter(
    ([key]) => key !== 'referenceQuoteId' && key !== 'idempotencyKey',
  ),
);

const PREVIEW_REQUIRED: readonly string[] = ORDER_INTENT_REQUIRED.filter(
  (key) => key !== 'referenceQuoteId',
);

const orderPreview: AgentCommandSpec = {
  name: 'order.preview',
  cli: 'order preview',
  summary: 'Resolve, price and policy-check an order without placing it.',
  description:
    'The step before a write, and it signs nothing: the market and outcome are resolved by the server, a fresh quote is minted, the worst acceptable price the stated protection implies is estimated locally, and the execution policy is evaluated against the real intent. Under the interactive policy the result carries the approval token that authorizes exactly this order — change any field of it and the token stops matching. The estimated bound is against THIS quote: the server recomputes the authoritative bound against the submission-time quote and may tighten it, never loosen it. Effective risk limits are reported as unavailable rather than guessed, because the risk profile is owner-authenticated (ADR-0003).',
  classification: 'read',
  sideEffects: ['MINTS_QUOTE'],
  longRunning: false,
  idempotency: {
    required: false,
    callerSupplied: 'UNSUPPORTED',
    note: 'A preview places nothing, so there is no logical write to key. The idempotency key belongs to order.execute.',
  },
  confirmation: 'NOT_REQUIRED',
  implementation: {
    kind: 'runtime',
    note: 'Composes getMarket() and getQuote() with the local execution policy. Places no order and signs no transaction.',
  },
  input: {
    type: 'object',
    required: [...PREVIEW_REQUIRED],
    additionalProperties: false,
    properties: PREVIEW_PROPERTIES,
    allOf: [...ORDER_INTENT_RULES],
  },
  examples: [
    {
      title: 'Preview a 50 wxUSD buy',
      input: {
        accountId: EXAMPLE_ACCOUNT_ID,
        marketId: EXAMPLE_MARKET_ID,
        outcomeId: 'YES',
        side: 'BUY',
        size: { buyAmount: '50' },
        maxSlippageBps: 100,
      },
    },
  ],
};

const orderGet: AgentCommandSpec = {
  ...readOnly,
  name: 'order.get',
  cli: 'order get',
  summary: 'Read one execution by id.',
  description:
    'The reconciliation path. After a timeout the execution id is still valid and the order may still fill, so this is how a caller resolves an ambiguous outcome — never by resubmitting with a new idempotency key.',
  implementation: { kind: 'sdk', method: 'getExecution' },
  input: {
    type: 'object',
    required: ['executionId'],
    additionalProperties: false,
    properties: {
      executionId: {
        title: 'Execution id',
        description: 'Returned by order.execute, and preserved even when a wait times out.',
        type: 'string',
        minLength: 1,
        maxLength: 128,
      },
    },
  },
  examples: [{ title: 'Reconcile one execution', input: { executionId: EXAMPLE_EXECUTION_ID } }],
};

const orderReconcile: AgentCommandSpec = {
  ...readOnly,
  name: 'order.reconcile',
  cli: 'order reconcile',
  summary: 'Wait for one execution to reach a terminal state.',
  description:
    'What to run after an ambiguous outcome — a timed-out wait, a lost connection, a restarted process. It polls one execution until the status is terminal and reports the authoritative fill facts. It places nothing, cancels nothing and signs nothing, so it is always safe to repeat. Exhausting the timeout is again NOT a failure: timedOut is reported and the execution id stays valid.',
  longRunning: true,
  implementation: { kind: 'sdk', method: 'waitForExecution' },
  input: {
    type: 'object',
    required: ['executionId'],
    additionalProperties: false,
    properties: {
      executionId: {
        title: 'Execution id',
        description: 'From order.execute, and preserved even when its wait timed out.',
        type: 'string',
        minLength: 1,
        maxLength: 128,
      },
      timeoutMs: {
        title: 'Reconciliation timeout (ms)',
        description:
          'Bounds the wait. Exceeding it reports timedOut rather than an error, because the order is unaffected either way.',
        type: 'integer',
        minimum: 1_000,
        maximum: 600_000,
      },
      pollIntervalMs: {
        title: 'Poll interval (ms)',
        description: 'How often the execution is re-read while waiting.',
        type: 'integer',
        minimum: 250,
        maximum: 60_000,
      },
    },
  },
  examples: [
    { title: 'Resolve an ambiguous outcome', input: { executionId: EXAMPLE_EXECUTION_ID } },
  ],
};

const WAIT_PROPERTIES: Readonly<Record<string, JsonSchema>> = {
  waitFor: {
    title: 'Settle at',
    description:
      'SUBMITTED returns once the order is on-chain; TERMINAL waits for the authoritative fill facts. The order is placed either way — this only decides when the call returns.',
    type: 'string',
    enum: ['SUBMITTED', 'TERMINAL'],
  },
  timeoutMs: {
    title: 'Terminal wait timeout (ms)',
    description:
      'Bounds a TERMINAL wait. Exceeding it does NOT cancel the order and is not a failure: the execution id remains valid and must be reconciled with order.get.',
    type: 'integer',
    minimum: 1_000,
    maximum: 600_000,
  },
};

const orderExecute: AgentCommandSpec = {
  name: 'order.execute',
  cli: 'order execute',
  summary: 'Place one price-protected market order.',
  description:
    'Create, sign and submit, as one command. maxSlippageBps is mandatory and the server re-quotes at execution time, so the price is protected but the fill is not guaranteed. A BUY states buyAmount and a SELL states sellShares plus the positionId being closed; the units are not interchangeable and an ambiguous intent stops here rather than trading. One idempotency key covers the whole logical intent including retries.',
  classification: 'write',
  sideEffects: ['SIGNS_TRANSACTION', 'MOVES_FUNDS'],
  longRunning: true,
  idempotency: {
    required: true,
    callerSupplied: 'OPTIONAL',
    note: 'Supply idempotencyKey to make the intent replayable across a process restart. Omitted, the runtime mints one that covers in-process retries only. A retry must reuse the same key and the same bytes.',
  },
  confirmation: 'REQUIRED_UNLESS_DELEGATED',
  implementation: { kind: 'sdk', method: 'executeMarketOrder' },
  input: {
    type: 'object',
    required: [...ORDER_INTENT_REQUIRED],
    additionalProperties: false,
    properties: { ...ORDER_INTENT_PROPERTIES, ...WAIT_PROPERTIES },
    allOf: [...ORDER_INTENT_RULES],
  },
  examples: [
    {
      title: 'Buy 50 wxUSD of YES with 1% slippage protection',
      input: {
        accountId: EXAMPLE_ACCOUNT_ID,
        marketId: EXAMPLE_MARKET_ID,
        outcomeId: 'YES',
        side: 'BUY',
        size: { buyAmount: '50' },
        referenceQuoteId: EXAMPLE_QUOTE_ID,
        maxSlippageBps: 100,
        waitFor: 'TERMINAL',
      },
    },
    {
      title: 'Close 100 shares of a position',
      input: {
        accountId: EXAMPLE_ACCOUNT_ID,
        marketId: EXAMPLE_MARKET_ID,
        outcomeId: 'YES',
        side: 'SELL',
        size: { sellShares: '100' },
        positionId: EXAMPLE_POSITION_ID,
        referenceQuoteId: EXAMPLE_QUOTE_ID,
        maxSlippageBps: 50,
        worstAcceptablePrice: '0.82',
      },
    },
  ],
};

const orderExecuteMany: AgentCommandSpec = {
  name: 'order.execute-many',
  cli: 'order execute-many',
  summary: 'Place several independent orders.',
  description:
    'Client-side orchestration, not a backend batch and not atomic. Every leg has its own quote, idempotency key, execution and result, and partial success is the expected outcome. failurePolicy STOP prevents legs that have not launched from launching; it cannot cancel or roll back one already submitted or filled. Results report succeeded, failed and skipped legs distinctly.',
  classification: 'write',
  sideEffects: ['SIGNS_TRANSACTION', 'MOVES_FUNDS'],
  longRunning: true,
  idempotency: {
    required: true,
    callerSupplied: 'OPTIONAL',
    note: 'One key per leg, not one per call. A leg without an explicit key gets a runtime-minted one covering in-process retries only.',
  },
  confirmation: 'REQUIRED_UNLESS_DELEGATED',
  implementation: { kind: 'sdk', method: 'executeMany' },
  input: {
    type: 'object',
    required: ['orders'],
    additionalProperties: false,
    properties: {
      orders: {
        title: 'Legs',
        description: 'Independent order intents. No ordering or atomicity is implied.',
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: { $ref: '#/$defs/orderIntent' },
      },
      concurrency: {
        title: 'Concurrency',
        description:
          'How many legs may be in flight at once. A quote lives seconds, so legs are quoted close to their own execution rather than all up front.',
        type: 'integer',
        minimum: 1,
        maximum: 10,
      },
      failurePolicy: {
        title: 'Failure policy',
        description:
          'STOP stops launching further legs after a failure. CONTINUE attempts every leg. Neither can undo a leg already submitted.',
        type: 'string',
        enum: ['STOP', 'CONTINUE'],
      },
      ...WAIT_PROPERTIES,
    },
  },
  examples: [
    {
      title: 'Two independent buys, stop on the first failure',
      input: {
        orders: [
          {
            accountId: EXAMPLE_ACCOUNT_ID,
            marketId: EXAMPLE_MARKET_ID,
            outcomeId: 'YES',
            side: 'BUY',
            size: { buyAmount: '25' },
            referenceQuoteId: EXAMPLE_QUOTE_ID,
            maxSlippageBps: 100,
          },
          {
            accountId: EXAMPLE_ACCOUNT_ID,
            marketId: EXAMPLE_MARKET_ID,
            outcomeId: 'NO',
            side: 'BUY',
            size: { buyAmount: '25' },
            referenceQuoteId: EXAMPLE_QUOTE_ID,
            maxSlippageBps: 100,
          },
        ],
        concurrency: 2,
        failurePolicy: 'STOP',
      },
    },
  ],
};

/* ── Runtime commands ────────────────────────────────────────────────────────
 * No single SDK method backs these: they describe the runtime, diagnose it, or
 * compose more than one read. They are in the contract so every surface answers
 * discovery the same way — see AgentCommandImplementation. */

const runtimeDescribe: AgentCommandSpec = {
  ...readOnly,
  name: 'runtime.describe',
  cli: 'describe',
  summary: 'Report what this runtime can actually do, and what it cannot.',
  description:
    'The discovery entry point, and the only command that answers before configuration or network exist — a host has to be able to ask what it is holding. The capability inventory names unavailable capabilities explicitly with a symbolic reason rather than omitting them, so a caller can tell "not supported here" from "not mentioned". Server capabilities are reported from this build\'s static knowledge because the API advertises no capability document.',
  implementation: {
    kind: 'runtime',
    note: 'Local only: build metadata, resolved configuration, and the capability inventory. Issues no request.',
  },
  input: { type: 'object', additionalProperties: false, properties: {} },
  examples: [{ title: 'Describe the runtime', input: {} }],
};

const runtimeCommandSchema: AgentCommandSpec = {
  ...readOnly,
  name: 'runtime.command-schema',
  cli: 'command-schema',
  summary: 'Emit this command document, or one command from it.',
  description:
    'The machine-readable half of discovery: the same versioned document an adapter turns into tool definitions. Omit command for the whole document. A name that is not in this version is an error rather than an empty result, because silently returning nothing would let a host advertise a tool that does not exist.',
  implementation: {
    kind: 'runtime',
    note: 'Local only: serializes the compiled command document. Issues no request.',
  },
  input: {
    type: 'object',
    additionalProperties: false,
    properties: {
      command: {
        title: 'Command name',
        description: 'A dotted name from this document, e.g. `order.execute`.',
        type: 'string',
        minLength: 1,
        maxLength: 128,
      },
    },
  },
  examples: [
    { title: 'Whole document', input: {} },
    { title: 'One command', input: { command: 'order.execute' } },
  ],
};

const runtimeDoctor: AgentCommandSpec = {
  ...readOnly,
  name: 'runtime.doctor',
  cli: 'doctor',
  summary: 'Check configuration, signer, reachability and authentication.',
  description:
    'Diagnostics, not a trade. The authentication check signs the login challenge as a PERSONAL MESSAGE, which moves no funds and is not a transaction signature; no other check signs anything. Checks that cannot run without configuration are reported as skipped rather than passed. Pass accountId to include the allowance check when no default account is configured.',
  sideEffects: ['AUTHENTICATES'],
  implementation: {
    kind: 'runtime',
    note: 'Composes local checks with authenticate() and, when an account is known, getAllowance().',
  },
  input: {
    type: 'object',
    additionalProperties: false,
    properties: { accountId: { $ref: '#/$defs/accountId' } },
  },
  examples: [
    { title: 'Check the runtime', input: {} },
    { title: 'Include the allowance check', input: { accountId: EXAMPLE_ACCOUNT_ID } },
  ],
};

const accountStatus: AgentCommandSpec = {
  ...readOnly,
  name: 'account.status',
  cli: 'account status',
  summary: 'One reading of capacity and exposure for an account.',
  description:
    'Composes account.risk-limits and account.positions into the pre-trade picture: what may be spent, what the mandate allows, what would refuse a write, and what is already held. Every number here comes from the server; none is inferred locally. capacity is null exactly when no mandate exists, because an allowance ledger only exists under one — that is denial, not an unlimited default. asOf is when this runtime assembled the two reads, not a server-side consistent snapshot.',
  implementation: {
    kind: 'runtime',
    note: 'Composes getEffectiveLimits() and getPositions(). Never fabricates a limit; reports absence as absence.',
  },
  input: {
    type: 'object',
    required: ['accountId'],
    additionalProperties: false,
    properties: {
      accountId: { $ref: '#/$defs/accountId' },
      limit: { $ref: '#/$defs/limit' },
    },
  },
  examples: [{ title: 'Read account status', input: { accountId: EXAMPLE_ACCOUNT_ID } }],
};

/** Every command in this schema version, in a stable order. */
export const AGENT_COMMANDS: readonly AgentCommandSpec[] = [
  runtimeDescribe,
  runtimeCommandSchema,
  runtimeDoctor,
  marketList,
  marketSearch,
  marketGet,
  marketQuote,
  accountStatus,
  accountAllowance,
  accountRiskLimits,
  accountPositions,
  accountExecutions,
  accountFills,
  orderPreview,
  orderGet,
  orderReconcile,
  orderExecute,
  orderExecuteMany,
];

const BY_NAME: ReadonlyMap<string, AgentCommandSpec> = new Map(
  AGENT_COMMANDS.map((command) => [command.name, command]),
);

export function getCommand(name: string): AgentCommandSpec | undefined {
  return BY_NAME.get(name);
}

export function listCommandNames(): readonly string[] {
  return AGENT_COMMANDS.map((command) => command.name);
}

export { COMMAND_SCHEMA_DEFS };
