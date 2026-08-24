/**
 * Executing the plan, and refusing to.
 *
 * Gates stand between a step and a subprocess, and each one produces a NOT_RUN
 * with a named cause rather than a skipped line nobody reads:
 *
 *  - the artifact under test has to exist (`CLI_NOT_BUILT`);
 *  - a step that trades needs its capability permitted (`WRITE_WITHHELD`);
 *  - every provisioning gap the step declared has to be SATISFIED — an
 *    UNCHECKED gap is not one (`NOT_PROVISIONED`);
 *  - a step with nothing to act on says so (`NOTHING_TO_DO`);
 *  - every step it reads from has to have PASSED (`PREREQUISITE_NOT_MET`).
 *
 * A write needs BOTH an explicit opt-in for ITS OWN capability and an
 * environment label this build recognises as non-production. Neither alone is
 * enough: an operator who forgot to label a deployment gets a withheld order,
 * not a live one, and the harness never decides for itself that an unlabelled
 * server is safe to trade on.
 */
import {
  DEFAULT_PROCESS_TIMEOUT_MS,
  locateCliBinary,
  processInvoker,
  type CliInvoker,
  type CliRun,
} from "./cli-process.ts";
import { shellRunner, type ExternalRunner } from "./external.ts";
import type { GapId, GapState } from "./gaps.ts";
import { GAP_IDS } from "./gaps.ts";
import { preflight, unsatisfied, type RuntimeFacts } from "./preflight.ts";
import {
  summarize,
  type CapabilityPermission,
  type E2eReport,
  type Evidence,
  type NotRunReason,
  type StepResult,
  type WriteCapability,
} from "./report.ts";
import {
  DEFAULT_OPTIONS,
  emptyLedger,
  STEPS,
  type HarnessOptions,
  type Ledger,
  type Step,
} from "./steps.ts";

export const HARNESS_NAME = "waterx-predict e2e";

/**
 * Environment labels this build will place an order against.
 *
 * An allowlist, never a denylist: a label nobody anticipated is treated as
 * production and is not traded on. `mainnet`, `prod` and an ABSENT label all
 * fall here by construction rather than by enumeration.
 */
export const NON_PRODUCTION_ENVIRONMENTS: ReadonlySet<string> = new Set([
  "test",
  "testnet",
  "devnet",
  "localnet",
  "local",
  "staging",
  "sandbox",
]);

/** What each capability's opt-in is called, and what agreeing to it means. */
const CAPABILITY_OPT_IN: Record<
  WriteCapability,
  {
    readonly flag: string;
    readonly grants: string;
    readonly of: (options: HarnessOptions) => boolean;
  }
> = {
  order: {
    flag: "--allow-write",
    grants: "place ONE real, price-protected order",
    of: (options) => options.allowWrite,
  },
  "multi-leg": {
    flag: "--allow-multi-leg",
    grants:
      "place TWO real orders in one call, which succeed or fail independently",
    of: (options) => options.allowMultiLeg,
  },
  strategy: {
    flag: "--allow-strategy",
    grants:
      "arm a durable strategy on the local Runner, which can trade LATER, after this process has exited",
    of: (options) => options.allowStrategy,
  },
};

export const WRITE_CAPABILITIES: readonly WriteCapability[] = [
  "order",
  "multi-leg",
  "strategy",
];

export function writePermission(
  facts: RuntimeFacts,
  options: HarnessOptions,
  capability: WriteCapability,
): CapabilityPermission {
  const label = facts.environment;
  const opt = CAPABILITY_OPT_IN[capability];
  if (label === null) {
    return {
      capability,
      permitted: false,
      withheldBecause:
        "No environment label is configured. An unlabelled deployment is treated as production, and this harness places no order against production under any condition.",
    };
  }
  if (!NON_PRODUCTION_ENVIRONMENTS.has(label.toLowerCase())) {
    return {
      capability,
      permitted: false,
      withheldBecause: `The environment is labelled \`${label}\`, which this build does not recognise as non-production. Recognised: ${[...NON_PRODUCTION_ENVIRONMENTS].sort().join(", ")}.`,
    };
  }
  if (!opt.of(options)) {
    return {
      capability,
      permitted: false,
      withheldBecause: `This step is opt-in and was not requested. Pass \`${opt.flag}\` to ${opt.grants} on this non-production environment.`,
    };
  }
  return { capability, permitted: true, withheldBecause: null };
}

/** Every capability, permitted or not. See `E2eReport['environment'].writes`. */
export const writePermissions = (
  facts: RuntimeFacts,
  options: HarnessOptions,
): readonly CapabilityPermission[] =>
  WRITE_CAPABILITIES.map((capability) =>
    writePermission(facts, options, capability),
  );

const evidenceFrom = (run: CliRun): Evidence => ({
  transport: run.transport,
  argv: run.argv,
  exitCode: run.exitCode,
  ok: run.envelope?.ok === true,
  command: run.envelope?.command ?? "(none)",
  requestId: run.envelope?.requestId ?? "(none)",
  durationMs: run.durationMs,
});

const describeStep = (step: Step): StepResult["step"] => ({
  id: step.id,
  title: step.title,
  proves: step.proves,
  writes: step.writes,
});

/** Every step NOT_RUN for one shared reason. Used when nothing can run at all. */
function allNotRun(reason: NotRunReason, detail: string): StepResult[] {
  return STEPS.map((step) => ({
    step: describeStep(step),
    status: "NOT_RUN" as const,
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
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

export async function runE2e(options: RunOptions = {}): Promise<E2eReport> {
  const resolved: HarnessOptions = { ...DEFAULT_OPTIONS, ...options };
  const located = locateCliBinary();

  if (!located.found) {
    const detail = `${located.reason} ${located.fix}`;
    return summarize(
      allNotRun("CLI_NOT_BUILT", detail),
      {
        baseUrl: null,
        label: null,
        configFile: null,
        writes: WRITE_CAPABILITIES.map((capability) => ({
          capability,
          permitted: false,
          withheldBecause: detail,
        })),
      },
      // Nothing was observed, so no gap may be called missing.
      GAP_IDS.map((id) => ({
        id,
        status: "UNCHECKED" as const,
        observed: "Not checked: there is no built CLI to ask.",
      })),
      HARNESS_NAME,
    );
  }

  // This is the backstop for a command that was handed no deadline of its own.
  // The terminal wait IS handed one, and stretches its own backstop past it —
  // per invocation, inside the invoker, so raising `--settleTimeoutMs` no longer
  // moves the clock on every other command sharing this invoker.
  const invoke: CliInvoker = processInvoker({
    binary: located.path,
    env: options.env ?? inheritedEnv(),
    timeoutMs: options.processTimeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS,
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
  /** Runs the operator's restart command. Injectable so tests never spawn one. */
  external: ExternalRunner = shellRunner(options.restartTimeoutMs),
): Promise<E2eReport> {
  const pre = await preflight(invoke, options);
  const permissions = writePermissions(pre.facts, options);
  const ledger = emptyLedger();
  const results: StepResult[] = [];
  const passed = new Set<string>();

  // Preflight already spawned these two. Spawning them again would report one
  // run's evidence for another run's result.
  const cachedRuns: Record<string, CliRun> = {
    describe: pre.describe,
    "strategy-list": pre.runnerProbe,
  };

  for (const step of STEPS) {
    const outcome = await runStep(step, {
      invoke,
      external,
      gaps: pre.gaps,
      facts: pre.facts,
      options,
      ledger,
      passed,
      permissions,
      cached: cachedRuns[step.id] ?? null,
    });
    if (outcome.status === "PASSED") passed.add(step.id);
    results.push(outcome);
  }

  return summarize(
    results,
    {
      baseUrl: pre.facts.baseUrl,
      label: pre.facts.environment,
      configFile: pre.facts.configFile,
      writes: permissions,
    },
    pre.gaps,
    HARNESS_NAME,
  );
}

interface StepEnvironment {
  readonly invoke: CliInvoker;
  readonly external: ExternalRunner;
  readonly gaps: readonly GapState[];
  readonly facts: RuntimeFacts;
  readonly options: HarnessOptions;
  readonly ledger: Ledger;
  readonly passed: ReadonlySet<string>;
  readonly permissions: readonly CapabilityPermission[];
  readonly cached: CliRun | null;
}

async function runStep(
  step: Step,
  environment: StepEnvironment,
): Promise<StepResult> {
  const described = describeStep(step);
  const context = {
    facts: environment.facts,
    options: environment.options,
    ledger: environment.ledger,
  };

  if (step.writes !== null) {
    const permission = environment.permissions.find(
      (candidate) => candidate.capability === step.writes,
    );
    // A capability with no permission entry is a programming error, and the safe
    // reading of one is "not permitted".
    if (permission === undefined || !permission.permitted) {
      return {
        step: described,
        status: "NOT_RUN",
        reason: "WRITE_WITHHELD",
        missing: [],
        detail:
          permission?.withheldBecause ??
          `No permission was computed for \`${step.writes}\`.`,
      };
    }
  }

  const missing: GapId[] = unsatisfied(environment.gaps, step.requires);
  if (missing.length > 0) {
    return {
      step: described,
      status: "NOT_RUN",
      reason: "NOT_PROVISIONED",
      missing,
      detail: `Not provisioned: ${missing.join(", ")}. See the provisioning list for who supplies each.`,
    };
  }

  const idle = step.onlyIf?.(context) ?? null;
  if (idle !== null) {
    return {
      step: described,
      status: "NOT_RUN",
      reason: "NOTHING_TO_DO",
      missing: [],
      detail: idle,
    };
  }

  const blocked = step.after.filter((id) => !environment.passed.has(id));
  if (blocked.length > 0) {
    return {
      step: described,
      status: "NOT_RUN",
      reason: "PREREQUISITE_NOT_MET",
      missing: [],
      detail: `Reads from ${blocked.join(", ")}, which did not pass.`,
    };
  }

  if (step.prepare !== undefined) {
    const prepared = await step.prepare(context, environment.external);
    if (!prepared.ok) {
      // Not a FAILED step: nothing was asked of the CLI, so nothing about it was
      // established. What failed is the world this step needed.
      return {
        step: described,
        status: "NOT_RUN",
        reason: "PREREQUISITE_NOT_MET",
        missing: [],
        detail: `The step could not be set up: ${prepared.why}`,
      };
    }
  }

  const argv = step.argv(context);

  let run: CliRun;
  try {
    run = environment.cached ?? (await environment.invoke(argv));
  } catch (error: unknown) {
    // A spawn that never produced a run is not a step result. Reporting it as a
    // FAILED step would blame the system under test for the harness's own
    // inability to reach it.
    return {
      step: described,
      status: "NOT_RUN",
      reason: "CLI_NOT_BUILT",
      missing: [],
      detail:
        error instanceof Error
          ? error.message
          : "The CLI could not be invoked.",
    };
  }

  const verdict = step.verify(run, environment.ledger);
  const evidence = evidenceFrom(run);
  return verdict.ok
    ? { step: described, status: "PASSED", evidence }
    : { step: described, status: "FAILED", evidence, why: verdict.why };
}
