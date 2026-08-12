/**
 * The only module in this package permitted to touch stdout.
 *
 * stdout carries exactly one JSON document per invocation and nothing else — no
 * progress, no warnings, no banner. A `console.log` anywhere else would corrupt
 * every caller's parse, and a caller cannot defend against that, so a workspace
 * test enforces the ban structurally rather than by review.
 *
 * Diagnostics go to stderr. Both streams pass through the redactor.
 */
import type { Envelope } from './envelope.ts';
import type { Redactor } from './redact.ts';

export interface OutputStreams {
  /** stdout. Called exactly once per invocation. */
  write(text: string): void;
  /** stderr. Free-form, human-oriented, never parsed. */
  writeError(text: string): void;
}

export function createNodeStreams(): OutputStreams {
  return {
    write: (text) => {
      process.stdout.write(text);
    },
    writeError: (text) => {
      process.stderr.write(text);
    },
  };
}

/**
 * Serialize, redact, emit.
 *
 * Redaction runs over the finished string rather than over the object, so a
 * secret that reached the envelope through a nested error detail or an SDK
 * message is caught by the same pass.
 */
export function emitEnvelope(
  streams: OutputStreams,
  envelope: Envelope,
  redactor: Redactor,
): void {
  streams.write(`${redactor.redact(JSON.stringify(envelope, null, 2))}\n`);
}

/** Truncated so a runaway subprocess cannot flood an operator's terminal. */
const MAX_DIAGNOSTIC_LENGTH = 2000;

export function writeDiagnostic(
  streams: OutputStreams,
  text: string,
  redactor: Redactor,
): void {
  const redacted = redactor.redact(text);
  const clipped =
    redacted.length > MAX_DIAGNOSTIC_LENGTH
      ? `${redacted.slice(0, MAX_DIAGNOSTIC_LENGTH)}… [truncated]`
      : redacted;
  streams.writeError(`${clipped}\n`);
}
