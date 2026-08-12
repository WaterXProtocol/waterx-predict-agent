/**
 * The account read plane.
 *
 * `account status` is the only composite: it reads the mandate and the exposure
 * in one go, because that is the pair a caller actually needs before sizing
 * anything.
 *
 * The risk limits are now a real server read (`account risk-limits`), so this
 * module reports them rather than refusing them — but the reason the old refusal
 * existed still governs the shape. A mandate that does not exist reads as `null`
 * with an explicit reason, never as an absent field and never as an unlimited
 * default: an agent that reads a fabricated limit will size against it, and
 * "unset" and "unlimited" are opposite instructions.
 */
import {
  hasMorePages,
  type PredictAgentListQuery,
  type PredictEffectiveLimitsResponseBody,
  type PredictPagedListResponse,
} from '@waterx/predict-agent-sdk';

import type { CommandContext } from '../context.ts';

const NO_MANDATE = {
  available: false,
  reason: 'NO_RISK_PROFILE',
  detail:
    'No owner has granted this agent a risk profile on this account. Absence is denial, not an unlimited default — a write would be refused with NO_RISK_PROFILE.',
  alternative:
    'The account owner must create the profile through the owner-authenticated surface (ADR-0003). An agent credential can read a mandate and can never raise one.',
} as const;

/**
 * Said on every history read, because the guarantee is not obvious and the
 * failure it prevents is silent.
 */
const PAGING_CAVEAT =
  'Pass `nextCursor` back as `--cursor` to continue; the cursor names a row, so a trade landing between two pages cannot shift rows past you. `hasMore: false` means the server proved there is nothing older; `hasMore: null` means it did not say.';

const RISK_CAVEATS: readonly string[] = [
  'An empty `blockers` is not a promise of a fill. It says these limits do not currently refuse an order; the market must still be tradeable, the quote still executable, and the chain still decides last.',
  'A null `delegation` permission means the chain read FAILED — not that it was denied. Treat it as unknown and retry; treating it as a revocation would tear down a healthy strategy.',
  '`usage` is a rolling window measured back from `asOf`, the same way the write path measures it — not a wall-clock hour bucket.',
];

const accountId = (context: CommandContext): string => String(context.input.accountId);

const limitOf = (context: CommandContext): number | undefined =>
  typeof context.input.limit === 'number' ? context.input.limit : undefined;

/**
 * The page request, with absent fields left absent.
 *
 * A cursor is passed through UNREAD. It is the server's opaque text; parsing,
 * trimming or regenerating one here would make this CLI a second authority on
 * where a page starts, and a cursor it "repaired" would be honoured against the
 * wrong row.
 */
function pageOf(context: CommandContext): PredictAgentListQuery {
  const limit = limitOf(context);
  const cursor = typeof context.input.cursor === 'string' ? context.input.cursor : undefined;
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  };
}

/**
 * The paging facts of a list response, in the shape every history command
 * reports them.
 *
 * `hasMore: null` is load-bearing. It means the server did not answer the
 * question — an older deployment with no keyset paging — and it must not read as
 * `false`, or a caller reconstructing a history would stop early and believe it
 * had everything.
 */
function pagingOf(response: PredictPagedListResponse): Record<string, unknown> {
  const more = hasMorePages(response);
  return {
    nextCursor: response.nextCursor ?? null,
    hasMore: more,
    ...(more === null
      ? {
          hasMoreReason:
            'This server did not return a `nextCursor` field at all, so whether more rows exist is UNKNOWN — not no.',
        }
      : {}),
  };
}

export async function accountAllowance(context: CommandContext): Promise<unknown> {
  const client = await context.client();
  const allowance = await client.getAllowance(accountId(context), context.signal());
  return {
    accountId: accountId(context),
    ...allowance,
    caveats: [
      '`apiAllowance` is a WaterX policy, not an on-chain guarantee: a delegated key can spend directly on chain without moving it.',
      '`effectiveBuyCapacity` is the smaller of the API allowance and the spendable balance. Size against that one.',
    ],
  };
}

export async function accountPositions(context: CommandContext): Promise<unknown> {
  const client = await context.client();
  const response = await client.getPositions(accountId(context), pageOf(context), context.signal());
  return {
    accountId: accountId(context),
    positions: response.positions,
    count: response.positions.length,
    ...pagingOf(response),
    caveats: [
      PAGING_CAVEAT,
      'Scope is API-attributed activity. A direct-chain trade by the same delegated key is not included.',
      '`shares`, `avgEntryPrice` and `unrealizedPnl` are null — not zero — when the underlying fact is unknown. Zero would assert a flat or break-even position.',
    ],
  };
}

export async function accountExecutions(context: CommandContext): Promise<unknown> {
  const client = await context.client();
  const response = await client.listExecutions(accountId(context), pageOf(context), context.signal());
  return {
    accountId: accountId(context),
    executions: response.executions,
    count: response.executions.length,
    ...pagingOf(response),
    caveats: [
      'SUBMITTED and PENDING_FILL are not fills. Read a terminal status before reporting a trade as done.',
      PAGING_CAVEAT,
    ],
  };
}

export async function accountFills(context: CommandContext): Promise<unknown> {
  const client = await context.client();
  const response = await client.getFills(accountId(context), pageOf(context), context.signal());
  return {
    accountId: accountId(context),
    fills: response.fills,
    count: response.fills.length,
    ...pagingOf(response),
    caveats: [
      PAGING_CAVEAT,
      '`txDigest` is the keeper transaction that settled the fill, not the agent’s submission.',
      '`actualFee` is null rather than zero: the published price is already fee-adjusted, so no separate fee is observable.',
      'Scope is API-attributed activity. A direct-chain trade by the same delegated key is not included.',
    ],
  };
}

/**
 * The mandate as the server states it: limits, allowance, hour consumed,
 * delegation, and every reason a write would be refused right now.
 *
 * One server read and one `asOf`, so the five facts are consistent with each
 * other. Assembling the same picture from separate calls would leave a caller
 * unable to tell a limit that moved from a limit that was read at a different
 * moment.
 */
export async function accountRiskLimits(context: CommandContext): Promise<unknown> {
  const client = await context.client();
  const facts = await client.getEffectiveLimits(accountId(context), context.signal());
  return {
    accountId: facts.accountId,
    asOf: facts.asOf,
    ...toRiskView(facts),
    caveats: RISK_CAVEATS,
  };
}

/**
 * The server's effective-limits body → the reported shape, minus the account id
 * and the timestamp so each caller can stamp its own.
 *
 * `limits: null` is turned into an explicit `available: false` with a reason
 * rather than being passed through as a bare null. Both say the same thing, but
 * a caller branching on a symbolic reason cannot mistake "no mandate" for "field
 * missing from an older build".
 */
function toRiskView(facts: PredictEffectiveLimitsResponseBody): Record<string, unknown> {
  return {
    agentWallet: facts.agentWallet,
    limits: facts.limits === null ? NO_MANDATE : { available: true, ...facts.limits },
    capacity: facts.allowance,
    usage: facts.usage,
    delegation: facts.delegation,
    blockers: facts.blockers,
    tradingBlocked: facts.blockers.length > 0,
  };
}

/**
 * Capacity, mandate and exposure in one read.
 *
 * The two calls run concurrently: they are independent reads and serializing
 * them would only widen the window in which the two halves disagree. They can
 * still disagree — `asOf` is when this CLI assembled them, not a server-side
 * consistent snapshot, and that is said rather than implied.
 */
export async function accountStatus(context: CommandContext): Promise<unknown> {
  const id = accountId(context);
  const client = await context.client();
  const [facts, positions] = await Promise.all([
    client.getEffectiveLimits(id, context.signal()),
    client.getPositions(id, pageOf(context), context.signal()),
  ]);

  return {
    accountId: id,
    asOf: context.now().toISOString(),
    ...toRiskView(facts),
    exposure: {
      openPositions: positions.positions.length,
      positions: positions.positions,
    },
    caveats: [
      '`asOf` is when this runtime assembled the two reads, not a server-side consistent snapshot. They can differ by the time between them.',
      'The position list obeys `limit`, so `openPositions` counts what was returned, not necessarily everything held. `account positions --cursor` walks the rest; this composite reports only its first page.',
      '`capacity` is null exactly when there is no mandate: the allowance ledger only exists under one. Null is denial, not an unlimited budget.',
      ...RISK_CAVEATS,
    ],
  };
}
