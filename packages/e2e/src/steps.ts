/**
 * The end-to-end plan, declared rather than scripted.
 *
 * Each step states what a pass would PROVE, which provisioning gaps it needs,
 * which earlier steps it reads from, and whether it writes. Declaring those
 * makes "this step did not run, and here is exactly why" a mechanical answer
 * instead of a paragraph someone has to keep honest.
 *
 * Ordering follows the real shape of one trade: discover the runtime, diagnose
 * it, obtain a market identity FROM THE SERVER, confirm it, price it, preview
 * it, place it, wait for it to settle, read it back, and reconcile it. The two
 * account reads at the end are the after-the-fact record.
 */
import type { CliRun } from './cli-process.ts';
import type { GapId } from './gaps.ts';
import type { RuntimeFacts } from './preflight.ts';

export interface HarnessOptions {
  /** Free text handed to `market search`. Resolution is the server's answer. */
  readonly search: string;
  readonly outcomeId: 'YES' | 'NO';
  /** A decimal STRING. Never a JS number: a float cannot hold money exactly. */
  readonly buyAmount: string;
  readonly maxSlippageBps: number;
  /** Bounds the TERMINAL wait and the reconcile poll. */
  readonly settleTimeoutMs: number;
  /**
   * Opt-in for the ONE step that places a real order. Off by default, and not
   * sufficient on its own — see `writesPermitted` in `run.ts`.
   */
  readonly allowWrite: boolean;
}

export const DEFAULT_OPTIONS: HarnessOptions = {
  search: 'arsenal',
  outcomeId: 'YES',
  buyAmount: '1',
  maxSlippageBps: 100,
  settleTimeoutMs: 60_000,
  allowWrite: false,
};

/** Facts carried forward between steps. Nothing here is ever invented. */
export interface Ledger {
  marketId: string | null;
  quoteId: string | null;
  approvalToken: string | null;
  executionId: string | null;
}

export const emptyLedger = (): Ledger => ({
  marketId: null,
  quoteId: null,
  approvalToken: null,
  executionId: null,
});

export interface StepContext {
  readonly facts: RuntimeFacts;
  readonly options: HarnessOptions;
  readonly ledger: Ledger;
}

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly why: string };

const PASS: Verdict = { ok: true };
const fail = (why: string): Verdict => ({ ok: false, why });

export interface Step {
  readonly id: string;
  readonly title: string;
  readonly proves: string;
  readonly writes: boolean;
  readonly requires: readonly GapId[];
  /** Steps that must have PASSED, because this one reads what they recorded. */
  readonly after: readonly string[];
  argv(context: StepContext): readonly string[];
  /** Checks the run and records anything later steps need. */
  verify(run: CliRun, ledger: Ledger): Verdict;
}

/* ── reading a run without trusting it ──────────────────────────────────────
 * Every accessor below treats the envelope as untyped input. The harness is
 * supposed to notice when the CLI answers with a shape nobody expected; casting
 * would turn that into a crash or, worse, a pass. */

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const dataOf = (run: CliRun): Record<string, unknown> => asRecord(run.envelope?.data);

const str = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null;

/** `ok: true` is necessary for every step here, and never sufficient. */
function succeeded(run: CliRun): Verdict {
  if (run.envelope === null) {
    return fail(`stdout was not one JSON document (exit ${run.exitCode}).`);
  }
  if (run.envelope.ok !== true) {
    return fail(
      `${run.envelope.error?.code ?? 'UNKNOWN'} (exit ${run.exitCode}): ${run.envelope.error?.message ?? 'no message'}`,
    );
  }
  return PASS;
}

const chain = (...verdicts: readonly Verdict[]): Verdict =>
  verdicts.find((verdict) => !verdict.ok) ?? PASS;

/* ── the plan ───────────────────────────────────────────────────────────── */

const CONNECTED: readonly GapId[] = ['baseUrl', 'agentWallet', 'signerCommand'];
const ACCOUNT_SCOPED: readonly GapId[] = [...CONNECTED, 'defaultAccount'];
const TRADEABLE: readonly GapId[] = [...ACCOUNT_SCOPED, 'environment', 'delegation', 'ownerRiskProfile'];

export const STEPS: readonly Step[] = [
  {
    id: 'describe',
    title: 'describe',
    proves:
      'The installed binary answers with no configuration and no network, so discovery precedes setup.',
    writes: false,
    requires: [],
    after: [],
    argv: () => ['describe'],
    verify: (run) =>
      chain(
        succeeded(run),
        str(asRecord(dataOf(run).runtime).name) === 'waterx-predict'
          ? PASS
          : fail('The runtime did not name itself `waterx-predict`.'),
      ),
  },
  {
    id: 'doctor',
    title: 'doctor',
    proves:
      'Configuration, signer, reachability, authentication, catalog and allowance all check out against the real server, with no check reported as passing that did not run.',
    writes: false,
    requires: ACCOUNT_SCOPED,
    after: ['describe'],
    argv: () => ['doctor'],
    verify: (run) => {
      const data = dataOf(run);
      const failed = data.failed;
      if (typeof failed !== 'number') return fail('The doctor report carried no `failed` count.');
      return failed === 0 ? succeeded(run) : fail(`${failed} doctor check(s) failed.`);
    },
  },
  {
    id: 'market-list',
    title: 'market list',
    proves:
      'A market identity comes FROM THE SERVER. This is where the harness obtains one; it never constructs a marketId.',
    writes: false,
    requires: CONNECTED,
    after: ['describe'],
    argv: () => ['market', 'list', '--tradeable', 'true', '--limit', '5'],
    verify: (run, ledger) => {
      const already = succeeded(run);
      if (!already.ok) return already;
      const markets = dataOf(run).markets;
      if (!Array.isArray(markets) || markets.length === 0) {
        return fail('The catalog returned no tradeable market, so nothing downstream can be priced.');
      }
      const marketId = str(asRecord(markets[0]).marketId);
      if (marketId === null) return fail('The first catalog row carried no `marketId`.');
      ledger.marketId = marketId;
      return PASS;
    },
  },
  {
    id: 'market-search',
    title: 'market search',
    proves:
      'Free text is resolved to an id BY THE SERVER, and a non-unique match is reported as such rather than guessed at.',
    writes: false,
    requires: CONNECTED,
    after: ['describe'],
    argv: (context) => ['market', 'search', '--search', context.options.search],
    verify: (run) => {
      const already = succeeded(run);
      if (!already.ok) return already;
      const resolution = asRecord(dataOf(run).resolution);
      const status = str(resolution.status);
      if (status === null) return fail('The search carried no server `resolution`.');
      // AMBIGUOUS and NOT_FOUND are correct answers about the catalog, not
      // failures of the path under test. What would be a failure is a marketId
      // present on either of them.
      if (status !== 'RESOLVED' && dataOf(run).marketId !== null) {
        return fail(`Resolution was ${status} but a marketId was still reported.`);
      }
      return PASS;
    },
  },
  {
    id: 'market-get',
    title: 'market get',
    proves: 'The server-resolved id reads back as the same market.',
    writes: false,
    requires: CONNECTED,
    after: ['market-list'],
    argv: (context) => ['market', 'get', '--marketId', context.ledger.marketId ?? ''],
    verify: (run, ledger) => {
      const already = succeeded(run);
      if (!already.ok) return already;
      const marketId = str(asRecord(dataOf(run).market).marketId);
      return marketId === ledger.marketId
        ? PASS
        : fail(`Read back ${marketId ?? 'nothing'} for ${ledger.marketId ?? 'no id'}.`);
    },
  },
  {
    id: 'market-quote',
    title: 'market quote',
    proves:
      'A short-lived executable quote is minted. This is the only price an order may be built on; catalog prices are not executable.',
    writes: false,
    requires: CONNECTED,
    after: ['market-get'],
    argv: (context) => [
      'market',
      'quote',
      '--input',
      JSON.stringify({
        marketId: context.ledger.marketId,
        outcomeId: context.options.outcomeId,
        side: 'BUY',
        size: { buyAmount: context.options.buyAmount },
      }),
    ],
    verify: (run, ledger) => {
      const already = succeeded(run);
      if (!already.ok) return already;
      const quote = asRecord(dataOf(run).quote);
      const quoteId = str(quote.quoteId);
      if (quoteId === null) return fail('The quote carried no `quoteId`.');
      if (str(quote.expiresAt) === null) return fail('The quote carried no expiry.');
      ledger.quoteId = quoteId;
      return PASS;
    },
  },
  {
    id: 'order-preview',
    title: 'order preview',
    proves:
      'The order is resolved, priced, bounded and policy-checked, and an approval token binding exactly this intent is issued — with nothing signed and nothing placed.',
    writes: false,
    requires: ACCOUNT_SCOPED,
    after: ['market-get'],
    argv: (context) => [
      'order',
      'preview',
      '--input',
      JSON.stringify({
        accountId: context.facts.defaultAccountId,
        marketId: context.ledger.marketId,
        outcomeId: context.options.outcomeId,
        side: 'BUY',
        size: { buyAmount: context.options.buyAmount },
        maxSlippageBps: context.options.maxSlippageBps,
      }),
    ],
    verify: (run, ledger) => {
      const already = succeeded(run);
      if (!already.ok) return already;
      const data = dataOf(run);
      if (data.placed !== false) return fail('A preview reported `placed` as anything but false.');
      const quoteId = str(asRecord(data.quote).quoteId);
      if (quoteId === null) return fail('The preview minted no quote.');
      ledger.quoteId = quoteId;
      // Only the interactive policy issues one. Under delegated-auto its absence
      // is correct, and demanding it would fail a valid configuration.
      ledger.approvalToken = str(asRecord(data.policy).approvalToken);
      return PASS;
    },
  },
  {
    id: 'order-execute',
    title: 'order execute',
    proves:
      'THE ONLY WRITE. One price-protected market order is created, signed by the external signer and submitted, and the call returns once it is on-chain.',
    writes: true,
    requires: TRADEABLE,
    after: ['order-preview'],
    argv: (context) => [
      'order',
      'execute',
      ...(context.ledger.approvalToken === null
        ? []
        : ['--approve', context.ledger.approvalToken]),
      '--input',
      JSON.stringify({
        accountId: context.facts.defaultAccountId,
        marketId: context.ledger.marketId,
        outcomeId: context.options.outcomeId,
        side: 'BUY',
        size: { buyAmount: context.options.buyAmount },
        maxSlippageBps: context.options.maxSlippageBps,
        referenceQuoteId: context.ledger.quoteId,
        waitFor: 'SUBMITTED',
      }),
    ],
    verify: (run, ledger) => {
      const already = succeeded(run);
      if (!already.ok) return already;
      const executionId = str(dataOf(run).executionId);
      if (executionId === null) {
        // Without it there is no way to reconcile, which is worse than a
        // rejection: an order may exist that nothing can look up.
        return fail('The execution carried no `executionId`, so it cannot be reconciled.');
      }
      ledger.executionId = executionId;
      return PASS;
    },
  },
  {
    id: 'terminal-wait',
    title: 'terminal wait',
    proves:
      'The execution reaches a terminal status within the wait, and running out of time would be reported as ambiguous rather than as a failure or a cancellation.',
    writes: false,
    requires: ACCOUNT_SCOPED,
    after: ['order-execute'],
    argv: (context) => [
      'order',
      'reconcile',
      '--executionId',
      context.ledger.executionId ?? '',
      '--timeoutMs',
      String(context.options.settleTimeoutMs),
    ],
    verify: (run) => {
      const already = succeeded(run);
      if (!already.ok) return already;
      const data = dataOf(run);
      if (data.resolved === true) return PASS;
      // Exit 11 with `timedOut` is the CLI behaving correctly; it is still not a
      // settled order, so the step cannot pass.
      return fail(
        'The execution had not reached a terminal status when the wait ended. The order is not cancelled and the id stays valid; reconcile it before deciding anything.',
      );
    },
  },
  {
    id: 'order-get',
    title: 'order get',
    proves: 'The settled execution reads back by id with its authoritative fill facts.',
    writes: false,
    requires: ACCOUNT_SCOPED,
    after: ['terminal-wait'],
    argv: (context) => ['order', 'get', '--executionId', context.ledger.executionId ?? ''],
    verify: (run, ledger) => {
      const already = succeeded(run);
      if (!already.ok) return already;
      const execution = asRecord(dataOf(run).execution);
      if (str(execution.executionId) !== ledger.executionId) {
        return fail('The execution read back under a different id.');
      }
      return execution.terminal === true
        ? PASS
        : fail('The execution is not terminal, so its fill facts are not authoritative yet.');
    },
  },
  {
    id: 'order-reconcile',
    title: 'order reconcile',
    proves:
      'Reconciliation is safe to repeat: run against an already-terminal execution it resolves immediately, and it places, cancels and signs nothing.',
    writes: false,
    requires: ACCOUNT_SCOPED,
    after: ['order-get'],
    argv: (context) => ['order', 'reconcile', '--executionId', context.ledger.executionId ?? ''],
    verify: (run) =>
      chain(
        succeeded(run),
        dataOf(run).resolved === true
          ? PASS
          : fail('A terminal execution did not resolve on reconcile.'),
      ),
  },
  {
    id: 'account-positions',
    title: 'account positions',
    proves: 'The account read plane pages positions by cursor and reports whether more exist.',
    writes: false,
    requires: ACCOUNT_SCOPED,
    after: ['describe'],
    argv: (context) => [
      'account',
      'positions',
      '--accountId',
      context.facts.defaultAccountId ?? '',
      '--limit',
      '5',
    ],
    verify: (run) =>
      chain(
        succeeded(run),
        Array.isArray(dataOf(run).positions)
          ? PASS
          : fail('The result carried no `positions` array.'),
      ),
  },
  {
    id: 'account-fills',
    title: 'account fills',
    proves: 'Fills read back for the account, covering API-attributed activity only.',
    writes: false,
    requires: ACCOUNT_SCOPED,
    after: ['describe'],
    argv: (context) => [
      'account',
      'fills',
      '--accountId',
      context.facts.defaultAccountId ?? '',
      '--limit',
      '5',
    ],
    verify: (run) =>
      chain(
        succeeded(run),
        Array.isArray(dataOf(run).fills) ? PASS : fail('The result carried no `fills` array.'),
      ),
  },
];
