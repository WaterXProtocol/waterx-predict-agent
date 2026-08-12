/**
 * THE EXECUTION POLICY — what this runtime is allowed to sign, and on whose say-so.
 *
 * Three modes (plan §6.6), and the difference between them is enforced here and
 * in the signer, never by a command remembering to ask:
 *
 *   read-only      no signing, no writes. The signer cannot produce a transaction
 *                  signature at all, so this is a property of the build rather
 *                  than a habit of its callers.
 *   interactive    the default. Reads and previews run unattended; every write
 *                  needs one explicit approval naming the exact intent.
 *   delegated-auto pre-authorized within an explicitly stated scope. Anything the
 *                  scope does not name is refused, and an unscoped delegated-auto
 *                  is a configuration error rather than a blank cheque.
 *
 * WHAT AN APPROVAL TOKEN IS, AND IS NOT. It is a digest of the normalized intent:
 * change the account, market, side, size, position or price protection and the
 * token stops matching. That makes an approval BINDING on one specific trade, so
 * an approval obtained for a small buy cannot be replayed onto a large one. It is
 * NOT authentication and it does not prove a human saw anything: any caller that
 * can run `order preview` can compute it. Its job is to make a write impossible
 * as the incidental side effect of a single call — the host has to carry a value
 * from the preview to the execution, and a human-in-the-loop host puts the human
 * at exactly that seam. This is stated plainly wherever the token is reported,
 * because a policy that is believed to be stronger than it is, is worse than none.
 *
 * WHAT LOCAL POLICY CANNOT DO. It can only ever narrow. The backend's risk profile
 * is owner-authenticated (ADR-0003) and an agent credential cannot read it on this
 * API version, so this module never claims a delegation the server granted — it
 * constrains what this runtime will ask for, and the server independently refuses
 * anything beyond the owner's limits. A delegated-auto BUY is additionally checked
 * against the server's own `effectiveBuyCapacity`, so the local ceiling can never
 * authorize more than the exchange currently allows.
 */
import { createHash } from 'node:crypto';

import { CliError } from './errors.ts';
import { formatDecimal, parseDecimal } from './decimal.ts';

export type PolicyMode = 'read-only' | 'interactive' | 'delegated-auto';

/** Ascending permissiveness. A `--policy` flag may only move DOWN this list. */
export const POLICY_STRICTNESS: readonly PolicyMode[] = [
  'read-only',
  'interactive',
  'delegated-auto',
];

export const isPolicyMode = (value: string): value is PolicyMode =>
  (POLICY_STRICTNESS as readonly string[]).includes(value);

/**
 * The bounds a delegated-auto policy must state before it will authorize anything.
 *
 * Every ceiling that applies to an allowed side is REQUIRED. An optional ceiling
 * is one somebody forgets, and a forgotten ceiling in an auto-approving policy is
 * an unbounded one — so the config is refused instead (see `parseDelegatedScope`).
 */
export interface DelegatedScope {
  /** Account allowlist. Non-empty: "any account" is not a scope. */
  readonly accounts: readonly string[];
  /** Market allowlist, or undefined for any market the accounts can reach. */
  readonly markets: readonly string[] | undefined;
  readonly sides: readonly ('BUY' | 'SELL')[];
  /** Per-order wxUSD budget ceiling. Required when BUY is allowed. */
  readonly maxBuyAmount: string | undefined;
  /** Cumulative wxUSD budget ceiling across one invocation. Required with BUY. */
  readonly maxCumulativeBuyAmount: string | undefined;
  /** Per-order share ceiling. Required when SELL is allowed. */
  readonly maxSellShares: string | undefined;
  readonly maxSlippageBps: number;
  readonly maxLegs: number;
  /** ISO-8601 instant after which this delegation authorizes nothing. */
  readonly notAfter: string;
  /** Strategy-id allowlist, or undefined to allow any (including none). */
  readonly strategyIds: readonly string[] | undefined;
}

export interface ExecutionPolicy {
  readonly mode: PolicyMode;
  /** Present only for delegated-auto; parsing guarantees the pairing. */
  readonly scope: DelegatedScope | undefined;
  /** Where the mode came from, so `describe` can show it was not a default. */
  readonly source: 'DEFAULT' | 'CONFIG_FILE' | 'ENVIRONMENT' | 'FLAG';
}

export const DEFAULT_POLICY: ExecutionPolicy = {
  mode: 'interactive',
  scope: undefined,
  source: 'DEFAULT',
};

/* ── Normalized intent and approval tokens ─────────────────────────────────── */

/**
 * One write, reduced to the facts that decide whether it is safe.
 *
 * `referenceQuoteId` is NOT here on purpose: a quote lives seconds, so binding an
 * approval to one would make every approval stale before it could be used, and
 * would push callers toward approving whatever quote happened to be current.
 * Price is bound instead through `maxSlippageBps` and `worstAcceptablePrice`,
 * which are the protection the caller actually chose. `idempotencyKey`, `waitFor`
 * and `timeoutMs` are absent because they change how a retry or a wait behaves,
 * not what is traded.
 */
export interface NormalizedLeg {
  readonly accountId: string;
  readonly marketId: string;
  readonly outcomeId: string;
  readonly side: 'BUY' | 'SELL';
  readonly sizeUnit: 'WXUSD_BUDGET' | 'SHARES';
  readonly size: string;
  readonly positionId: string | null;
  readonly maxSlippageBps: number;
  readonly worstAcceptablePrice: string | null;
  readonly strategyId: string | null;
  readonly clientOrderId: string | null;
}

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * Command input → normalized leg.
 *
 * The input has already passed the command schema, so exactly one of
 * `buyAmount`/`sellShares` is present and it agrees with the side. Anything this
 * function still finds ambiguous is a contract bug, and it throws rather than
 * picking a unit — an ambiguous size must stop before a write (ADR-0001 §11).
 */
export function normalizeLeg(input: Readonly<Record<string, unknown>>): NormalizedLeg {
  const size = input.size as Record<string, unknown> | undefined;
  const buyAmount = size === undefined ? null : asString(size.buyAmount);
  const sellShares = size === undefined ? null : asString(size.sellShares);
  const side = input.side === 'SELL' ? 'SELL' : 'BUY';

  if ((buyAmount === null) === (sellShares === null)) {
    throw new CliError(
      'INVALID_INPUT',
      'The order size is ambiguous: exactly one of `size.buyAmount` (BUY) or `size.sellShares` (SELL) must be present. Nothing was sent and no unit was guessed.',
      { side, hasBuyAmount: buyAmount !== null, hasSellShares: sellShares !== null },
    );
  }
  if ((side === 'BUY') !== (buyAmount !== null)) {
    throw new CliError(
      'INVALID_INPUT',
      'The side and the size unit disagree: a BUY commits `size.buyAmount` in wxUSD and a SELL closes `size.sellShares`. They are not interchangeable.',
      { side, unit: buyAmount !== null ? 'WXUSD_BUDGET' : 'SHARES' },
    );
  }

  return {
    accountId: String(input.accountId),
    marketId: String(input.marketId),
    outcomeId: String(input.outcomeId),
    side,
    sizeUnit: side === 'BUY' ? 'WXUSD_BUDGET' : 'SHARES',
    size: (buyAmount ?? sellShares) as string,
    positionId: asString(input.positionId),
    maxSlippageBps: Number(input.maxSlippageBps),
    worstAcceptablePrice: asString(input.worstAcceptablePrice),
    strategyId: asString(input.strategyId),
    clientOrderId: asString(input.clientOrderId),
  };
}

/** Field order is fixed here, so the same intent always digests to the same token. */
function canonical(leg: NormalizedLeg): string {
  return JSON.stringify([
    leg.accountId,
    leg.marketId,
    leg.outcomeId,
    leg.side,
    leg.sizeUnit,
    leg.size,
    leg.positionId,
    leg.maxSlippageBps,
    leg.worstAcceptablePrice,
    leg.strategyId,
    leg.clientOrderId,
  ]);
}

const digest = (material: string): string =>
  `apv1_${createHash('sha256').update(material).digest('hex').slice(0, 16)}`;

/** The token that approves exactly this one order and no other. */
export const approvalToken = (leg: NormalizedLeg): string => digest(canonical(leg));

/**
 * The token that approves one whole batch.
 *
 * Derived from the per-leg tokens, in order, so it is reproducible: a caller can
 * preview each leg, collect its token, and arrive at the same batch token this
 * runtime computed. Reordering the legs changes it, because a batch that stops on
 * the first failure is a different intent when its order changes.
 */
export const batchApprovalToken = (legs: readonly NormalizedLeg[]): string =>
  digest(legs.map(approvalToken).join('|'));

/* ── Authorization ─────────────────────────────────────────────────────────── */

export interface WriteRequest {
  /** The contract command name, e.g. `order.execute`. */
  readonly command: string;
  readonly legs: readonly NormalizedLeg[];
  /** From `--approve`. */
  readonly approval: string | undefined;
  /** For the delegated-auto capacity check. Undefined when it was not read. */
  readonly effectiveBuyCapacity?: string | undefined;
  readonly now: Date;
}

export interface WriteAuthorization {
  /** How many transaction signatures this authorization permits. */
  readonly permits: number;
  readonly basis: 'INTERACTIVE_APPROVAL' | 'DELEGATED_AUTO';
  /** The token that was required, echoed so a result can record what was approved. */
  readonly token: string;
  /** Scope constraints that were checked, for the record. Empty under interactive. */
  readonly checks: readonly string[];
}

const denyReadOnly = (command: string): CliError =>
  new CliError(
    'POLICY_DENIED',
    `The execution policy is read-only, so \`${command}\` was refused locally. Nothing was sent, no quote was minted and no signer process was started.`,
    {
      policy: 'read-only',
      command,
      remedy:
        'Set `policy.mode` to `interactive` in the config file (or WATERX_PREDICT_POLICY=interactive) to enable approved writes.',
    },
  );

const denyApproval = (request: WriteRequest, expected: string): CliError =>
  new CliError(
    'POLICY_DENIED',
    request.approval === undefined
      ? `\`${request.command}\` is a write and the policy is interactive, so it needs one explicit approval. Nothing was sent. Re-run with \`--approve ${expected}\`.`
      : `The approval \`${request.approval}\` does not match this intent. An approval names one exact order — account, market, side, size, position and price protection — so it cannot be carried onto a different one. Nothing was sent.`,
    {
      policy: 'interactive',
      command: request.command,
      expectedApproval: expected,
      ...(request.approval !== undefined ? { suppliedApproval: request.approval } : {}),
      intent: request.legs,
      note: 'An approval token binds one intent. It is not authentication: it proves the caller carried a value from a preview to an execution, not that a person saw it.',
    },
  );

const denyScope = (request: WriteRequest, violation: string, details: Record<string, unknown>): CliError =>
  new CliError(
    'POLICY_DENIED',
    `The delegated-auto scope does not cover this order: ${violation}. Nothing was sent. A scope is a ceiling, so widen it deliberately or approve this order under the interactive policy.`,
    { policy: 'delegated-auto', command: request.command, violation, ...details },
  );

/**
 * Decide whether this write may proceed, and how many signatures it may cost.
 *
 * Throws rather than returning a refusal, because every caller's correct
 * behaviour on a denial is identical: send nothing. Returning a flag would let a
 * missed branch trade.
 */
export function authorizeWrite(
  policy: ExecutionPolicy,
  request: WriteRequest,
): WriteAuthorization {
  if (policy.mode === 'read-only') throw denyReadOnly(request.command);

  const expected =
    request.legs.length === 1 && request.legs[0] !== undefined
      ? approvalToken(request.legs[0])
      : batchApprovalToken(request.legs);

  if (policy.mode === 'interactive') {
    if (request.approval !== expected) throw denyApproval(request, expected);
    return {
      permits: request.legs.length,
      basis: 'INTERACTIVE_APPROVAL',
      token: expected,
      checks: [],
    };
  }

  const scope = policy.scope;
  if (scope === undefined) {
    // Unreachable through `parseExecutionPolicy`, which refuses the pairing.
    throw new CliError(
      'CONFIG_INVALID',
      'The policy is delegated-auto with no scope. An auto-approving policy without stated ceilings is refused.',
    );
  }

  const checks: string[] = [];

  const notAfter = Date.parse(scope.notAfter);
  if (Number.isNaN(notAfter) || request.now.getTime() > notAfter) {
    throw denyScope(request, 'the delegation window has closed', {
      notAfter: scope.notAfter,
      now: request.now.toISOString(),
    });
  }
  checks.push(`validity window until ${scope.notAfter}`);

  if (request.legs.length > scope.maxLegs) {
    throw denyScope(request, 'too many legs', {
      legs: request.legs.length,
      maxLegs: scope.maxLegs,
    });
  }
  checks.push(`at most ${String(scope.maxLegs)} legs`);

  let cumulativeBuy = 0n;
  for (const [index, leg] of request.legs.entries()) {
    const where = { leg: index, accountId: leg.accountId, marketId: leg.marketId };

    if (!scope.accounts.includes(leg.accountId)) {
      throw denyScope(request, 'the account is not in the scope', {
        ...where,
        accounts: scope.accounts,
      });
    }
    if (scope.markets !== undefined && !scope.markets.includes(leg.marketId)) {
      throw denyScope(request, 'the market is not in the scope', { ...where, markets: scope.markets });
    }
    if (!scope.sides.includes(leg.side)) {
      throw denyScope(request, `the ${leg.side} side is not in the scope`, {
        ...where,
        sides: scope.sides,
      });
    }
    if (leg.maxSlippageBps > scope.maxSlippageBps) {
      throw denyScope(request, 'the slippage budget exceeds the scope', {
        ...where,
        maxSlippageBps: leg.maxSlippageBps,
        scopeMaxSlippageBps: scope.maxSlippageBps,
      });
    }
    if (
      scope.strategyIds !== undefined &&
      (leg.strategyId === null || !scope.strategyIds.includes(leg.strategyId))
    ) {
      throw denyScope(request, 'the strategy id is not in the scope', {
        ...where,
        strategyId: leg.strategyId,
        strategyIds: scope.strategyIds,
      });
    }

    const size = parseDecimal(leg.size);
    if (size === null) {
      throw denyScope(request, 'the size is not a decimal this API can trade', { ...where });
    }

    if (leg.side === 'BUY') {
      const ceiling = scope.maxBuyAmount === undefined ? null : parseDecimal(scope.maxBuyAmount);
      if (ceiling === null || size > ceiling) {
        throw denyScope(request, 'the order budget exceeds the per-order ceiling', {
          ...where,
          buyAmount: leg.size,
          maxBuyAmount: scope.maxBuyAmount ?? null,
        });
      }
      cumulativeBuy += size;
    } else {
      const ceiling = scope.maxSellShares === undefined ? null : parseDecimal(scope.maxSellShares);
      if (ceiling === null || size > ceiling) {
        throw denyScope(request, 'the share count exceeds the per-order ceiling', {
          ...where,
          sellShares: leg.size,
          maxSellShares: scope.maxSellShares ?? null,
        });
      }
    }
  }

  if (cumulativeBuy > 0n) {
    const ceiling =
      scope.maxCumulativeBuyAmount === undefined
        ? null
        : parseDecimal(scope.maxCumulativeBuyAmount);
    if (ceiling === null || cumulativeBuy > ceiling) {
      throw denyScope(request, 'the combined budget exceeds the cumulative ceiling', {
        cumulativeBuyAmount: formatDecimal(cumulativeBuy),
        maxCumulativeBuyAmount: scope.maxCumulativeBuyAmount ?? null,
      });
    }
    checks.push(
      `cumulative budget ${formatDecimal(cumulativeBuy)} within ${scope.maxCumulativeBuyAmount ?? ''}`,
    );

    // The local ceiling is a ceiling on what this runtime will ASK FOR. The
    // server's own figure is the one that binds, so a delegated-auto buy is
    // additionally refused when it exceeds what the exchange says is spendable
    // right now — local policy can narrow the server's limits and never widen them.
    const capacity =
      request.effectiveBuyCapacity === undefined
        ? null
        : parseDecimal(request.effectiveBuyCapacity);
    if (capacity !== null && cumulativeBuy > capacity) {
      throw denyScope(request, 'the combined budget exceeds the account’s effective buy capacity', {
        cumulativeBuyAmount: formatDecimal(cumulativeBuy),
        effectiveBuyCapacity: request.effectiveBuyCapacity ?? null,
        note: 'effectiveBuyCapacity is the server’s figure: the smaller of the API allowance and the spendable balance.',
      });
    }
    if (capacity !== null) {
      checks.push(`within the server’s effectiveBuyCapacity ${request.effectiveBuyCapacity ?? ''}`);
    }
  }

  return { permits: request.legs.length, basis: 'DELEGATED_AUTO', token: expected, checks };
}

/* ── Configuration ─────────────────────────────────────────────────────────── */

export interface PolicySources {
  /** The `policy` block from the config file, in whatever shape it was written. */
  readonly file: unknown;
  /** `WATERX_PREDICT_POLICY`. */
  readonly env: string | undefined;
  /** `--policy`. May only narrow. */
  readonly flag: string | undefined;
  /** The config file path, for error messages. */
  readonly where: string;
}

const SCOPE_KEYS = new Set([
  'accounts',
  'markets',
  'sides',
  'maxBuyAmount',
  'maxCumulativeBuyAmount',
  'maxSellShares',
  'maxSlippageBps',
  'maxLegs',
  'notAfter',
  'strategyIds',
]);

/**
 * A function DECLARATION, not a const arrow: TypeScript only narrows on a
 * never-returning call when the callee is declared this way, and the narrowing
 * is what lets the validators below treat a checked value as its real type
 * instead of casting it — a cast would survive the check being deleted.
 */
function invalid(message: string, details?: Record<string, unknown>): never {
  throw new CliError('CONFIG_INVALID', message, details);
}

function asMode(value: string, where: string): PolicyMode {
  if (!isPolicyMode(value)) {
    invalid(
      `\`${value}\` is not an execution policy in ${where}. The modes are ${POLICY_STRICTNESS.join(', ')}.`,
      { value },
    );
  }
  return value;
}

function stringList(value: unknown, key: string): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === 'string' && item.trim() !== '')
  ) {
    invalid(`\`policy.scope.${key}\` must be a non-empty array of non-empty strings.`, { key });
  }
  return value as readonly string[];
}

function boundedInteger(value: unknown, key: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    invalid(
      `\`policy.scope.${key}\` must be a whole number between ${String(min)} and ${String(max)}.`,
      { key },
    );
  }
  return value;
}

function decimalCeiling(value: unknown, key: string): string {
  if (typeof value !== 'string' || parseDecimal(value) === null || parseDecimal(value) === 0n) {
    invalid(
      `\`policy.scope.${key}\` must be a positive decimal STRING with at most 6 decimal places, e.g. "50". A JSON number cannot hold it exactly.`,
      { key },
    );
  }
  return value;
}

/**
 * Parse and fully validate a delegated-auto scope.
 *
 * Every ceiling that applies to an allowed side is mandatory. That is the whole
 * point of this function: a scope with a missing ceiling would authorize orders
 * without one, and "the operator meant to add it later" is not a bound.
 */
function parseDelegatedScope(raw: unknown, where: string): DelegatedScope {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    invalid(`\`policy.scope\` in ${where} must be a JSON object.`);
  }
  const scope = raw as Record<string, unknown>;
  for (const key of Object.keys(scope)) {
    if (!SCOPE_KEYS.has(key)) {
      invalid(
        `\`policy.scope.${key}\` in ${where} is not a known scope setting. Known: ${[...SCOPE_KEYS].join(', ')}.`,
        { key },
      );
    }
  }

  const sides = stringList(scope.sides, 'sides').map((side) => {
    if (side !== 'BUY' && side !== 'SELL') {
      invalid('`policy.scope.sides` may only contain "BUY" and "SELL".', { side });
    }
    return side;
  });
  const allowsBuy = sides.includes('BUY');
  const allowsSell = sides.includes('SELL');

  const notAfter = scope.notAfter;
  if (typeof notAfter !== 'string' || Number.isNaN(Date.parse(notAfter))) {
    invalid(
      '`policy.scope.notAfter` must be an ISO-8601 instant, e.g. "2026-09-01T00:00:00Z". A delegation without an end is not a scope.',
    );
  }

  return {
    accounts: stringList(scope.accounts, 'accounts'),
    markets: scope.markets === undefined ? undefined : stringList(scope.markets, 'markets'),
    sides,
    maxBuyAmount: allowsBuy ? decimalCeiling(scope.maxBuyAmount, 'maxBuyAmount') : undefined,
    maxCumulativeBuyAmount: allowsBuy
      ? decimalCeiling(scope.maxCumulativeBuyAmount, 'maxCumulativeBuyAmount')
      : undefined,
    maxSellShares: allowsSell ? decimalCeiling(scope.maxSellShares, 'maxSellShares') : undefined,
    maxSlippageBps: boundedInteger(scope.maxSlippageBps, 'maxSlippageBps', 0, 9_999),
    maxLegs: boundedInteger(scope.maxLegs, 'maxLegs', 1, 20),
    notAfter,
    strategyIds:
      scope.strategyIds === undefined ? undefined : stringList(scope.strategyIds, 'strategyIds'),
  };
}

/**
 * Resolve the policy in force for this invocation.
 *
 * `--policy` may only make the policy STRICTER. A flag that could widen it would
 * mean the configured policy was advice, and the whole file could be bypassed by
 * one extra argument on the command line — while `--policy read-only` on a
 * delegated-auto machine is a genuinely useful safety belt.
 */
export function parseExecutionPolicy(sources: PolicySources): ExecutionPolicy {
  let mode: PolicyMode = DEFAULT_POLICY.mode;
  let source: ExecutionPolicy['source'] = 'DEFAULT';
  let rawScope: unknown;

  if (sources.file !== undefined) {
    if (sources.file === null || typeof sources.file !== 'object' || Array.isArray(sources.file)) {
      invalid(`\`policy\` in ${sources.where} must be a JSON object.`);
    }
    const block = sources.file as Record<string, unknown>;
    for (const key of Object.keys(block)) {
      if (key !== 'mode' && key !== 'scope') {
        invalid(`\`policy.${key}\` in ${sources.where} is not a known setting. Known: mode, scope.`, {
          key,
        });
      }
    }
    rawScope = block.scope;
    if (block.mode !== undefined) {
      if (typeof block.mode !== 'string') invalid(`\`policy.mode\` in ${sources.where} must be a string.`);
      mode = asMode(block.mode as string, sources.where);
      source = 'CONFIG_FILE';
    }
  }

  if (sources.env !== undefined && sources.env.trim() !== '') {
    mode = asMode(sources.env.trim(), 'the environment');
    source = 'ENVIRONMENT';
  }

  // Validated whenever it is written, even when the mode in force does not use
  // it: a scope with a typo should fail on the machine that has the typo, not on
  // the first invocation that happens to need it.
  const scope = rawScope === undefined ? undefined : parseDelegatedScope(rawScope, sources.where);

  if (sources.flag !== undefined && sources.flag.trim() !== '') {
    const requested = asMode(sources.flag.trim(), 'the command line');
    if (POLICY_STRICTNESS.indexOf(requested) > POLICY_STRICTNESS.indexOf(mode)) {
      invalid(
        `\`--policy ${requested}\` is more permissive than the configured policy \`${mode}\`. The flag may only narrow the policy; widening it is a change to the configuration, made deliberately and in one place.`,
        { requested, configured: mode },
      );
    }
    mode = requested;
    source = 'FLAG';
  }

  if (mode === 'delegated-auto' && scope === undefined) {
    invalid(
      `The policy is delegated-auto and no \`policy.scope\` is configured in ${sources.where}. An auto-approving policy states its ceilings — accounts, sides, per-order and cumulative size, slippage, legs and an end instant — or it authorizes nothing.`,
    );
  }

  return { mode, scope: mode === 'delegated-auto' ? scope : undefined, source };
}

/* ── The signing gate ──────────────────────────────────────────────────────── */

/**
 * The one thing standing between a policy decision and a transaction signature.
 *
 * The signer holds this and consumes a permit for every transaction it signs, so
 * a code path that reaches the signer WITHOUT having been authorized cannot sign
 * — it does not merely skip a check, it runs out of permits. Permits are granted
 * per authorized order and are counted rather than named, because concurrent legs
 * of one batch are all individually authorized anyway: N approved orders permit
 * at most N signatures.
 *
 * Under read-only no permit can ever be granted, and the signer refuses before
 * this is even consulted.
 */
export class SigningGate {
  #permits = 0;
  #granted = 0;
  #used = 0;

  constructor(private readonly mode: PolicyMode) {}

  /** Called only by a command holding a `WriteAuthorization`. */
  grant(authorization: WriteAuthorization): void {
    if (this.mode === 'read-only') {
      throw new CliError(
        'INTERNAL',
        'A signing permit was requested under the read-only policy. Refused.',
      );
    }
    this.#permits += authorization.permits;
    this.#granted += authorization.permits;
  }

  /** Called by the signer, immediately before it spawns anything. */
  consume(): void {
    if (this.#permits <= 0) {
      throw new CliError(
        'POLICY_DENIED',
        'A transaction signature was requested with no approved order to spend it on. The signer was not started and nothing was sent. This is a refusal by the signing gate, not by the exchange.',
        { policy: this.mode, granted: this.#granted, used: this.#used },
      );
    }
    this.#permits -= 1;
    this.#used += 1;
  }

  /** For the result envelope: how many signatures the policy actually permitted. */
  get stats(): { granted: number; used: number; unused: number } {
    return { granted: this.#granted, used: this.#used, unused: this.#permits };
  }
}
