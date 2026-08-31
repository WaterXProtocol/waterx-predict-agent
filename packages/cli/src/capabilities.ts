/**
 * What this build can do, and — the part that matters — what it cannot.
 *
 * Discovery that lists only what works is indistinguishable from discovery that
 * forgot something. A host reading this has to be able to tell "refused here,
 * for this reason" from "not mentioned", so every capability the plan names
 * appears with an explicit status and a symbolic reason. Nothing is omitted to
 * make the list look complete.
 *
 * `market history` is the one that needs explaining. It is in the plan's command
 * surface and has no server endpoint behind it, and reconstructing a series from
 * repeated quotes would make this CLI a second source of truth for prices
 * nothing honoured — so it refuses instead.
 *
 * `market search` used to refuse for the same family of reason and no longer
 * does: the server resolves the text itself now (`?search=`), so the id handed
 * back is one the server resolved for that exact query. What has NOT changed is
 * the rule behind the old refusal — this CLI still never matches text against a
 * page it fetched (ADR-0001 §10). An unavailable capability becomes available by
 * the server growing an endpoint, never by the client approximating one.
 *
 * This module imports nothing. A workspace test cross-checks it against the
 * command contract, and that test must not be able to drag the whole CLI into
 * the workspace suite to do it.
 */

export type CapabilityStatus =
  /** Implemented, tested, and callable now. */
  | 'AVAILABLE'
  /** Specified, and the server offers nothing to build it on. */
  | 'UNAVAILABLE'
  /** Planned, and not built in this version. */
  | 'NOT_IMPLEMENTED';

export interface Capability {
  /** The CLI invocation, e.g. `market list`. */
  readonly id: string;
  /** The contract command name, when the capability is one. */
  readonly command?: string;
  readonly status: CapabilityStatus;
  readonly summary: string;
  /** Symbolic, stable, branchable. Absent only when the status is AVAILABLE. */
  readonly reason?: string;
  readonly detail?: string;
  /** What to do instead. Absent when there is nothing honest to suggest. */
  readonly alternative?: string;
  /** The backlog or decision id that tracks closing the gap. */
  readonly tracking?: string;
}

export const CAPABILITIES: readonly Capability[] = [
  {
    id: 'describe',
    command: 'runtime.describe',
    status: 'AVAILABLE',
    summary: 'Report this runtime, its configuration and this inventory. Needs no network.',
  },
  {
    id: 'command-schema',
    command: 'runtime.command-schema',
    status: 'AVAILABLE',
    summary: 'Emit the versioned command contract, or one command from it.',
  },
  {
    id: 'doctor',
    command: 'runtime.doctor',
    status: 'AVAILABLE',
    summary: 'Check configuration, signer, reachability and authentication.',
  },
  {
    id: 'onboard',
    command: 'runtime.onboard',
    status: 'AVAILABLE',
    summary:
      'What is still missing before this agent may trade, and the link an owner opens to grant it.',
  },
  {
    id: 'market list',
    command: 'market.list',
    status: 'AVAILABLE',
    summary: 'List the catalog. The only way to obtain a server-resolved marketId.',
  },
  {
    id: 'market get',
    command: 'market.get',
    status: 'AVAILABLE',
    summary: 'Read one market by id.',
  },
  {
    id: 'market quote',
    command: 'market.quote',
    status: 'AVAILABLE',
    summary: 'Mint a short-lived executable quote. Size-blind on this API version.',
  },
  {
    id: 'market search',
    command: 'market.search',
    status: 'AVAILABLE',
    summary:
      'Resolve free text to one market id, server-side. AMBIGUOUS is an answer, not a failure.',
  },
  {
    id: 'market history',
    status: 'UNAVAILABLE',
    summary: 'Read historical prices for a market.',
    reason: 'NO_SERVER_ENDPOINT',
    detail:
      'No price-history endpoint exists on this API version, and whether one belongs in the agent API is still undecided (D-25). Reconstructing a series from repeated quotes would be this CLI inventing history, at prices nothing honoured.',
    alternative:
      'Poll `market quote` and record the series yourself, understanding that it is your observation and not the exchange’s record.',
    tracking: 'D-25',
  },
  {
    id: 'account list',
    command: 'account.list',
    status: 'AVAILABLE',
    summary: 'The accounts an owner has onboarded this agent onto. The only account read needing no id.',
  },
  {
    id: 'account status',
    command: 'account.status',
    status: 'AVAILABLE',
    summary: 'Spendable capacity and open exposure in one read.',
  },
  {
    id: 'account allowance',
    command: 'account.allowance',
    status: 'AVAILABLE',
    summary: 'Remaining API allowance and spendable balance.',
  },
  {
    id: 'account positions',
    command: 'account.positions',
    status: 'AVAILABLE',
    summary: 'Open positions, with cost basis and unrealized PnL.',
  },
  {
    id: 'account executions',
    command: 'account.executions',
    status: 'AVAILABLE',
    summary: 'Order history, including rows that have not reached a terminal status.',
  },
  {
    id: 'account fills',
    command: 'account.fills',
    status: 'AVAILABLE',
    summary: 'Confirmed fills, with the quote each was priced against.',
  },
  {
    id: 'account performance',
    command: 'account.performance',
    status: 'AVAILABLE',
    summary:
      'Order outcomes, rejection reasons and realized PnL over API-attributed activity only, with the excluded populations counted rather than smoothed away.',
  },
  {
    id: 'account risk-limits',
    command: 'account.risk-limits',
    status: 'AVAILABLE',
    summary:
      'The mandate, the hour already used, the delegation, and what would refuse a write. Readable, never writable.',
  },
  {
    id: 'order preview',
    command: 'order.preview',
    status: 'AVAILABLE',
    summary:
      'Resolve, price and policy-check an order without placing it. Mints a quote; signs nothing.',
  },
  {
    id: 'order execute',
    command: 'order.execute',
    status: 'AVAILABLE',
    summary:
      'Place one protected market order. Refused under a read-only policy, and needs an approval or a delegation scope otherwise.',
  },
  {
    id: 'order execute-many',
    command: 'order.execute-many',
    status: 'AVAILABLE',
    summary:
      'Place several independent orders. Client-side and never atomic: legs succeed, fail and skip independently.',
  },
  {
    id: 'order get',
    command: 'order.get',
    status: 'AVAILABLE',
    summary: 'Read one execution by id.',
  },
  {
    id: 'order reconcile',
    command: 'order.reconcile',
    status: 'AVAILABLE',
    summary: 'Wait for one execution to reach a terminal state. The recovery path after a timeout.',
  },
  {
    id: 'order cancel',
    status: 'UNAVAILABLE',
    summary: 'Cancel a submitted order.',
    reason: 'NO_SERVER_ENDPOINT',
    detail:
      'These are market orders: once submitted, an order is on-chain and a keeper fills or rejects it. The API exposes nothing that cancels one, and a command that appeared to would be describing an effect it cannot have.',
    alternative:
      'Bound the exposure before submitting — `maxSlippageBps` and `worstAcceptablePrice` — and reconcile the outcome with `order reconcile`.',
    tracking: 'D-25',
  },
  {
    id: 'strategy create',
    command: 'strategy.create',
    status: 'AVAILABLE',
    summary:
      'Arm a durable conditional job on the local Runner. Requires a Runner listening on this machine; nothing server-side stores a price target, so a stopped Runner is a strategy that is not watching.',
  },
  {
    id: 'strategy get',
    command: 'strategy.get',
    status: 'AVAILABLE',
    summary: 'Read one strategy from the local Runner, including what is still unaccounted for.',
  },
  {
    id: 'strategy list',
    command: 'strategy.list',
    status: 'AVAILABLE',
    summary:
      'List the strategies one Runner holds. Scoped to that runtime directory: a job created against another is elsewhere, not absent.',
  },
  {
    id: 'strategy cancel',
    command: 'strategy.cancel',
    status: 'AVAILABLE',
    summary:
      'Record a cancellation, and report whether it was applied. A job with a write already in flight cannot be recalled.',
  },
  {
    id: 'strategy events',
    command: 'strategy.events',
    status: 'AVAILABLE',
    summary:
      'The transition and side-effect feed for one strategy, as of now. A snapshot, not a subscription.',
  },
  {
    id: 'runner',
    status: 'NOT_IMPLEMENTED',
    summary: 'Start, stop and inspect the local job runner from this CLI.',
    reason: 'NOT_BUILT',
    detail:
      'The strategy commands above reach a Runner that is already listening; managing the daemon itself is not built here. Start one with the `runnerd` binary in `@waterx/predict-agent-runner`, and read its health with `runner.status` over its socket. This CLI cannot start, stop or supervise one, and the device must stay awake and online for any job to progress.',
    alternative:
      'Run `runnerd` yourself, then use `strategy list` to confirm this CLI can reach it.',
    tracking: '2.6',
  },
];

const BY_ID: ReadonlyMap<string, Capability> = new Map(
  CAPABILITIES.map((capability) => [capability.id, capability]),
);

export const getCapability = (id: string): Capability | undefined => BY_ID.get(id);

/**
 * Capabilities that are named but not runnable. Looked up by the dispatcher so
 * a refusal comes from the same inventory `describe` published, and cannot drift
 * away from it.
 */
export const listRefusals = (): readonly Capability[] =>
  CAPABILITIES.filter((capability) => capability.status !== 'AVAILABLE');
