/**
 * The account read plane.
 *
 * `account status` is the only composite: it reads capacity and exposure in one
 * go, because that is the pair a caller actually needs before sizing anything.
 *
 * What it deliberately does NOT do is report a risk limit. The risk profile is
 * owner-authenticated (ADR-0003) and an agent credential cannot read it on this
 * API version, so the field says so — with a symbolic reason and the backlog id
 * that tracks it — rather than being omitted or filled with a plausible number.
 * An agent that reads a fabricated limit will size against it.
 */
import type { CommandContext } from '../context.ts';

const RISK_LIMITS_UNAVAILABLE = {
  available: false,
  reason: 'OWNER_AUTHENTICATED',
  detail:
    'The effective risk limits live behind the owner-authenticated surface (ADR-0003). An agent credential cannot read them on this API version, and no number is guessed here.',
  alternative:
    'Size against `capacity.effectiveBuyCapacity`, which the server computes as the smaller of the API allowance and the spendable balance.',
  tracking: 'B1',
} as const;

const accountId = (context: CommandContext): string => String(context.input.accountId);

const limitOf = (context: CommandContext): number | undefined =>
  typeof context.input.limit === 'number' ? context.input.limit : undefined;

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
  const response = await client.getPositions(accountId(context), limitOf(context), context.signal());
  return {
    accountId: accountId(context),
    positions: response.positions,
    count: response.positions.length,
    caveats: [
      'Scope is API-attributed activity. A direct-chain trade by the same delegated key is not included.',
      '`shares`, `avgEntryPrice` and `unrealizedPnl` are null — not zero — when the underlying fact is unknown. Zero would assert a flat or break-even position.',
    ],
  };
}

export async function accountExecutions(context: CommandContext): Promise<unknown> {
  const client = await context.client();
  const response = await client.listExecutions(accountId(context), limitOf(context), context.signal());
  return {
    accountId: accountId(context),
    executions: response.executions,
    count: response.executions.length,
    caveats: [
      'SUBMITTED and PENDING_FILL are not fills. Read a terminal status before reporting a trade as done.',
      'Paging is limit-only; there is no cursor, so a history longer than the cap cannot be fully reconstructed (backlog B6).',
    ],
  };
}

export async function accountFills(context: CommandContext): Promise<unknown> {
  const client = await context.client();
  const response = await client.getFills(accountId(context), limitOf(context), context.signal());
  return {
    accountId: accountId(context),
    fills: response.fills,
    count: response.fills.length,
    caveats: [
      '`txDigest` is the keeper transaction that settled the fill, not the agent’s submission.',
      '`actualFee` is null rather than zero: the published price is already fee-adjusted, so no separate fee is observable.',
      'Scope is API-attributed activity. A direct-chain trade by the same delegated key is not included.',
    ],
  };
}

/**
 * Capacity and exposure in one read.
 *
 * The two calls run concurrently: they are independent reads and serializing
 * them would only widen the window in which the two halves disagree. They can
 * still disagree — `asOf` is when this CLI assembled them, not a server-side
 * consistent snapshot, and that is said rather than implied.
 */
export async function accountStatus(context: CommandContext): Promise<unknown> {
  const id = accountId(context);
  const client = await context.client();
  const [allowance, positions] = await Promise.all([
    client.getAllowance(id, context.signal()),
    client.getPositions(id, limitOf(context), context.signal()),
  ]);

  return {
    accountId: id,
    asOf: context.now().toISOString(),
    capacity: {
      apiAllowance: allowance.apiAllowance,
      accountSpendableBalance: allowance.accountSpendableBalance,
      effectiveBuyCapacity: allowance.effectiveBuyCapacity,
    },
    exposure: {
      openPositions: positions.positions.length,
      positions: positions.positions,
    },
    riskLimits: RISK_LIMITS_UNAVAILABLE,
    caveats: [
      '`asOf` is when this runtime assembled the two reads, not a server-side consistent snapshot. They can differ by the time between them.',
      'The position list obeys `limit`, so `openPositions` counts what was returned, not necessarily everything held.',
    ],
  };
}
