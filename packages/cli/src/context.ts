/**
 * What a command handler is given.
 *
 * The client is an async function rather than a value for two reasons. It is
 * built lazily, because `describe` and `command-schema` must answer on an
 * unconfigured machine and eagerly constructing a client would make discovery
 * the first thing to fail. And opening it means opening a SESSION: the SDK
 * refuses an authenticated request outright rather than authenticating behind
 * the caller's back, so someone has to sign the login challenge first, and that
 * is a signing operation the CLI should be seen to perform.
 *
 * The result is memoized per invocation, so two concurrent reads share one
 * session rather than racing to mint two.
 */
import type { PredictAgentClient } from '@waterx/predict-agent-sdk';

import type { ResolvedConfig } from './config.ts';

export interface CommandContext {
  /** Already validated against the command's schema. */
  readonly input: Readonly<Record<string, unknown>>;
  readonly config: ResolvedConfig;
  /**
   * An authenticated client. Rejects with a CliError naming exactly what is
   * missing, or with the server's own error when the challenge is refused.
   */
  client(): Promise<PredictAgentClient>;
  /** A fresh deadline for one call. */
  signal(): AbortSignal;
  /** stderr. Redacted and truncated by the writer. Never part of the result. */
  diagnostic(text: string): void;
  readonly nodeVersion: string;
  now(): Date;
}

export type CommandHandler = (context: CommandContext) => Promise<unknown>;
