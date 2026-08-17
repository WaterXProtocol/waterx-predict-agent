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
import type { ExitCode } from './exit-codes.ts';
import type { SigningGate } from './policy.ts';
import type { RunnerSession } from './runner-ipc.ts';

export interface CommandContext {
  /** Already validated against the command's schema. */
  readonly input: Readonly<Record<string, unknown>>;
  readonly config: ResolvedConfig;
  /**
   * The `--approve <token>` value, or undefined. It is a global flag rather than
   * a schema field because it is not part of the intent: it is the caller's
   * assent to an intent they already saw, and putting it in the input would let
   * one generated JSON document both propose and approve a trade.
   */
  readonly approval: string | undefined;
  /**
   * Permits the signer spends. A command that authorizes a write grants here;
   * the signer consumes before it spawns. A command that forgets to grant cannot
   * sign, which is the point.
   */
  readonly gate: SigningGate;
  /**
   * An authenticated client. Rejects with a CliError naming exactly what is
   * missing, or with the server's own error when the challenge is refused.
   */
  client(): Promise<PredictAgentClient>;
  /**
   * A handshaken session with the local Runner, for the strategy family.
   *
   * Separate from `client()` and not a fallback for it: this is a daemon on this
   * machine, authenticated by a token in a private directory, and a command that
   * needs one is useless without it. Memoized the same way and closed by the
   * dispatcher, so an invocation opens at most one socket and never leaves it
   * open. Rejects with a `RunnerRefusal` naming the runtime directory when no
   * Runner is listening — before anything is dialled.
   */
  runner(): Promise<RunnerSession>;
  /**
   * A fresh deadline for one call.
   *
   * `atLeastMs` widens it for a command that legitimately waits longer than the
   * invocation timeout — a terminal wait, whose bound is its own input. It can
   * only ever widen: a command cannot shorten the deadline the caller set.
   */
  signal(atLeastMs?: number): AbortSignal;
  /**
   * Ask for a non-zero exit code on an otherwise SUCCESSFUL result.
   *
   * For outcomes that are real answers and still must not read as "done": a
   * terminal wait that expired, or a batch with a failed leg. The envelope stays
   * `ok: true` and carries the facts, while the exit code keeps a shell script
   * from treating an unknown outcome as a completed one. AMBIGUOUS outranks any
   * other class, because an unknown outcome must never be retried as if it were
   * a known refusal; otherwise the first class asked for is the one reported.
   */
  exitAs(code: ExitCode): void;
  /** stderr. Redacted and truncated by the writer. Never part of the result. */
  diagnostic(text: string): void;
  readonly nodeVersion: string;
  now(): Date;
}

export type CommandHandler = (context: CommandContext) => Promise<unknown>;
