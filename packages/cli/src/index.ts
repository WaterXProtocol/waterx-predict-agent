/**
 * The CLI as a library.
 *
 * The package is private and ships one binary, so this exists for two callers:
 * this package's own tests, and the thin adapters planned on top of the same
 * command core (MCP and friends, ADR-0001 §3). An adapter that imported the
 * handlers directly would be a second implementation of the same intent; it
 * should call `run` and read the envelope, exactly as a shell would.
 */
export { run, createNodeIo, type CliIo } from './run.ts';
export {
  ENVELOPE_SCHEMA_VERSION,
  errorEnvelope,
  successEnvelope,
  type Envelope,
  type EnvelopeError,
  type EnvelopeErrorSource,
  type EnvelopeMeta,
  type ErrorEnvelope,
  type SuccessEnvelope,
} from './envelope.ts';
export {
  EXIT_CODES,
  EXIT_CODE_TABLE,
  exitCodeForCliError,
  exitCodeForServerError,
  type ExitCode,
} from './exit-codes.ts';
export {
  CLI_ERROR_CODES,
  CliError,
  isCliError,
  isCliErrorCode,
  type CliErrorCode,
} from './errors.ts';
export {
  CAPABILITIES,
  getCapability,
  listRefusals,
  type Capability,
  type CapabilityStatus,
} from './capabilities.ts';
export { createNodeStreams, type OutputStreams } from './output.ts';
/**
 * The tokenizer, exported for one reason: anything that CHECKS an invocation —
 * an example linter, a docs test — has to split argv the way this CLI does. A
 * second tokenizer that disagreed would bless a command the CLI then rejects.
 */
export { GLOBAL_FLAGS, parseArgv, type ParsedArgv } from './parse.ts';
export { loadConfig, type ResolvedConfig } from './config.ts';
export { describeSigner, type SignerDescription, type SignerRunner } from './signer.ts';
export { CLI_NAME, CLI_VERSION, API_VERSION } from './version.ts';
