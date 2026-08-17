/**
 * Executing the plan, and refusing to.
 *
 * Three gates stand between a step and a subprocess, and each one produces a
 * NOT_RUN with a named cause rather than a skipped line nobody reads:
 *
 *  - the artifact under test has to exist (`CLI_NOT_BUILT`);
 *  - every provisioning gap the step declared has to be SATISFIED — an
 *    UNCHECKED gap is not one (`NOT_PROVISIONED`);
 *  - every step it reads from has to have PASSED (`PREREQUISITE_NOT_MET`).
 *
 * And a fourth for the one step that trades. A write needs BOTH an explicit
 * opt-in and an environment label this build recognises as non-production.
 * Neither alone is enough: an operator who forgot to label a deployment gets a
 * withheld order, not a live one, and the harness never decides for itself that
 * an unlabelled server is safe to trade on.
 */
import {
  locateCliBinary,
  processInvoker,
  type CliInvoker,
  type CliRun,
} from './cli-process.ts';
import type { GapId, GapState } from './gaps.ts';
import { GAP_IDS } from './gaps.ts';
import { preflight, unsatisfied, type RuntimeFacts } from './preflight.ts';
import {
  summarize,
  type E2eReport,
  type Evidence,
  type NotRunReason,
  type StepResult,
} from './report.ts';
import {
  DEFAULT_OPTIONS,
  emptyLedger,
  STEPS,
  type HarnessOptions,
  type Step,
} from './steps.ts';

export const HARNESS_NAME = 'waterx-predict e2e';

/**
 * Environment labels this build will place an order against.
 *
 * An allowlist, never a denylist: a label nobody anticipated is treated as
 * production and is not traded on. `mainnet`, `prod` and an ABSENT label all
 * fall here by construction rather than by enumeration.
 */
export const NON_PRODUCTION_ENVIRONMENTS: ReadonlySet<string> = new Set([
  'test',
  'testnet',
  'devnet',
  'localnet',
  'local',
  'staging',
  'sandbox',
]);

export interface WritePermission {
  readonly permitted: boolean;
  /** Null exactly when permitted. Otherwise the reason, in full. */
  readonly withheldBecause: string | null;
}

export function writePermission(
  facts: RuntimeFacts,
  options: HarnessOptions,
): WritePermission {
  const label = facts.environment;
  if (label === null) {
    return {
      permitted: false,
      withheldBecause:
        'No environment label is configured. An unlabelled deployment is treated as production, and this harness places no order against production under any condition.',
    };
  }
  if (!NON_PRODUCTION_ENVIRONMENTS.has(label.toLowerCase())) {
    return {
      permitted: false,
      withheldBecause: `The environment is labelled \`${label}\`, which this build does not recognise as non-production. Recognised: ${[...NON_PRODUCTION_ENVIRONMENTS].sort().join(', ')}.`,
    };
  }
  if (!options.allowWrite) {
    return {
      permitted: false,
      withheldBecause:
        'The write step is opt-in and was not requested. Pass `--allow-write` to place one real, price-protected order on this non-production environment.',
    };
  }
  return { permitted: true, withheldBecause: null };
}

const evidenceFrom = (run: CliRun): Evidence => ({
  transport: run.transport,
  argv: run.argv,
  exitCode: run.exitCode,
  ok: run.envelope?.ok === true,
  command: run.envelope?.command ?? '(none)',
  requestId: run.envelope?.requestId ?? '(none)',
  durationMs: run.durationMs,
});

const describeStep = (step: Step): StepResult['step'] => ({
  id: step.id,
  title: step.title,
  proves: step.proves,
  writes: step.writes,
});

/** Every step NOT_RUN for one shared reason. Used when nothing can run at all. */
function allNotRun(reason: NotRunReason, detail: string): StepResult[] {
  return STEPS.map((step) => ({
    step: describeStep(step),
    status: 'NOT_RUN' as const,
    reason,
    missing: [],
    detail,
  }));
}

export interface RunOptions extends Partial<HarnessOptions> {
  /** REPLACES the child environment. Defaults to this process's. */
  readonly env?: Readonly<Record<string, string>>;
  /** Per-invocation backstop for a child that stops responding. */
  readonly processTimeoutMs?: number;
}

/** The environment of this process, with the undefined entries dropped. */
const inheritedEnv = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

export async function runE2e(options: RunOptions = {}): Promise<E2eReport> {
  const resolved: HarnessOptions = { ...DEFAULT_OPTIONS, ...options };
  const located = locateCliBinary();

  if (!located.found) {
    const detail = `${located.reason} ${located.fix}`;
    return summarize(
      allNotRun('CLI_NOT_BUILT', detail),
      {
        baseUrl: null,
        label: null,
        configFile: null,
        writesPermitted: false,
        writeWithheldBecause: detail,
      },
      // Nothing was observed, so no gap may be called missing.
      GAP_IDS.map((id) => ({
        id,
        status: 'UNCHECKED' as const,
        observed: 'Not checked: there is no built CLI to ask.',
      })),
      HARNESS_NAME,
    );
  }

  const invoke: CliInvoker = processInvoker({
    binary: located.path,
    env: options.env ?? inheritedEnv(),
    timeoutMs: options.processTimeoutMs ?? 120_000,
  });

  return runWith(invoke, resolved);
}

/**
 * The plan against a given invoker.
 *
 * Separate from `runE2e` so the harness's own tests can drive it — including
 * with a stub, which is exactly how the "a mock never stands in for a live path"
 * rule is proven to bite rather than merely asserted in a comment.
 */
export async function runWith(
  invoke: CliInvoker,
  options: HarnessOptions,
): Promise<E2eReport> {
  const pre = await preflight(invoke);
  const permission = writePermission(pre.facts, options);
  const ledger = emptyLedger();
  const results: StepResult[] = [];
  const passed = new Set<string>();

  for (const step of STEPS) {
    const outcome = await runStep(step, {
      invoke,
      gaps: pre.gaps,
      facts: pre.facts,
      options,
      ledger,
      passed,
      permission,
      // `describe` already ran during preflight. Spawning it twice would report
      // one run's evidence for another run's result.
      cached: step.id === 'describe' ? pre.describe : null,
    });
    if (outcome.status === 'PASSED') passed.add(step.id);
    results.push(outcome);
  }

  return summarize(
    results,
    {
      baseUrl: pre.facts.baseUrl,
      label: pre.facts.environment,
      configFile: pre.facts.configFile,
      writesPermitted: permission.permitted,
      writeWithheldBecause: permission.withheldBecause,
    },
    pre.gaps,
    HARNESS_NAME,
  );
}

interface StepEnvironment {
  readonly invoke: CliInvoker;
  readonly gaps: readonly GapState[];
  readonly facts: RuntimeFacts;
  readonly options: HarnessOptions;
  readonly ledger: ReturnType<typeof emptyLedger>;
  readonly passed: ReadonlySet<string>;
  readonly permission: WritePermission;
  readonly cached: CliRun | null;
}

async function runStep(step: Step, environment: StepEnvironment): Promise<StepResult> {
  const described = describeStep(step);

  if (step.writes && !environment.permission.permitted) {
    return {
      step: described,
      status: 'NOT_RUN',
      reason: 'WRITE_WITHHELD',
      missing: [],
      detail: environment.permission.withheldBecause ?? 'The write was withheld.',
    };
  }

  const missing: GapId[] = unsatisfied(environment.gaps, step.requires);
  if (missing.length > 0) {
    return {
      step: described,
      status: 'NOT_RUN',
      reason: 'NOT_PROVISIONED',
      missing,
      detail: `Not provisioned: ${missing.join(', ')}. See the provisioning list for who supplies each.`,
    };
  }

  const blocked = step.after.filter((id) => !environment.passed.has(id));
  if (blocked.length > 0) {
    return {
      step: described,
      status: 'NOT_RUN',
      reason: 'PREREQUISITE_NOT_MET',
      missing: [],
      detail: `Reads from ${blocked.join(', ')}, which did not pass.`,
    };
  }

  const argv = step.argv({
    facts: environment.facts,
    options: environment.options,
    ledger: environment.ledger,
  });

  let run: CliRun;
  try {
    run = environment.cached ?? (await environment.invoke(argv));
  } catch (error: unknown) {
    // A spawn that never produced a run is not a step result. Reporting it as a
    // FAILED step would blame the system under test for the harness's own
    // inability to reach it.
    return {
      step: described,
      status: 'NOT_RUN',
      reason: 'CLI_NOT_BUILT',
      missing: [],
      detail: error instanceof Error ? error.message : 'The CLI could not be invoked.',
    };
  }

  const verdict = step.verify(run, environment.ledger);
  const evidence = evidenceFrom(run);
  return verdict.ok
    ? { step: described, status: 'PASSED', evidence }
    : { step: described, status: 'FAILED', evidence, why: verdict.why };
}
