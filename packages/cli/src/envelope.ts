/**
 * The one document this CLI writes to stdout.
 *
 * Shape is identical for success and failure so a caller can parse before it
 * branches (plan §6.3). `ok` is the branch; everything else is stable.
 *
 * `requestId` is generated LOCALLY and correlates this invocation's stdout with
 * its stderr diagnostics. It is deliberately not called a trace id: this API
 * version returns no server trace identifier, and echoing a local UUID under a
 * name that implies server-side correlation would send an operator to a log
 * search that can never match.
 */
import type { PredictAgentErrorCode } from '@waterx/predict-agent-sdk';

export const ENVELOPE_SCHEMA_VERSION = '1';

/**
 * Which namespace `code` belongs to.
 *
 * `CLI` — this runtime refused; the code is a `CliErrorCode`.
 * `SERVER` — the exchange refused; the code is a `PredictAgentErrorCode`.
 * `RUNNER` — the local Runner refused, or could not be reached; the code is one
 * of its own symbols. Distinct from both because nothing reached the exchange
 * and the fix is almost always local: start the daemon, configure it, `chmod`
 * its directory.
 * `TRANSPORT` — no response was seen, so nobody refused anything and the outcome
 * of a write would be unknown.
 */
export type EnvelopeErrorSource = 'CLI' | 'SERVER' | 'RUNNER' | 'TRANSPORT';

export interface EnvelopeError {
  readonly code: string | PredictAgentErrorCode;
  readonly message: string;
  /**
   * Server-owned when `source` is `SERVER`. This CLI never re-derives it from
   * the code — a client-side retry table and the server's answer disagreeing is
   * how a definitive refusal gets retried.
   */
  readonly retryable: boolean;
  readonly source: EnvelopeErrorSource;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface EnvelopeMeta {
  /** Values the CLI supplied that the caller did not, so nothing is silent. */
  readonly defaultsApplied?: Readonly<Record<string, unknown>>;
  readonly warnings?: readonly string[];
}

interface EnvelopeBase {
  readonly schemaVersion: typeof ENVELOPE_SCHEMA_VERSION;
  /** The contract command name, or the raw invocation when it resolved to none. */
  readonly command: string;
  readonly requestId: string;
  readonly meta?: EnvelopeMeta;
}

export interface SuccessEnvelope extends EnvelopeBase {
  readonly ok: true;
  readonly data: unknown;
}

export interface ErrorEnvelope extends EnvelopeBase {
  readonly ok: false;
  readonly error: EnvelopeError;
}

export type Envelope = SuccessEnvelope | ErrorEnvelope;

const withMeta = (meta: EnvelopeMeta | undefined): { meta?: EnvelopeMeta } => {
  if (meta === undefined) return {};
  const populated =
    (meta.defaultsApplied !== undefined && Object.keys(meta.defaultsApplied).length > 0) ||
    (meta.warnings !== undefined && meta.warnings.length > 0);
  return populated ? { meta } : {};
};

export function successEnvelope(
  command: string,
  requestId: string,
  data: unknown,
  meta?: EnvelopeMeta,
): SuccessEnvelope {
  return {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    ok: true,
    command,
    requestId,
    data,
    ...withMeta(meta),
  };
}

export function errorEnvelope(
  command: string,
  requestId: string,
  error: EnvelopeError,
  meta?: EnvelopeMeta,
): ErrorEnvelope {
  return {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    ok: false,
    command,
    requestId,
    error,
    ...withMeta(meta),
  };
}
