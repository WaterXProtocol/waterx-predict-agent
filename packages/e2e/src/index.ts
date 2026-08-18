/**
 * The harness as a library, for the tests in this package and for anything that
 * wants to run the plan against its own invoker.
 */
export {
  GAP_IDS,
  PROVISIONING_GAPS,
  getGap,
  type GapId,
  type GapState,
  type GapStatus,
  type ProvisioningGap,
  type Supplier,
} from './gaps.ts';
export {
  extractInvocations,
  lintInvocation,
  resolveCliPath,
  type LintViolation,
} from './lint.ts';
export {
  locateCliBinary,
  processInvoker,
  type BinaryLocation,
  type CliEnvelope,
  type CliInvoker,
  type CliRun,
  type InvokerOptions,
  type Transport,
} from './cli-process.ts';
export {
  preflight,
  readRuntimeFacts,
  unsatisfied,
  type Preflight,
  type RuntimeFacts,
} from './preflight.ts';
export {
  HARNESS_EXIT,
  evidenceOf,
  exitCodeFor,
  summarize,
  type CapabilityPermission,
  type E2eReport,
  type Evidence,
  type NotRunReason,
  type Outcome,
  type StepDescription,
  type StepResult,
  type WriteCapability,
} from './report.ts';
export { shellRunner, type ExternalResult, type ExternalRunner } from './external.ts';
export {
  DEFAULT_OPTIONS,
  STEPS,
  emptyLedger,
  type HarnessOptions,
  type Ledger,
  type Step,
  type StepContext,
  type Verdict,
} from './steps.ts';
export {
  HARNESS_NAME,
  NON_PRODUCTION_ENVIRONMENTS,
  WRITE_CAPABILITIES,
  runE2e,
  runWith,
  writePermission,
  writePermissions,
  type RunOptions,
} from './run.ts';
export { render } from './render.ts';
export { USAGE, parseOptions } from './options.ts';
