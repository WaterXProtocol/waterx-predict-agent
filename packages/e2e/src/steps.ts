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
 *
 * Then the durable half, which is a different shape and a different trust
 * boundary: several independent legs in one call, a conditional job armed on the
 * LOCAL Runner, that job surviving a restart of the process holding it, and —
 * last, and never withheld — its cancellation. The backend stores no target and
 * no conditional order, so everything after `strategy list` is answered by a
 * process on this machine.
 */
import type { CliRun } from './cli-process.ts';
import type { ExternalRunner } from './external.ts';
import type { GapId } from './gaps.ts';
import type { RuntimeFacts } from './preflight.ts';
import type { WriteCapability } from './report.ts';

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
   * Opt-in for the ONE step that places a single order. Off by default, and not
   * sufficient on its own — see `writePermission` in `run.ts`.
   */
  readonly allowWrite: boolean;
  /**
   * Opt-in for the multi-leg step, which places TWO orders. Separate from
   * `allowWrite` on purpose: someone who agreed to one order did not agree to
   * two, and a batch is the shape where that difference is easiest to miss.
   */
  readonly allowMultiLeg: boolean;
  /**
   * Opt-in for arming a strategy — the only step that leaves something behind
   * that could trade after this process exits. It is its own decision.
   */
  readonly allowStrategy: boolean;
  /**
   * The account owner's address, for the strategy job's record. Never inferred:
   * a guessed address attributes a trade to the wrong person.
   */
  readonly ownerAddress: string | null;
  /**
   * The operator's own command for restarting their Runner. This harness runs it
   * and never constructs one; see `external.ts`.
   */
  readonly runnerRestart: string | null;
  /**
   * The armed strategy's price target. The default is a BUY ceiling far below
   * any live ask, so the job waits rather than trades in the seconds it exists.
   */
  readonly strategyTargetPrice: string;
  /** How long the armed strategy is given. Well inside the seven-day beta cap. */
  readonly strategyExpiryMs: number;
  /** Bound on the operator's restart command. It must return by itself. */
  readonly restartTimeoutMs: number;
}

export const DEFAULT_OPTIONS: HarnessOptions = {
  search: 'arsenal',
  outcomeId: 'YES',
  buyAmount: '1',
  maxSlippageBps: 100,
  settleTimeoutMs: 60_000,
  allowWrite: false,
  allowMultiLeg: false,
  allowStrategy: false,
  ownerAddress: null,
  runnerRestart: null,
  // A BUY fires at or below its target, so 0.01 is a job that waits. It is still
  // a REAL trigger against a real market — not a disabled one — because a
  // strategy that could not fire would prove nothing about the one that can.
  strategyTargetPrice: '0.01',
  strategyExpiryMs: 15 * 60_000,
  restartTimeoutMs: 60_000,
};

/** Facts carried forward between steps. Nothing here is ever invented. */
export interface Ledger {
  marketId: string | null;
  quoteId: string | null;
  approvalToken: string | null;
  /** The one token that approves the whole multi-leg batch, from its preview. */
  batchApprovalToken: string | null;
  executionId: string | null;
  /** One fresh quote per multi-leg leg. A quote lives seconds and is not shared. */
  quoteLeg1: string | null;
  quoteLeg2: string | null;
  /** The armed job, recorded the moment it exists so the cancel step can find it. */
  jobId: string | null;
  /** Which Runner process answered before the restart. Recovery must change it. */
  runnerInstanceId: string | null;
}

export const emptyLedger = (): Ledger => ({
  marketId: null,
  quoteId: null,
  approvalToken: null,
  batchApprovalToken: null,
  executionId: null,
  quoteLeg1: null,
  quoteLeg2: null,
  jobId: null,
  runnerInstanceId: null,
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
  /**
   * Which opt-in this step needs, or `null` for a step that moves no funds.
   *
   * A capability rather than a boolean because the three writes here are three
   * different decisions — one order, two orders, and a job that can trade after
   * this process has exited — and one flag covering all three would let the
   * smallest of them authorize the largest.
   */
  readonly writes: WriteCapability | null;
  readonly requires: readonly GapId[];
  /** Steps that must have PASSED, because this one reads what they recorded. */
  readonly after: readonly string[];
  /**
   * A reason this step has nothing to do, or `null` to proceed.
   *
   * Distinct from a prerequisite: "there is no strategy to cancel" is not a
   * failure of anything, and reporting it as one would train a reader to ignore
   * the line that matters when there IS one.
   */
  readonly onlyIf?: (context: StepContext) => string | null;
  /**
   * Something that must happen to the world before the command runs — today,
   * exactly one thing: the operator's Runner restart. A failure here is not a
   * verdict on the CLI, so it produces a NOT_RUN rather than a FAILED step.
   */
  readonly prepare?: (context: StepContext, external: ExternalRunner) => Promise<Verdict>;
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
/** A strategy is armed on the Runner, on behalf of a named owner, to trade later. */
const ARMABLE: readonly GapId[] = [...TRADEABLE, 'runner', 'ownerAddress'];

/** The outcome the second leg prices. Two legs, two sides of the same market. */
const otherOutcome = (outcomeId: 'YES' | 'NO'): 'YES' | 'NO' => (outcomeId === 'YES' ? 'NO' : 'YES');

/** An absolute instant, which is the only form `expiresAt` accepts. */
const isoIn = (ms: number): string => new Date(Date.now() + ms).toISOString();

export const STEPS: readonly Step[] = [
  {
    id: 'describe',
    title: 'describe',
    proves:
      'The installed binary answers with no configuration and no network, so discovery precedes setup.',
    writes: null,
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
    writes: null,
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
    writes: null,
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
    writes: null,
    requires: CONNECTED,
    after: ['describe'],
    argv: (context) => ['market', 'search', '--search', context.options.search],
    verify: (run, ledger) => {
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
      // A UNIQUE resolution outranks the catalog's first row for everything that
      // follows. Two reasons, and neither is convenience: `--search` exists so an
      // operator can name the market a run should trade, and `market list
      // --tradeable true` can hand back a market with no live quote at all — the
      // catalog's tradeable flag and the quote feed's coverage are separate
      // facts, and picking row zero walks into that gap. The id is still the
      // SERVER's answer, which is what step three is about; it is simply the
      // answer to a better question.
      const resolved = str(resolution.marketId);
      if (status === 'RESOLVED' && resolved !== null) ledger.marketId = resolved;
      return PASS;
    },
  },
  {
    id: 'market-get',
    title: 'market get',
    proves: 'The server-resolved id reads back as the same market.',
    writes: null,
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
    writes: null,
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
    writes: null,
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
      'ONE price-protected market order is created, signed by the external signer and submitted, and the call returns once it is on-chain.',
    writes: 'order',
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
    writes: null,
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
    writes: null,
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
    writes: null,
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
    writes: null,
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
    writes: null,
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

  /* ── the durable half ─────────────────────────────────────────────────────
   * Everything below either places more than one order at once or leaves
   * something behind that can trade later. Each has its own opt-in, and the last
   * one has none at all — see `strategy-cancel`. */

  {
    id: 'multi-leg-quote-1',
    title: 'market quote (leg 1)',
    proves:
      'The first leg of a multi-leg entry gets its OWN executable quote. Legs do not share one: a quote lives seconds and prices one intent.',
    writes: null,
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
      const quoteId = str(asRecord(dataOf(run).quote).quoteId);
      if (quoteId === null) return fail('The quote carried no `quoteId`.');
      ledger.quoteLeg1 = quoteId;
      return PASS;
    },
  },
  {
    id: 'multi-leg-quote-2',
    title: 'market quote (leg 2)',
    proves:
      'The second leg is priced on the OTHER outcome of the same market, with a second quote — so the batch that follows is two genuinely independent intents.',
    writes: null,
    requires: CONNECTED,
    after: ['market-get'],
    argv: (context) => [
      'market',
      'quote',
      '--input',
      JSON.stringify({
        marketId: context.ledger.marketId,
        outcomeId: otherOutcome(context.options.outcomeId),
        side: 'BUY',
        size: { buyAmount: context.options.buyAmount },
      }),
    ],
    verify: (run, ledger) => {
      const already = succeeded(run);
      if (!already.ok) return already;
      const quoteId = str(asRecord(dataOf(run).quote).quoteId);
      if (quoteId === null) return fail('The quote carried no `quoteId`.');
      if (quoteId === ledger.quoteLeg1) {
        return fail('Both legs were handed the same quoteId, so they are not independent intents.');
      }
      ledger.quoteLeg2 = quoteId;
      return PASS;
    },
  },
  {
    id: 'order-preview-many',
    title: 'order preview (batch)',
    proves:
      'A BATCH is previewable, and the one token it returns is the one `execute-many` demands. Before this existed the only way to learn a batch approval was to be refused once and read it out of the error.',
    writes: null,
    requires: ACCOUNT_SCOPED,
    after: ['multi-leg-quote-1', 'multi-leg-quote-2'],
    argv: (context) => [
      'order',
      'preview',
      '--input',
      JSON.stringify({
        orders: [context.options.outcomeId, otherOutcome(context.options.outcomeId)].map(
          (outcomeId) => ({
            accountId: context.facts.defaultAccountId,
            marketId: context.ledger.marketId,
            outcomeId,
            side: 'BUY',
            size: { buyAmount: context.options.buyAmount },
            maxSlippageBps: context.options.maxSlippageBps,
          }),
        ),
      }),
    ],
    verify: (run, ledger) => {
      const already = succeeded(run);
      if (!already.ok) return already;
      const data = dataOf(run);
      if (data.placed !== false) return fail('A preview reported `placed` other than false.');
      if (data.atomic !== false) return fail('A batch preview did not say `atomic: false`.');
      const legs = data.legs;
      if (!Array.isArray(legs) || legs.length !== 2) {
        return fail('The batch preview did not carry one entry per leg.');
      }
      const token = str(asRecord(data.policy).approvalToken);
      if (token === null) return fail('The batch preview carried no approval token.');
      ledger.batchApprovalToken = token;
      return PASS;
    },
  },
  {
    id: 'order-execute-many',
    title: 'order execute-many',
    proves:
      'TWO orders in one call, and NOT atomically: each leg carries its own quote, its own idempotency key and its own result, and the reply reports succeeded, failed and skipped legs distinctly rather than one batch verdict.',
    writes: 'multi-leg',
    requires: TRADEABLE,
    after: ['multi-leg-quote-1', 'multi-leg-quote-2'],
    argv: (context) => {
      const leg = (outcomeId: 'YES' | 'NO', quoteId: string | null): Record<string, unknown> => ({
        accountId: context.facts.defaultAccountId,
        marketId: context.ledger.marketId,
        outcomeId,
        side: 'BUY',
        size: { buyAmount: context.options.buyAmount },
        // `referenceQuoteId` is DELIBERATELY absent. A quote lives seconds, so a
        // batch that pre-mints them is already wrong by the time leg two runs:
        // leg one's create/sign/submit outlives leg two's quote and that leg
        // fails QUOTE_EXPIRED having sent nothing. Omitted, each leg is quoted in
        // its own turn. Steps 14 and 15 above still prove a leg gets its OWN
        // quote; this step proves the legs are independent, not that a caller can
        // hold two quotes at once — which it cannot.
        maxSlippageBps: context.options.maxSlippageBps,
        // Stable per leg and per run, so a retry of exactly this intent carries
        // exactly this key rather than becoming a second order.
        idempotencyKey: `e2e-multi-${outcomeId}-${quoteId ?? 'none'}`.slice(0, 128),
      });
      return [
        'order',
        'execute-many',
        ...(context.ledger.batchApprovalToken === null
          ? []
          : ['--approve', context.ledger.batchApprovalToken]),
        '--input',
        JSON.stringify({
          orders: [
            leg(context.options.outcomeId, context.ledger.quoteLeg1),
            leg(otherOutcome(context.options.outcomeId), context.ledger.quoteLeg2),
          ],
          // ONE at a time. Parallelism across legs is the ACCOUNT's decision, not
          // this harness's: a mandate with `maxInFlightExecutions: 1` refuses a
          // second concurrent create, and a harness that insisted on two would be
          // failing a run for obeying its own risk profile. Sequential is also
          // what the leg-by-leg quoting above requires — a leg is quoted in its
          // own turn, which cannot happen if turns overlap (plan §5.5).
          concurrency: 1,
          // CONTINUE, because the point of this step is to observe INDEPENDENT
          // outcomes. STOP would hide a second leg's behaviour behind the first.
          failurePolicy: 'CONTINUE',
          waitFor: 'SUBMITTED',
        }),
      ];
    },
    verify: (run) => {
      const already = succeeded(run);
      if (!already.ok) return already;
      const data = dataOf(run);
      if (data.atomic !== false) {
        return fail('The batch did not report `atomic: false`, which is the one thing it must never imply.');
      }
      const results = data.results;
      if (!Array.isArray(results) || results.length !== 2) {
        return fail('The batch did not report one result per leg.');
      }
      const summary = asRecord(data.summary);
      const ids = results.map((result) => str(asRecord(result).executionId));
      if (summary.succeeded !== 2) {
        // Named per leg, because "the batch failed" is exactly the summary this
        // command exists not to give.
        const detail = results
          .map((result, index) => `leg ${index}: ${str(asRecord(result).status) ?? 'UNKNOWN'}`)
          .join(', ');
        return fail(`Not every leg succeeded (${detail}). Each leg is a separate order and each stands or falls alone.`);
      }
      if (ids[0] === null || ids[1] === null || ids[0] === ids[1]) {
        return fail('The two legs did not report two distinct execution ids.');
      }
      return PASS;
    },
  },
  {
    id: 'strategy-list',
    title: 'strategy list',
    proves:
      'A LOCAL Runner answers, names itself, and is driving jobs. Nothing server-side holds a price target, so this is the only thing that could advance a strategy.',
    writes: null,
    requires: ['runner'],
    after: ['describe'],
    argv: () => ['strategy', 'list'],
    verify: (run, ledger) => {
      const already = succeeded(run);
      if (!already.ok) return already;
      const data = dataOf(run);
      if (!Array.isArray(data.strategies)) return fail('The reply carried no `strategies` array.');
      const runner = asRecord(data.runner);
      const instanceId = str(runner.instanceId);
      if (instanceId === null) {
        return fail('The reply did not say WHICH Runner answered, so nothing later can tell it apart from another.');
      }
      ledger.runnerInstanceId = instanceId;
      return runner.driving === true
        ? PASS
        : fail('A Runner answered but is not driving jobs. A strategy armed on it would be armed and asleep.');
    },
  },
  {
    id: 'strategy-arm',
    title: 'strategy create',
    proves:
      'A durable conditional job is armed on the Runner with a PRICE trigger and a mandatory expiry, and it is WATCHING rather than filled — the target is a BUY ceiling far below the market, so the job waits.',
    writes: 'strategy',
    requires: ARMABLE,
    after: ['market-get', 'strategy-list'],
    argv: (context) => [
      'strategy',
      'create',
      '--input',
      JSON.stringify({
        ownerAddress: context.options.ownerAddress,
        accountId: context.facts.defaultAccountId,
        agentWallet: context.facts.agentWallet,
        strategyId: 'waterx-predict-e2e',
        expiresAt: isoIn(context.options.strategyExpiryMs),
        // No marketId, outcomeId or side on the trigger: they default from the
        // single leg, and letting them default is the behaviour under test.
        trigger: { kind: 'PRICE', targetPrice: context.options.strategyTargetPrice },
        legs: [
          {
            marketId: context.ledger.marketId,
            outcomeId: context.options.outcomeId,
            side: 'BUY',
            buyAmount: context.options.buyAmount,
            maxSlippageBps: context.options.maxSlippageBps,
          },
        ],
      }),
    ],
    verify: (run, ledger) => {
      // The job id is recorded BEFORE anything is judged. A create that armed a
      // real strategy and then failed a check is the case where the cancel step
      // matters most, and it can only cancel what it can name.
      const strategy = asRecord(dataOf(run).strategy);
      ledger.jobId = str(strategy.jobId);

      const already = succeeded(run);
      if (!already.ok) return already;
      if (ledger.jobId === null) return fail('The reply carried no `jobId`, so nothing can cancel this job.');
      if (strategy.terminal === true) {
        return fail(`The job was born terminal (${str(strategy.state) ?? 'unknown state'}).`);
      }
      if (str(asRecord(strategy.expiry).expiresAt) === null) {
        return fail('The job carried no expiry. Nothing watches a market forever.');
      }
      if (dataOf(run).driving !== true) {
        const gaps = dataOf(run).driverGaps;
        return fail(
          `The strategy was written but nothing is watching it (missing: ${
            Array.isArray(gaps) && gaps.length > 0 ? gaps.map(String).join(', ') : 'unstated'
          }). It is armed and asleep.`,
        );
      }
      return PASS;
    },
  },
  {
    id: 'strategy-restart-recovery',
    title: 'strategy get, after a Runner restart',
    proves:
      'THE RECOVERY CLAIM. The operator restarts their Runner; a DIFFERENT process answers, the same job is still there and still not terminal, and its unaccounted side effects are reported rather than assumed away.',
    writes: null,
    requires: [...ARMABLE, 'runnerRestart'],
    after: ['strategy-arm'],
    prepare: async (context, external) => {
      const command = context.options.runnerRestart;
      // Unreachable while `runnerRestart` gates this step, and cheaper to state
      // than to reason about: nothing here invents a command.
      if (command === null) return fail('No restart command was supplied, and none is invented.');
      const result = await external(command);
      return result.exitCode === 0
        ? PASS
        : fail(
            `The restart command exited ${result.exitCode}. ${result.output.slice(0, 200)}`.trim(),
          );
    },
    argv: (context) => ['strategy', 'get', '--jobId', context.ledger.jobId ?? ''],
    verify: (run, ledger) => {
      const already = succeeded(run);
      if (!already.ok) return already;
      const data = dataOf(run);
      const strategy = asRecord(data.strategy);
      if (str(strategy.jobId) !== ledger.jobId) {
        return fail('The job read back under a different id.');
      }
      const instanceId = str(asRecord(data.runner).instanceId);
      if (instanceId === null) return fail('The reply did not say which Runner answered.');
      if (instanceId === ledger.runnerInstanceId) {
        // Without this the step would pass against a restart command that did
        // nothing, and "survives a restart" would be a claim about no restart.
        return fail(
          'The same Runner instance answered, so no process was replaced. Nothing about crash recovery was established.',
        );
      }
      ledger.runnerInstanceId = instanceId;
      if (strategy.terminal === true) {
        return fail(`The restart left the job terminal (${str(strategy.state) ?? 'unknown state'}).`);
      }
      return Array.isArray(strategy.openSideEffects)
        ? PASS
        : fail('The job reported no `openSideEffects` list, which is the evidence a write may be unaccounted for.');
    },
  },
  {
    id: 'strategy-cancel',
    title: 'strategy cancel',
    proves:
      'The armed job is stopped, and the reply distinguishes RECORDED from APPLIED — a cancellation that did not stop anything is not a cancellation.',
    // Deliberately not a capability. The contract classifies cancel as a write,
    // but it moves no funds and can only ever stop trading; withholding it would
    // end a run by leaving a live strategy on the operator's Runner. So it is
    // never gated, and it is last.
    writes: null,
    requires: ['runner'],
    after: [],
    onlyIf: (context) =>
      context.ledger.jobId !== null
        ? null
        : 'No strategy was armed by this run, so there is nothing to cancel. If a create reported an unknown outcome, run `strategy list` — a job may exist that this report cannot name.',
    argv: (context) => [
      'strategy',
      'cancel',
      '--jobId',
      context.ledger.jobId ?? '',
      '--reason',
      'end of the waterx-predict e2e run',
    ],
    verify: (run) => {
      const already = succeeded(run);
      if (!already.ok) return already;
      const data = dataOf(run);
      if (data.recorded !== true) return fail('The cancellation was not even recorded.');
      return data.applied === true
        ? PASS
        : fail(
            `The cancellation was recorded but NOT applied (${str(data.pending) ?? 'no reason given'}). The strategy may still be armed — read it back with \`strategy get\` before walking away.`,
          );
    },
  },
];
