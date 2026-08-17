/**
 * Exit codes, and the mapping from a symbolic error code to one.
 *
 * A shell script that cannot parse JSON still has to be able to tell a
 * misconfiguration from a rate limit from an ambiguous outcome, so the code
 * carries the class of failure and the envelope carries the detail. They are
 * stable: an existing code never changes meaning, and a new class takes a new
 * number.
 *
 * The important one is AMBIGUOUS. It means the runtime does not know whether the
 * intent took effect. Retrying on it without reconciling is how an agent places
 * the same order twice, which is why it is not folded into REJECTED.
 */
import type { CliErrorCode } from './errors.ts';

export const EXIT_CODES = {
  /** The command ran and the envelope reports `ok: true`. */
  OK: 0,
  /** The invocation was malformed. Nothing was attempted. */
  USAGE: 1,
  /** The input failed the command schema. Nothing was sent. */
  INVALID_INPUT: 2,
  /** Configuration is missing, unusable, or holds a credential. */
  CONFIG: 3,
  /** Authentication failed, or the signer could not produce a signature. */
  AUTH: 4,
  /** A limit or a delegation refused the action. Retrying will not help. */
  POLICY: 5,
  /** The named market, position or execution does not exist. */
  NOT_FOUND: 6,
  /** Temporarily or structurally unavailable: closed market, no quote, no endpoint. */
  UNAVAILABLE: 7,
  /** Rate limited. Back off and retry. */
  RATE_LIMITED: 8,
  /** The request did not complete. No response was seen. */
  TRANSPORT: 9,
  /** The server refused, definitively. */
  REJECTED: 10,
  /**
   * The outcome is unknown. Reconcile with `order get` before deciding anything;
   * never resubmit under a fresh idempotency key.
   */
  AMBIGUOUS: 11,
  /** A bug in this CLI. */
  INTERNAL: 70,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

const BY_CLI_CODE: Readonly<Record<CliErrorCode, ExitCode>> = {
  USAGE: EXIT_CODES.USAGE,
  UNKNOWN_COMMAND: EXIT_CODES.USAGE,
  INVALID_INPUT: EXIT_CODES.INVALID_INPUT,
  NOT_CONFIGURED: EXIT_CODES.CONFIG,
  CONFIG_INVALID: EXIT_CODES.CONFIG,
  CONFIG_CONTAINS_SECRET: EXIT_CODES.CONFIG,
  SIGNER_UNAVAILABLE: EXIT_CODES.CONFIG,
  SIGNER_FAILED: EXIT_CODES.AUTH,
  POLICY_DENIED: EXIT_CODES.POLICY,
  CAPABILITY_UNAVAILABLE: EXIT_CODES.UNAVAILABLE,
  COMMAND_NOT_IMPLEMENTED: EXIT_CODES.UNAVAILABLE,
  TIMEOUT: EXIT_CODES.TRANSPORT,
  INTERNAL: EXIT_CODES.INTERNAL,
};

/**
 * Server codes, from the wire contract's `PredictAgentErrorCode`.
 *
 * Anything unlisted falls to REJECTED rather than to INTERNAL: a code this build
 * has not seen is still the server having refused, and calling it a CLI bug
 * would send a caller looking in the wrong place.
 */
const BY_SERVER_CODE: Readonly<Record<string, ExitCode>> = {
  INVALID_REQUEST: EXIT_CODES.INVALID_INPUT,
  UNAUTHENTICATED: EXIT_CODES.AUTH,
  SIGNATURE_INVALID: EXIT_CODES.AUTH,
  SIGNATURE_EXPIRED: EXIT_CODES.AUTH,
  DELEGATION_MISSING: EXIT_CODES.POLICY,
  DELEGATION_EXPIRED: EXIT_CODES.POLICY,
  DELEGATION_INSUFFICIENT: EXIT_CODES.POLICY,
  INSUFFICIENT_ALLOWANCE: EXIT_CODES.POLICY,
  INSUFFICIENT_BALANCE: EXIT_CODES.POLICY,
  RISK_LIMIT_EXCEEDED: EXIT_CODES.POLICY,
  POSITION_NOT_FOUND: EXIT_CODES.NOT_FOUND,
  MARKET_CLOSED: EXIT_CODES.UNAVAILABLE,
  QUOTE_UNAVAILABLE: EXIT_CODES.UNAVAILABLE,
  QUOTE_EXPIRED: EXIT_CODES.UNAVAILABLE,
  SPONSOR_UNAVAILABLE: EXIT_CODES.UNAVAILABLE,
  RATE_LIMITED: EXIT_CODES.RATE_LIMITED,
  // Both mean "the outcome is not established". See AMBIGUOUS above.
  EXECUTION_TIMEOUT: EXIT_CODES.AMBIGUOUS,
  RECONCILIATION_REQUIRED: EXIT_CODES.AMBIGUOUS,
};

/**
 * Runner codes: `StrategyErrorCode`, `JobStoreErrorCode`, `RunnerIpcErrorCode`,
 * plus the two this client raises for itself (`RUNNER_UNREACHABLE`,
 * `CREATE_OUTCOME_UNKNOWN`).
 *
 * This table is a LOOKUP, not a second opinion. Every rule about expiry, sizing
 * and cancellation is decided by the Runner and named in its code; all that
 * happens here is choosing which exit class the operator's shell script sees.
 * Adding a local judgement — deciding that a `SIZE_AMBIGUOUS` is really a usage
 * error, say — would be the CLI re-deciding a money-shaped rule from a distance.
 *
 * Two groupings are worth their own sentence:
 *
 *   - The `POSITION_*` reads that could not be COMPLETED are UNAVAILABLE, not
 *     NOT_FOUND. "The walk did not prove the position is absent" and "the
 *     position does not exist" are different facts, and only the second one
 *     means the caller typed the wrong id.
 *   - `NOT_IMPLEMENTED` is UNAVAILABLE rather than REJECTED, matching what a
 *     named-but-unbuilt capability returns everywhere else in this CLI.
 *
 * Anything unlisted falls to REJECTED: an unknown code is still the Runner
 * having refused, and calling it a CLI bug would send the operator to the wrong
 * place.
 */
const BY_RUNNER_CODE: Readonly<Record<string, ExitCode>> = {
  /* Shape, sizing, expiry and trigger: the request has to change. */
  INVALID_INPUT: EXIT_CODES.INVALID_INPUT,
  MALFORMED_FRAME: EXIT_CODES.INVALID_INPUT,
  EXPIRY_REQUIRED: EXIT_CODES.INVALID_INPUT,
  EXPIRY_INVALID: EXIT_CODES.INVALID_INPUT,
  EXPIRY_IN_PAST: EXIT_CODES.INVALID_INPUT,
  EXPIRY_TOO_FAR: EXIT_CODES.INVALID_INPUT,
  NO_LEGS: EXIT_CODES.INVALID_INPUT,
  FIELD_REQUIRED: EXIT_CODES.INVALID_INPUT,
  FIELD_INVALID: EXIT_CODES.INVALID_INPUT,
  SIZE_MISSING: EXIT_CODES.INVALID_INPUT,
  SIZE_AMBIGUOUS: EXIT_CODES.INVALID_INPUT,
  SIZE_INVALID: EXIT_CODES.INVALID_INPUT,
  FRACTION_INVALID: EXIT_CODES.INVALID_INPUT,
  FRACTION_RESOLVES_TO_ZERO: EXIT_CODES.INVALID_INPUT,
  POSITION_REQUIRED: EXIT_CODES.INVALID_INPUT,
  POSITION_NOT_APPLICABLE: EXIT_CODES.INVALID_INPUT,
  POSITION_MISMATCH: EXIT_CODES.INVALID_INPUT,
  TRIGGER_INVALID: EXIT_CODES.INVALID_INPUT,
  TRIGGER_INCOMPLETE: EXIT_CODES.INVALID_INPUT,
  TRIGGER_AMBIGUOUS: EXIT_CODES.INVALID_INPUT,

  /* The mandate on that host refused. Retrying changes nothing. */
  POLICY_FORBIDS_WRITE: EXIT_CODES.POLICY,
  POLICY_REQUIRES_DELEGATION: EXIT_CODES.POLICY,
  POLICY_MODE_UNRECOGNIZED: EXIT_CODES.POLICY,

  /* Named, and genuinely absent. */
  UNKNOWN_JOB: EXIT_CODES.NOT_FOUND,
  UNKNOWN_LEG: EXIT_CODES.NOT_FOUND,
  POSITION_UNKNOWN: EXIT_CODES.NOT_FOUND,

  /* Reachable, and cannot answer right now. */
  POSITION_READ_UNAVAILABLE: EXIT_CODES.UNAVAILABLE,
  POSITION_LOOKUP_INCONCLUSIVE: EXIT_CODES.UNAVAILABLE,
  POSITION_SHARES_UNKNOWN: EXIT_CODES.UNAVAILABLE,
  NOT_IMPLEMENTED: EXIT_CODES.UNAVAILABLE,
  UNKNOWN_COMMAND: EXIT_CODES.UNAVAILABLE,
  PROTOCOL_VERSION: EXIT_CODES.UNAVAILABLE,
  RUNNER_UNREACHABLE: EXIT_CODES.UNAVAILABLE,
  UNSUPPORTED_PLATFORM: EXIT_CODES.UNAVAILABLE,

  UNAUTHENTICATED: EXIT_CODES.AUTH,

  /* Local, and fixable with a chmod or a shorter path. */
  INSECURE_RUNTIME_DIR: EXIT_CODES.CONFIG,
  SOCKET_PATH_TOO_LONG: EXIT_CODES.CONFIG,

  /* No answer was seen. On a read that is a failure; see below for a create. */
  TIMEOUT: EXIT_CODES.TRANSPORT,
  CONNECTION_CLOSED: EXIT_CODES.TRANSPORT,
  FRAME_TOO_LARGE: EXIT_CODES.TRANSPORT,
  ADDRESS_IN_USE: EXIT_CODES.TRANSPORT,

  /**
   * A create whose answer never arrived. The Runner does not deduplicate a
   * create, so a retry arms a SECOND strategy — this is the one Runner outcome
   * that must never be retried blind, which is exactly what AMBIGUOUS means.
   */
  CREATE_OUTCOME_UNKNOWN: EXIT_CODES.AMBIGUOUS,

  INTERNAL: EXIT_CODES.INTERNAL,
};

export const exitCodeForCliError = (code: CliErrorCode): ExitCode => BY_CLI_CODE[code];

export const exitCodeForRunnerError = (code: string): ExitCode =>
  BY_RUNNER_CODE[code] ?? EXIT_CODES.REJECTED;

export const exitCodeForServerError = (code: string): ExitCode =>
  BY_SERVER_CODE[code] ?? EXIT_CODES.REJECTED;

export interface ExitCodeDescription {
  readonly name: string;
  readonly code: ExitCode;
  readonly meaning: string;
}

/** Published verbatim by `describe`, so a host does not have to guess. */
export const EXIT_CODE_TABLE: readonly ExitCodeDescription[] = [
  { name: 'OK', code: EXIT_CODES.OK, meaning: 'The command succeeded. The envelope has `ok: true`.' },
  { name: 'USAGE', code: EXIT_CODES.USAGE, meaning: 'Malformed invocation. Nothing was attempted.' },
  {
    name: 'INVALID_INPUT',
    code: EXIT_CODES.INVALID_INPUT,
    meaning: 'The input failed the command schema. Nothing was sent.',
  },
  {
    name: 'CONFIG',
    code: EXIT_CODES.CONFIG,
    meaning: 'Configuration is missing, unusable, or contains a credential.',
  },
  {
    name: 'AUTH',
    code: EXIT_CODES.AUTH,
    meaning: 'Authentication failed, or the signer produced no signature.',
  },
  {
    name: 'POLICY',
    code: EXIT_CODES.POLICY,
    meaning: 'A limit, delegation or local policy refused. Retrying will not help.',
  },
  { name: 'NOT_FOUND', code: EXIT_CODES.NOT_FOUND, meaning: 'The named entity does not exist.' },
  {
    name: 'UNAVAILABLE',
    code: EXIT_CODES.UNAVAILABLE,
    meaning:
      'No quote, market closed, no Runner listening, or the capability has no endpoint behind it.',
  },
  { name: 'RATE_LIMITED', code: EXIT_CODES.RATE_LIMITED, meaning: 'Back off and retry.' },
  {
    name: 'TRANSPORT',
    code: EXIT_CODES.TRANSPORT,
    meaning: 'The request did not complete. No response was seen.',
  },
  { name: 'REJECTED', code: EXIT_CODES.REJECTED, meaning: 'The server refused, definitively.' },
  {
    name: 'AMBIGUOUS',
    code: EXIT_CODES.AMBIGUOUS,
    meaning:
      'The outcome is unknown. Reconcile with `order get`, or `strategy list` after a create; never resubmit under a fresh idempotency key.',
  },
  { name: 'INTERNAL', code: EXIT_CODES.INTERNAL, meaning: 'A bug in this CLI.' },
];
