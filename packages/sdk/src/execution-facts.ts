/**
 * What an execution read actually establishes, in the shape a strategy needs to
 * act on it.
 *
 * The failure this exists to prevent: treating `SUBMITTED` as a trade. A submit
 * is an on-chain request that a keeper fills asynchronously, so the amount, the
 * share count, the fee and the remaining allowance are unknown until a terminal
 * read reports them. Every field below is derived from the server's answer only —
 * nothing here estimates, rounds, or substitutes zero for an unknown.
 */
import type {
  DecimalString,
  PredictExecutionFill,
  PredictExecutionStatus,
  PredictTerminalExecutionStatus,
  SubmitExecutionResponseBody,
} from './contract.ts';

/** Statuses from which nothing further will happen without a new request. */
const TERMINAL: ReadonlySet<PredictExecutionStatus> = new Set([
  'FILLED',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
]);

export function isTerminalExecutionStatus(
  status: PredictExecutionStatus,
): status is PredictTerminalExecutionStatus {
  return TERMINAL.has(status);
}

/**
 * Whether a fee figure exists, and why when it does not.
 *
 * A discriminated union rather than `actualFee: string | null`, because the two
 * absences are different facts and a strategy computing net PnL must not read
 * either as zero:
 *
 * `NO_FILL_OBSERVED` — nothing has settled (yet, or ever, for a rejection).
 * `EMBEDDED_IN_PRICE` — it settled and the server reports no separate fee: the
 * broker's published price is already fee-adjusted, so the cost is inside
 * `filledAmount` rather than missing from it.
 */
export type ExecutionFeeFacts =
  | { available: true; actualFee: DecimalString }
  | { available: false; reason: 'NO_FILL_OBSERVED' | 'EMBEDDED_IN_PRICE' };

/** One execution's state and, once settled, what it actually cost. */
export interface ExecutionOutcome {
  executionId: string;
  status: PredictExecutionStatus;
  /** True when `status` can no longer change without a new request. */
  terminal: boolean;
  /**
   * True when the SDK stopped waiting first.
   *
   * NOT a failure and NOT a cancellation: the order is on-chain and a keeper may
   * still fill it. Re-read with `waitForExecution(executionId)` or
   * `getExecution(executionId)`; never resubmit under a fresh idempotency key.
   */
  timedOut: boolean;
  /** The EXECUTED on-chain digest, when the server has one. */
  transactionDigest: string | undefined;
  /**
   * Authoritative settlement facts. Undefined until the chain fill is observed —
   * an order that is merely SUBMITTED has none, and zeroes would book a trade
   * that has not happened.
   */
  fill: PredictExecutionFill | undefined;
  fee: ExecutionFeeFacts;
  /**
   * Spendable API allowance after this execution settled.
   *
   * Undefined off a non-terminal read (the reservation is held but not yet
   * spent, so any figure would be neither the before nor the after) and also when
   * this agent has no risk profile at all. Undefined is not zero.
   */
  remainingAllowance: DecimalString | undefined;
}

export function toFeeFacts(fill: PredictExecutionFill | undefined): ExecutionFeeFacts {
  if (fill === undefined) return { available: false, reason: 'NO_FILL_OBSERVED' };
  if (fill.actualFee === null) return { available: false, reason: 'EMBEDDED_IN_PRICE' };
  return { available: true, actualFee: fill.actualFee };
}

/**
 * Read → facts. `timedOut` is the caller's knowledge, not the server's: the same
 * PENDING_FILL body means "still working" mid-wait and "we stopped watching"
 * once the deadline passed.
 */
export function toExecutionOutcome(
  read: SubmitExecutionResponseBody,
  timedOut: boolean,
): ExecutionOutcome {
  return {
    executionId: read.executionId,
    status: read.status,
    terminal: isTerminalExecutionStatus(read.status),
    timedOut,
    transactionDigest: read.transactionDigest,
    fill: read.fill,
    fee: toFeeFacts(read.fill),
    remainingAllowance: read.remainingAllowance,
  };
}
