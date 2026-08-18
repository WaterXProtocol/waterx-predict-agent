/**
 * The report, shaped so that the dishonest answers cannot be written down.
 *
 * Three rules, enforced by the types and by `summarize` rather than by whoever
 * writes the summary paragraph:
 *
 *  1. A step that did not run is `NOT_RUN` and carries NO evidence field. There
 *     is no way to construct a passing step without a run behind it.
 *  2. Evidence records the transport it came from. If anything in the report was
 *     obtained from a `STUB`, the whole report is `INVALID` — a mock standing in
 *     for a live path does not produce a green E2E, it produces a void one.
 *  3. Overall `PASSED` requires EVERY step to have passed. A run with steps left
 *     unrun is `PARTIAL`, and one where nothing ran is `NOT_RUN`.
 */
import type { GapId, GapState } from './gaps.ts';

export interface Evidence {
  /** `PROCESS` is the only honest value. See rule 2. */
  readonly transport: 'PROCESS' | 'STUB';
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly ok: boolean;
  /** The contract command the CLI said it ran. */
  readonly command: string;
  readonly requestId: string;
  readonly durationMs: number;
}

export type NotRunReason =
  /** A required provisioning gap is not satisfied. */
  | 'NOT_PROVISIONED'
  /** The CLI artifact under test does not exist yet. */
  | 'CLI_NOT_BUILT'
  /** An earlier step this one reads from did not pass. */
  | 'PREREQUISITE_NOT_MET'
  /** A write was deliberately withheld. Never a failure; always explained. */
  | 'WRITE_WITHHELD'
  /** There was nothing for this step to act on. Not a skip, and not a failure. */
  | 'NOTHING_TO_DO';

/**
 * The three fund-moving decisions in this plan, opted into separately.
 *
 * They are not degrees of the same permission: `order` is one order placed now,
 * `multi-leg` is several at once, and `strategy` leaves a job on the Runner that
 * can trade after this process has exited. An operator who agreed to the first
 * has not agreed to the third, and one flag would collapse exactly that.
 */
export type WriteCapability = 'order' | 'multi-leg' | 'strategy';

export interface CapabilityPermission {
  readonly capability: WriteCapability;
  readonly permitted: boolean;
  /** Null exactly when permitted. Otherwise the reason, in full. */
  readonly withheldBecause: string | null;
}

export interface StepDescription {
  readonly id: string;
  readonly title: string;
  /** What a pass would actually establish. */
  readonly proves: string;
  /** Which opt-in the step needed, or null for one that moves no funds. */
  readonly writes: WriteCapability | null;
}

export type StepResult =
  | { readonly step: StepDescription; readonly status: 'PASSED'; readonly evidence: Evidence }
  | {
      readonly step: StepDescription;
      readonly status: 'FAILED';
      readonly evidence: Evidence;
      readonly why: string;
    }
  | {
      readonly step: StepDescription;
      readonly status: 'NOT_RUN';
      readonly reason: NotRunReason;
      /** The named gaps responsible, when the reason is a provisioning one. */
      readonly missing: readonly GapId[];
      readonly detail: string;
    };

export type Outcome = 'PASSED' | 'PARTIAL' | 'FAILED' | 'NOT_RUN' | 'INVALID';

export interface E2eReport {
  readonly harness: string;
  readonly outcome: Outcome;
  /** One sentence that is safe to quote out of context. */
  readonly headline: string;
  readonly environment: {
    readonly baseUrl: string | null;
    readonly label: string | null;
    readonly configFile: string | null;
    /**
     * One entry per capability, permitted or not, and always all of them. A
     * report that listed only what was permitted would make "we did not ask" and
     * "we were refused" look the same.
     */
    readonly writes: readonly CapabilityPermission[];
  };
  readonly provisioning: readonly GapState[];
  readonly steps: readonly StepResult[];
  readonly counts: {
    readonly passed: number;
    readonly failed: number;
    readonly notRun: number;
  };
}

/** Exit codes for the harness process itself. `0` means, and only means, PASSED. */
export const HARNESS_EXIT = {
  PASSED: 0,
  /** Some steps passed; others could not run. Not a pass. */
  PARTIAL: 10,
  /** Nothing ran. Not a pass, and not a failure of the system under test. */
  NOT_RUN: 11,
  /** Something ran and was wrong. */
  FAILED: 12,
  /** The report itself cannot be trusted. See rule 2. */
  INVALID: 70,
} as const;

export const evidenceOf = (result: StepResult): Evidence | null =>
  result.status === 'NOT_RUN' ? null : result.evidence;

export function summarize(
  steps: readonly StepResult[],
  environment: E2eReport['environment'],
  provisioning: readonly GapState[],
  harness: string,
): E2eReport {
  const passed = steps.filter((step) => step.status === 'PASSED').length;
  const failed = steps.filter((step) => step.status === 'FAILED').length;
  const notRun = steps.filter((step) => step.status === 'NOT_RUN').length;

  const stubbed = steps.filter((step) => evidenceOf(step)?.transport === 'STUB');
  const outcome: Outcome =
    stubbed.length > 0
      ? 'INVALID'
      : failed > 0
        ? 'FAILED'
        : passed === 0
          ? 'NOT_RUN'
          : notRun > 0
            ? 'PARTIAL'
            : 'PASSED';

  return {
    harness,
    outcome,
    headline: headlineFor(outcome, { passed, failed, notRun }, stubbed),
    environment,
    provisioning,
    steps,
    counts: { passed, failed, notRun },
  };
}

function headlineFor(
  outcome: Outcome,
  counts: { passed: number; failed: number; notRun: number },
  stubbed: readonly StepResult[],
): string {
  switch (outcome) {
    case 'INVALID':
      return `INVALID: ${stubbed.length} step(s) were satisfied by a stub rather than by the installed CLI. A mock cannot stand in for a live path, so this report establishes nothing.`;
    case 'FAILED':
      return `FAILED: ${counts.failed} step(s) ran and were wrong (${counts.passed} passed, ${counts.notRun} not run).`;
    case 'NOT_RUN':
      return 'NOT RUN: no step of this end-to-end could be executed. Nothing about the system under test has been established.';
    case 'PARTIAL':
      return `PARTIAL: ${counts.passed} step(s) passed and ${counts.notRun} could NOT run. This is not a passing end-to-end.`;
    case 'PASSED':
      return `PASSED: all ${counts.passed} step(s) ran against the installed CLI and were correct.`;
  }
}

export const exitCodeFor = (outcome: Outcome): number => HARNESS_EXIT[outcome];
