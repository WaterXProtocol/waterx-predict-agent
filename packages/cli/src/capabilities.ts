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

/**
 * Something outside this process that a capability needs at the moment it is
 * called.
 *
 * `AVAILABLE` means the command is built, tested and callable. It does not mean
 * the thing the command talks to is running, and it does not mean that thing is
 * even installed — the Runner is a separate binary this install does not carry.
 * A host that cannot tell those apart advertises a tool that always fails, which
 * is worse than advertising no tool at all.
 */
export interface CapabilityRequirement {
  /** Symbolic, so a host can branch on it without reading English. */
  readonly kind: 'LOCAL_RUNNER';
  readonly says: string;
  /** How to find out whether it is there. Runnable as printed. */
  readonly check: string;
}

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
  /** What must be running elsewhere for this to work. See {@link CapabilityRequirement}. */
  readonly requires?: CapabilityRequirement;
  /** The backlog or decision id that tracks closing the gap. */
  readonly tracking?: string;
}

/**
 * The Runner every `strategy` command talks to.
 *
 * It is a SEPARATE process and a separate binary, and this install does not
 * contain it: `@waterx/predict-agent-runner` is private and unpublished, and
 * the documented install carries `waterx-predict` and `waterx-predict-keystore`
 * and nothing else. So these commands are built and callable, and on a stock
 * install every one of them answers `RUNNER_UNREACHABLE` until an operator has
 * built and started a Runner themselves.
 */
const RUNNER_REQUIRED: CapabilityRequirement = {
  kind: 'LOCAL_RUNNER',
  says:
    'A Runner must be running on this machine. It is a separate binary that this install does NOT ship: build it from the repository (`pnpm install && pnpm build`) and run `node packages/runner/dist/src/bin/runnerd.js`. Until one is listening every strategy command answers RUNNER_UNREACHABLE, and nothing server-side holds a price target in the meantime.',
  check: 'waterx-predict strategy list --json',
};

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
    id: 'configure',
    command: 'runtime.configure',
    status: 'AVAILABLE',
    summary:
      "Write the agent wallet and signer command into this machine's config file. Writes no network, policy or account, and sends nothing.",
  },
  {
    id: 'policy',
    command: 'runtime.policy',
    status: 'AVAILABLE',
    summary: 'What this runtime may sign, and the three modes it could be in, with what each allows.',
  },
  {
    id: 'policy set',
    command: 'runtime.policy-set',
    status: 'AVAILABLE',
    summary: "Set the execution policy. A person's command: widening it needs --yes.",
  },
  {
    id: 'next',
    command: 'runtime.next',
    status: 'AVAILABLE',
    summary:
      'Where this agent stands and what to do next, as contract commands with who must run each.',
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
    id: 'position claim',
    status: 'NOT_IMPLEMENTED',
    summary: 'Collect a resolved position’s payout back into the account.',
    reason: 'NOT_BUILT',
    detail:
      'A position on a market that resolved is no longer tradeable — it stopped quoting, so it cannot be sold, and its money comes back only by being claimed. The server has a route for it (`POST /predict/bets/claim`, authorized for the same trading-capable delegate this runtime already is), and nothing here calls it: claiming is N `claim_position` calls in one transaction, and the verifier that must approve every sponsored byte is built around one trading call per transaction. Widening it is a change to the boundary that gates money, not an addition to a command list. Until then this runtime can SEE such a position and report that its value is unknown, and cannot get the money back.',
    alternative:
      'Read what is held with `account positions` — a position with no live sell-side quote is reported as `UNPRICED_POSITION` — and collect it from the WaterX web app, signing as the account owner.',
    tracking: 'B-CLAIM',
  },
  {
    id: 'strategy create',
    command: 'strategy.create',
    status: 'AVAILABLE',
    summary:
      'Arm a durable conditional job on the local Runner. Requires a Runner listening on this machine; nothing server-side stores a price target, so a stopped Runner is a strategy that is not watching.',
    requires: RUNNER_REQUIRED,
  },
  {
    id: 'strategy get',
    command: 'strategy.get',
    status: 'AVAILABLE',
    summary: 'Read one strategy from the local Runner, including what is still unaccounted for.',
    requires: RUNNER_REQUIRED,
  },
  {
    id: 'strategy list',
    command: 'strategy.list',
    status: 'AVAILABLE',
    summary:
      'List the strategies one Runner holds. Scoped to that runtime directory: a job created against another is elsewhere, not absent.',
    requires: RUNNER_REQUIRED,
  },
  {
    id: 'strategy cancel',
    command: 'strategy.cancel',
    status: 'AVAILABLE',
    summary:
      'Record a cancellation, and report whether it was applied. A job with a write already in flight cannot be recalled.',
    requires: RUNNER_REQUIRED,
  },
  {
    id: 'strategy events',
    command: 'strategy.events',
    status: 'AVAILABLE',
    summary:
      'The transition and side-effect feed for one strategy, as of now. A snapshot, not a subscription.',
    requires: RUNNER_REQUIRED,
  },
  {
    id: 'runner',
    status: 'NOT_IMPLEMENTED',
    summary: 'Start, stop and inspect the local job runner from this CLI.',
    reason: 'NOT_BUILT',
    detail:
      'The strategy commands above reach a Runner that is already listening; managing the daemon itself is not built here. Nor is the daemon INSTALLED: `@waterx/predict-agent-runner` is private and unpublished, and this install carries `waterx-predict` and `waterx-predict-keystore` only — so `npm install` alone leaves every strategy command answering RUNNER_UNREACHABLE. Build the Runner from the repository and run it yourself; this CLI cannot start, stop or supervise one, and the device must stay awake and online for any job to progress.',
    alternative:
      'Clone the repository, `pnpm install && pnpm build`, run `node packages/runner/dist/src/bin/runnerd.js`, then `waterx-predict strategy list` to confirm this CLI can reach it.',
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
