/**
 * The CLI's own error namespace.
 *
 * Kept deliberately separate from the server's `PredictAgentErrorCode`: an agent
 * branching on `error.code` has to be able to tell "this runtime refused" from
 * "the exchange refused". The envelope's `error.source` is what says which
 * namespace a code belongs to, and these codes never overlap with the server's.
 */

export type CliErrorCode =
  /** The invocation itself was malformed — unknown flag, missing subcommand. */
  | 'USAGE'
  /** A command name that is not in this build's contract. */
  | 'UNKNOWN_COMMAND'
  /** Well-formed invocation, but the input failed the command schema. */
  | 'INVALID_INPUT'
  /** A required setting is absent. Nothing was attempted. */
  | 'NOT_CONFIGURED'
  /** A setting is present but unusable. */
  | 'CONFIG_INVALID'
  /**
   * The config file holds something that looks like a credential. Refused before
   * it can be read into the process, and reported by key path, never by value.
   */
  | 'CONFIG_CONTAINS_SECRET'
  /** No signer is configured, so nothing can authenticate. */
  | 'SIGNER_UNAVAILABLE'
  /** The signer was invoked and did not return a usable signature. */
  | 'SIGNER_FAILED'
  /** Local policy refused. The read-only policy refusing a transaction signature. */
  | 'POLICY_DENIED'
  /**
   * The capability exists in the plan and has no server endpoint behind it. A
   * refusal, not a failure — and never a client-side approximation.
   */
  | 'CAPABILITY_UNAVAILABLE'
  /** Named in the plan, not built in this version. */
  | 'COMMAND_NOT_IMPLEMENTED'
  /** The local deadline elapsed. Says nothing about what the server did. */
  | 'TIMEOUT'
  /** A bug in this CLI. Anything unrecognised lands here rather than being guessed at. */
  | 'INTERNAL';

/**
 * The same list at runtime, so a code coming back from somewhere untyped — a
 * doctor check, a serialized report — can be told apart from a server code
 * rather than assumed to be one.
 */
export const CLI_ERROR_CODES: ReadonlySet<string> = new Set<CliErrorCode>([
  'USAGE',
  'UNKNOWN_COMMAND',
  'INVALID_INPUT',
  'NOT_CONFIGURED',
  'CONFIG_INVALID',
  'CONFIG_CONTAINS_SECRET',
  'SIGNER_UNAVAILABLE',
  'SIGNER_FAILED',
  'POLICY_DENIED',
  'CAPABILITY_UNAVAILABLE',
  'COMMAND_NOT_IMPLEMENTED',
  'TIMEOUT',
  'INTERNAL',
]);

export const isCliErrorCode = (code: string): code is CliErrorCode => CLI_ERROR_CODES.has(code);

export class CliError extends Error {
  readonly code: CliErrorCode;
  /**
   * Structured context for the envelope. MUST NOT carry a credential, a
   * signature, transaction bytes, or a subprocess's raw output — those go to
   * stderr, redacted, if anywhere.
   */
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: CliErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.details = details;
  }
}

export const isCliError = (error: unknown): error is CliError => error instanceof CliError;
