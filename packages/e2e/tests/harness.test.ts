/**
 * The harness, driven against itself.
 *
 * Three things are worth proving here and none of them is "the E2E passes" — it
 * has not, and on this machine it cannot:
 *
 *  1. The write gates hold, and there are THREE of them. A stub that answers
 *     every step perfectly, on an environment labelled for production, still
 *     never receives an `order execute`, an `order execute-many` or a `strategy
 *     create` argv. And a run that opted into one of them does not thereby get
 *     the other two. The gates are checked as BEHAVIOUR — what the invoker was
 *     asked to run — not as flags someone remembered to read.
 *  2. An armed strategy is always chased. The cancel step is ungated by
 *     construction, so the only way a run ends with a live job is if the
 *     cancellation itself failed — and then it says so.
 *  3. An unprovisioned run tells the truth. The real, installed binary is
 *     spawned with an empty environment; `describe` genuinely runs, everything
 *     else is NOT_RUN with named gaps, and the verdict is PARTIAL — never
 *     PASSED, and never a silent skip.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { CliInvoker, CliRun } from "../src/cli-process.ts";
import type { ExternalRunner } from "../src/external.ts";
import { GAP_IDS } from "../src/gaps.ts";
import { lintInvocation } from "../src/lint.ts";
import { render } from "../src/render.ts";
import {
  HARNESS_EXIT,
  exitCodeFor,
  type WriteCapability,
} from "../src/report.ts";
import {
  NON_PRODUCTION_ENVIRONMENTS,
  WRITE_CAPABILITIES,
  runE2e,
  runWith,
  writePermission,
} from "../src/run.ts";
import {
  DEFAULT_PROCESS_TIMEOUT_MS,
  processBackstopMs,
} from "../src/cli-process.ts";
import {
  DEFAULT_OPTIONS,
  STEPS,
  emptyLedger,
  type HarnessOptions,
  type StepContext,
} from "../src/steps.ts";
import type { RuntimeFacts } from "../src/preflight.ts";

/* ── a stub that answers everything correctly ──────────────────────────────
 * Deliberately generous: every step it answers would PASS on its merits. That
 * is the point. If the transport rule ever stopped biting, this fixture would
 * report a fully green end-to-end that never touched a server. */

const PROVISIONED = {
  runtime: { name: "waterx-predict" },
  api: { baseUrl: "https://predict.testnet.invalid", environment: "testnet" },
  identity: {
    agentWallet: "0xagent",
    defaultAccountId: "0xaccount",
    configFile: null,
  },
  signer: { configured: true },
  policy: { mode: "interactive" },
};

const RESPONSES: Record<string, unknown> = {
  describe: PROVISIONED,
  "account risk-limits": {
    limits: { available: true },
    delegation: { mayPlaceOrder: true, checkedAt: "2026-01-01T00:00:00.000Z" },
  },
  doctor: { failed: 0 },
  "market list": { markets: [{ marketId: "mkt-1" }] },
  "market search": { resolution: { status: "RESOLVED" }, marketId: "mkt-1" },
  "market get": { market: { marketId: "mkt-1" } },
  // Satisfies BOTH preview shapes: one order, and a batch. The single-order step
  // reads `placed` and the token; the batch step also reads `atomic` and one
  // entry per leg. Keeping them in one fixture is deliberate — the command is one
  // command, and a fixture that split them could let the two drift apart here
  // while agreeing in production.
  "order preview": {
    placed: false,
    atomic: false,
    legs: [{ placed: false }, { placed: false }],
    quote: { quoteId: "q-2" },
    policy: { decision: "APPROVAL_REQUIRED", approvalToken: "appr-1" },
  },
  "order execute": { executionId: "exec-1" },
  "order execute-many": {
    atomic: false,
    legs: 2,
    summary: { succeeded: 2, failed: 0, skipped: 0, ambiguous: 0 },
    results: [
      { index: 0, status: "SUCCEEDED", executionId: "exec-leg-1" },
      { index: 1, status: "SUCCEEDED", executionId: "exec-leg-2" },
    ],
  },
  "order reconcile": { resolved: true },
  "order get": { execution: { executionId: "exec-1", terminal: true } },
  "account positions": { positions: [] },
  "account fills": { fills: [] },
  "strategy cancel": {
    jobId: "job-1",
    state: "CANCELLED",
    recorded: true,
    applied: true,
  },
};

/** The command path, ignoring flags and their values. */
const keyOf = (argv: readonly string[]): string =>
  argv
    .filter((token) => !token.startsWith("--"))
    .slice(0, 2)
    .join(" ");

interface StubOptions {
  /** Overrides folded into `describe`'s `api` block. */
  readonly api?: Record<string, unknown>;
  /** Overrides folded into every `runner` block the stub reports. */
  readonly runner?: Record<string, unknown>;
  /** Answer the Runner probe with the one error that means "no Runner". */
  readonly runnerUnreachable?: boolean;
  /** Make the operator's restart command fail, without running anything. */
  readonly restartExitCode?: number;
}

interface Stub {
  readonly invoke: CliInvoker;
  readonly seen: string[][];
  /** Stands in for the operator's restart command. Nothing is ever spawned. */
  readonly external: ExternalRunner;
  readonly restarts: () => number;
}

function stubInvoker(options: StubOptions = {}): Stub {
  const seen: string[][] = [];
  const commands: string[] = [];
  // A restart REPLACES the process holding the jobs, so the instance id changes.
  // Modelling that is what makes the recovery step's "a different Runner
  // answered" check something this fixture can fail.
  let restarts = 0;
  let quotes = 0;

  const external: ExternalRunner = async (command) => {
    commands.push(command);
    const exitCode = options.restartExitCode ?? 0;
    if (exitCode === 0) restarts += 1;
    return { exitCode, output: "waterx-predict-runnerd restarted" };
  };

  const runner = (): Record<string, unknown> => ({
    instanceId: `runner-${restarts}`,
    driving: true,
    socketPath: "/tmp/waterx-predict-e2e.sock",
    ...options.runner,
  });

  const dataFor = (key: string): unknown => {
    switch (key) {
      case "describe":
        return { ...PROVISIONED, api: { ...PROVISIONED.api, ...options.api } };
      case "market quote":
        // A fresh quote per call. Two legs sharing one is the exact thing
        // `multi-leg-quote-2` refuses, so the fixture must not hand them one.
        quotes += 1;
        return {
          quote: {
            quoteId: `q-${quotes}`,
            expiresAt: "2026-01-01T00:00:30.000Z",
          },
        };
      case "strategy list":
        return { strategies: [], runner: runner() };
      case "strategy create":
        return {
          strategy: {
            jobId: "job-1",
            state: "WATCHING",
            terminal: false,
            expiry: { expiresAt: "2026-01-01T01:00:00.000Z" },
          },
          driving: true,
          driverGaps: [],
          runner: runner(),
        };
      case "strategy get":
        return {
          strategy: {
            jobId: "job-1",
            state: "WATCHING",
            terminal: false,
            openSideEffects: [],
          },
          leasedHere: true,
          runner: runner(),
        };
      default:
        return RESPONSES[key];
    }
  };

  const invoke: CliInvoker = async (argv) => {
    seen.push([...argv]);
    const key = keyOf(argv);
    if (options.runnerUnreachable === true && key === "strategy list") {
      return {
        transport: "STUB",
        argv,
        exitCode: 7,
        durationMs: 1,
        envelope: {
          schemaVersion: "0.1.0",
          ok: false,
          command: key,
          requestId: "req-stub",
          error: {
            code: "RUNNER_UNREACHABLE",
            message: "nothing is listening on the socket",
          },
        },
        stderr: "",
      };
    }
    const data = dataFor(key);
    const run: CliRun = {
      // The one value this fixture may claim. `report.ts` reads it and voids the
      // whole report, which is the invariant under test.
      transport: "STUB",
      argv,
      exitCode: 0,
      durationMs: 1,
      envelope:
        data === undefined
          ? null
          : {
              schemaVersion: "0.1.0",
              ok: true,
              command: key,
              requestId: "req-stub",
              data,
            },
      stderr: "",
    };
    return run;
  };
  return { invoke, seen, external, restarts: () => restarts };
}

const withOptions = (
  overrides: Partial<HarnessOptions> = {},
): HarnessOptions => ({
  ...DEFAULT_OPTIONS,
  ...overrides,
});

/** Everything opted into and everything supplied — the only fully-green shape. */
const EVERYTHING = withOptions({
  allowWrite: true,
  allowMultiLeg: true,
  allowStrategy: true,
  ownerAddress: "0xowner",
  runnerRestart: "systemctl --user restart waterx-predict-runnerd",
});

/* ── the write gates ──────────────────────────────────────────────────────── */

const facts = (environment: string | null): RuntimeFacts => ({
  baseUrl: "https://predict.example.invalid",
  environment,
  agentWallet: "0xagent",
  defaultAccountId: "0xaccount",
  signerConfigured: true,
  configFile: null,
  policyMode: "interactive",
});

describe("the write gate", () => {
  it("refuses an unlabelled environment, because unlabelled is treated as production", () => {
    const permission = writePermission(
      facts(null),
      withOptions({ allowWrite: true }),
      "order",
    );
    expect(permission.permitted).toBe(false);
    expect(permission.withheldBecause).toContain("treated as production");
  });

  it("refuses a label it does not recognise, rather than reasoning about it", () => {
    // An allowlist, so a label nobody anticipated fails closed. `mainnet` is not
    // enumerated as forbidden anywhere — it simply is not permitted.
    for (const label of [
      "mainnet",
      "prod",
      "production",
      "MAINNET",
      "testnet-fork",
    ]) {
      const permission = writePermission(
        facts(label),
        withOptions({ allowWrite: true }),
        "order",
      );
      expect(permission.permitted, label).toBe(false);
    }
    expect(NON_PRODUCTION_ENVIRONMENTS.has("mainnet")).toBe(false);
  });

  it("refuses a recognised environment that was not opted into", () => {
    const permission = writePermission(
      facts("testnet"),
      withOptions({ allowWrite: false }),
      "order",
    );
    expect(permission.permitted).toBe(false);
    expect(permission.withheldBecause).toContain("--allow-write");
  });

  it("permits only a recognised label AND an explicit opt-in, together", () => {
    for (const label of NON_PRODUCTION_ENVIRONMENTS) {
      const permission = writePermission(
        facts(label),
        withOptions({ allowWrite: true }),
        "order",
      );
      expect(permission.permitted, label).toBe(true);
      expect(permission.withheldBecause, label).toBeNull();
    }
  });

  it("never lets one opt-in authorize another capability", () => {
    // The whole reason these are three flags. Someone who agreed to ONE order
    // did not agree to two, and neither of those is agreeing to leave a job
    // behind that trades after the process exits.
    const only: Record<WriteCapability, Partial<HarnessOptions>> = {
      order: { allowWrite: true },
      "multi-leg": { allowMultiLeg: true },
      strategy: { allowStrategy: true },
    };
    for (const granted of WRITE_CAPABILITIES) {
      const options = withOptions(only[granted]);
      for (const capability of WRITE_CAPABILITIES) {
        const permission = writePermission(
          facts("testnet"),
          options,
          capability,
        );
        expect(permission.permitted, `${granted} → ${capability}`).toBe(
          capability === granted,
        );
      }
    }
  });

  it("names the flag that would grant each capability, and what agreeing to it means", () => {
    const flags = WRITE_CAPABILITIES.map(
      (capability) =>
        writePermission(facts("testnet"), withOptions(), capability)
          .withheldBecause,
    );
    expect(flags[0]).toContain("--allow-write");
    expect(flags[1]).toContain("--allow-multi-leg");
    expect(flags[2]).toContain("--allow-strategy");
    // The strategy opt-in has to say the dangerous part out loud.
    expect(flags[2]).toContain("after this process has exited");
  });

  it("never sends a write to the invoker when the label is a production one", async () => {
    const stub = stubInvoker({ api: { environment: "mainnet" } });
    const report = await runWith(stub.invoke, EVERYTHING, stub.external);

    // The gates are proven by what was NOT spawned. A flag read correctly but
    // acted on late would still have placed the order.
    const spawned = stub.seen.map(keyOf);
    expect(spawned).not.toContain("order execute");
    expect(spawned).not.toContain("order execute-many");
    expect(spawned).not.toContain("strategy create");

    for (const id of ["order-execute", "order-execute-many", "strategy-arm"]) {
      const step = report.steps.find((result) => result.step.id === id);
      expect(step?.status, id).toBe("NOT_RUN");
      expect(step?.status === "NOT_RUN" ? step.reason : null, id).toBe(
        "WRITE_WITHHELD",
      );
    }
    expect(
      report.environment.writes.every((permission) => !permission.permitted),
    ).toBe(true);
  });

  it("marks every writing step with the capability it needs, and no other step", () => {
    expect(
      STEPS.filter((step) => step.writes !== null).map((step) => [
        step.id,
        step.writes,
      ]),
    ).toEqual([
      ["order-execute", "order"],
      ["order-execute-many", "multi-leg"],
      ["strategy-arm", "strategy"],
    ]);
    for (const step of STEPS) {
      if (step.writes === null) continue;
      expect(WRITE_CAPABILITIES, step.id).toContain(step.writes);
    }
  });
});

/* ── the strategy is always chased ────────────────────────────────────────── */

describe("an armed strategy", () => {
  it("is cancelled by a step nothing can withhold", () => {
    const cancel = STEPS.find((step) => step.id === "strategy-cancel");
    // If this ever became a gated write, a run could end having armed a job and
    // then declined to stop it — the one outcome the harness must not produce.
    expect(cancel?.writes).toBeNull();
    expect(cancel?.after).toEqual([]);
    // And it runs last, so nothing can fail between arming and stopping.
    expect(STEPS.at(-1)?.id).toBe("strategy-cancel");
  });

  it("reports NOTHING_TO_DO — not a failure — when this run armed nothing", async () => {
    const stub = stubInvoker();
    const report = await runWith(
      stub.invoke,
      withOptions({ ownerAddress: "0xowner", runnerRestart: "true" }),
      stub.external,
    );

    expect(stub.seen.map(keyOf)).not.toContain("strategy cancel");
    const cancel = report.steps.find(
      (result) => result.step.id === "strategy-cancel",
    );
    expect(cancel?.status === "NOT_RUN" ? cancel.reason : null).toBe(
      "NOTHING_TO_DO",
    );
    // And it still points at the one command that would find a job this report
    // cannot name.
    expect(cancel?.status === "NOT_RUN" ? cancel.detail : "").toContain(
      "strategy list",
    );
  });

  it("cancels the job it armed, and reads the reply as recorded-versus-applied", async () => {
    const stub = stubInvoker();
    const report = await runWith(stub.invoke, EVERYTHING, stub.external);

    const cancelArgv = stub.seen.find(
      (argv) => keyOf(argv) === "strategy cancel",
    );
    expect(cancelArgv ?? []).toContain("job-1");
    expect(
      report.steps.find((result) => result.step.id === "strategy-cancel")
        ?.status,
    ).toBe("PASSED");
  });
});

/* ── the restart, which is the operator's command and never ours ──────────── */

describe("the Runner restart", () => {
  it("runs the operator’s command exactly once, and only for the recovery step", async () => {
    const stub = stubInvoker();
    await runWith(stub.invoke, EVERYTHING, stub.external);
    expect(stub.restarts()).toBe(1);
  });

  it("reports a failed restart as NOT_RUN, because nothing was asked of the CLI", async () => {
    const stub = stubInvoker({ restartExitCode: 1 });
    const report = await runWith(stub.invoke, EVERYTHING, stub.external);

    const recovery = report.steps.find(
      (result) => result.step.id === "strategy-restart-recovery",
    );
    // FAILED would blame the system under test for the operator's daemon.
    expect(recovery?.status).toBe("NOT_RUN");
    expect(recovery?.status === "NOT_RUN" ? recovery.reason : null).toBe(
      "PREREQUISITE_NOT_MET",
    );
    expect(recovery?.status === "NOT_RUN" ? recovery.detail : "").toContain(
      "exited 1",
    );

    // And the job it could not verify is still cancelled.
    expect(
      report.steps.find((result) => result.step.id === "strategy-cancel")
        ?.status,
    ).toBe("PASSED");
  });

  it("fails the recovery step when the SAME Runner instance answers afterwards", async () => {
    // A restart command that does nothing would otherwise let "the job survived
    // a restart" be a claim about no restart at all.
    const stub = stubInvoker({ runner: { instanceId: "runner-frozen" } });
    const report = await runWith(stub.invoke, EVERYTHING, stub.external);

    const recovery = report.steps.find(
      (result) => result.step.id === "strategy-restart-recovery",
    );
    expect(recovery?.status).toBe("FAILED");
    expect(recovery?.status === "FAILED" ? recovery.why : "").toContain(
      "no process was replaced",
    );
  });
});

/* ── the Runner probe ─────────────────────────────────────────────────────── */

describe("the Runner gap", () => {
  const runnerState = async (options: StubOptions) => {
    const stub = stubInvoker(options);
    const report = await runWith(stub.invoke, EVERYTHING, stub.external);
    return report.provisioning.find((state) => state.id === "runner");
  };

  it("is MISSING only when a Runner is genuinely not there", async () => {
    const state = await runnerState({ runnerUnreachable: true });
    expect(state?.status).toBe("MISSING");
    expect(state?.observed).toContain("No Runner answered");
  });

  it("is MISSING when a Runner answers but drives nothing", async () => {
    // The expensive case: the create would succeed and write a real job that
    // nothing advances. "Armed and asleep" is not provisioned.
    const state = await runnerState({ runner: { driving: false } });
    expect(state?.status).toBe("MISSING");
    expect(state?.observed).toContain("armed and asleep");
  });

  it("is UNCHECKED when a reply arrives that names no instance", async () => {
    const state = await runnerState({ runner: { instanceId: null } });
    expect(state?.status).toBe("UNCHECKED");
  });

  it("is SATISFIED only when a named Runner says it is driving", async () => {
    const state = await runnerState({});
    expect(state?.status).toBe("SATISFIED");
    expect(state?.observed).toContain("driving");
  });
});

/* ── every step is a command that exists ──────────────────────────────────── */

describe("the plan itself", () => {
  const context: StepContext = {
    facts: facts("testnet"),
    options: EVERYTHING,
    ledger: {
      ...emptyLedger(),
      marketId: "mkt-1",
      quoteId: "q-1",
      approvalToken: "appr-1",
      executionId: "exec-1",
      quoteLeg1: "q-1",
      quoteLeg2: "q-2",
      jobId: "job-1",
      runnerInstanceId: "runner-0",
    },
  };

  it("spells every step as a command in the contract, with fields that exist", () => {
    // The same lint the shipped examples get. A step whose flag is not a field
    // would exit USAGE against the real binary and report a CLI defect that is
    // really a harness typo.
    for (const step of STEPS) {
      expect(lintInvocation(step.argv(context)), step.id).toEqual([]);
    }
  });

  it("reads only from steps that exist and run earlier", () => {
    const seen = new Set<string>();
    for (const step of STEPS) {
      for (const earlier of step.after) {
        expect([...seen], `${step.id} reads from ${earlier}`).toContain(
          earlier,
        );
      }
      seen.add(step.id);
    }
  });
});

/* ── the stub rule ────────────────────────────────────────────────────────── */

describe("a run satisfied entirely by a stub", () => {
  it("is INVALID even though every single step passed on its merits", async () => {
    const stub = stubInvoker();
    const report = await runWith(stub.invoke, EVERYTHING, stub.external);

    // Every step ran and was correct — by the stub's account.
    expect(report.counts.notRun).toBe(0);
    expect(report.counts.failed).toBe(0);
    expect(report.counts.passed).toBe(STEPS.length);

    // And it still establishes nothing.
    expect(report.outcome).toBe("INVALID");
    expect(report.headline).toContain("A mock cannot stand in for a live path");
    expect(exitCodeFor(report.outcome)).toBe(HARNESS_EXIT.INVALID);
    expect(exitCodeFor(report.outcome)).not.toBe(0);
  });
});

/* ── the real, unprovisioned run ──────────────────────────────────────────── */

describe("the installed CLI with nothing provisioned", () => {
  const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));

  // The environment is REPLACED, not extended, so no WATERX_PREDICT_* variable of
  // the developer's can reach the child, and HOME points at nothing so no config
  // file is found either. This is the state the work package describes.
  const BARE_ENV = { HOME: join(PACKAGE_DIR, "node_modules", ".no-such-home") };

  it("runs describe for real and reports everything else as NOT RUN", async () => {
    const report = await runE2e({ env: BARE_ENV, processTimeoutMs: 30_000 });

    if (report.outcome === "NOT_RUN" && report.steps[0]?.status === "NOT_RUN") {
      // Distinguish "the E2E could not run" from "this repository is not built",
      // which is a different problem with a different fix.
      expect(
        report.steps[0].reason,
        "the CLI must be built: run `pnpm build`",
      ).not.toBe("CLI_NOT_BUILT");
    }

    const describe = report.steps[0];
    expect(describe?.step.id).toBe("describe");
    expect(describe?.status).toBe("PASSED");
    // It really was a subprocess. Nothing in this package can produce that value
    // except `cli-process.ts` spawning the installed binary.
    expect(
      describe?.status === "PASSED" ? describe.evidence.transport : null,
    ).toBe("PROCESS");
    expect(
      describe?.status === "PASSED" ? describe.evidence.exitCode : null,
    ).toBe(0);

    expect(report.counts.passed).toBe(1);
    expect(report.counts.failed).toBe(0);
    expect(report.counts.notRun).toBe(STEPS.length - 1);

    // One step passing is not an E2E, and the verdict says so.
    expect(report.outcome).toBe("PARTIAL");
    expect(report.headline).toContain("This is not a passing end-to-end.");
    expect(exitCodeFor(report.outcome)).toBe(HARNESS_EXIT.PARTIAL);
    expect(exitCodeFor(report.outcome)).not.toBe(0);
  });

  it("gives every unrun step a named cause, never a bare skip", async () => {
    const report = await runE2e({ env: BARE_ENV, processTimeoutMs: 30_000 });

    for (const result of report.steps.slice(1)) {
      expect(result.status, result.step.id).toBe("NOT_RUN");
      if (result.status !== "NOT_RUN") continue;
      expect(result.detail.length, result.step.id).toBeGreaterThan(20);
      if (result.reason === "NOT_PROVISIONED") {
        // Named gaps, so the reader knows who to ask.
        expect(result.missing.length, result.step.id).toBeGreaterThan(0);
        for (const id of result.missing)
          expect(GAP_IDS as readonly string[]).toContain(id);
      }
    }

    for (const id of ["order-execute", "order-execute-many", "strategy-arm"]) {
      const step = report.steps.find((result) => result.step.id === id);
      expect(step?.status === "NOT_RUN" ? step.reason : null, id).toBe(
        "WRITE_WITHHELD",
      );
    }
  });

  it("never runs the operator restart command when nothing armed a strategy", async () => {
    // `runE2e` builds the real shell runner. It must never reach it: the gap is
    // MISSING, so the step cannot run, so no command is constructed or spawned.
    const report = await runE2e({ env: BARE_ENV, processTimeoutMs: 30_000 });
    const recovery = report.steps.find(
      (result) => result.step.id === "strategy-restart-recovery",
    );
    expect(recovery?.status).toBe("NOT_RUN");
    expect(recovery?.status === "NOT_RUN" ? recovery.reason : null).toBe(
      "NOT_PROVISIONED",
    );
    expect(recovery?.status === "NOT_RUN" ? recovery.missing : []).toContain(
      "runnerRestart",
    );
  });

  it("reports all ten provisioning gaps, and never a satisfied one", async () => {
    const report = await runE2e({ env: BARE_ENV, processTimeoutMs: 30_000 });

    expect(report.provisioning.map((state) => state.id)).toEqual([...GAP_IDS]);
    for (const state of report.provisioning) {
      expect(state.status, state.id).not.toBe("SATISFIED");
      expect(state.observed.length, state.id).toBeGreaterThan(10);
    }

    // The two owner-authenticated gaps are UNCHECKED, not MISSING: no
    // authenticated read happened, so reporting "no delegation" would be a claim
    // about a conversation nobody had.
    const byId = new Map(report.provisioning.map((state) => [state.id, state]));
    expect(byId.get("delegation")?.status).toBe("UNCHECKED");
    expect(byId.get("ownerRiskProfile")?.status).toBe("UNCHECKED");
    expect(byId.get("baseUrl")?.status).toBe("MISSING");
    // The Runner probe is local and unconditional, so it IS established here:
    // nothing is listening, and that is a MISSING rather than an UNCHECKED.
    expect(byId.get("runner")?.status).toBe("MISSING");
    // And the two nobody can probe say plainly that they were never supplied.
    expect(byId.get("ownerAddress")?.status).toBe("MISSING");
    expect(byId.get("runnerRestart")?.status).toBe("MISSING");
  });

  it("renders a provisioning list that names a supplier for every outstanding gap", async () => {
    const report = await runE2e({ env: BARE_ENV, processTimeoutMs: 30_000 });
    const text = render(report);

    expect(text).toContain("Who must supply what (10 outstanding)");
    expect(text).toContain("[OPERATOR]");
    expect(text).toContain("[ACCOUNT_OWNER, OWNER-AUTHENTICATED]");
    for (const id of GAP_IDS) expect(text, id).toContain(id);
    // Each capability is withheld on its own line, so no reader can take away
    // "writes were allowed" from a run where one of the three was.
    expect(text).toContain("writes        order      WITHHELD");
    expect(text).toContain("multi-leg  WITHHELD");
    expect(text).toContain("strategy   WITHHELD");
    // A reader skimming the top must not be able to take away "it passed".
    expect(text.split("\n")[0]).toContain("PARTIAL");
  });
});

describe("the process backstop", () => {
  /** Exactly what the terminal-wait step builds, at a given settle timeout. */
  const terminalWait = (settleMs: number): readonly string[] => [
    "order",
    "reconcile",
    "--executionId",
    "exec-1",
    "--timeoutMs",
    String(settleMs),
  ];

  it("outlasts the deadline that invocation was given", () => {
    // Two bounds that must agree, with nothing making them agree: a
    // `--settleTimeoutMs` above the old fixed 120 s backstop meant the harness
    // SIGKILLed a command still inside the time it had been given, and reported
    // it as "stdout was not one JSON document" — which names neither cause.
    for (const settle of [60_000, 120_000, 240_000, 600_000]) {
      expect(
        processBackstopMs(terminalWait(settle), DEFAULT_PROCESS_TIMEOUT_MS),
      ).toBeGreaterThan(settle);
    }
  });

  it("leaves a command that was given no deadline on the fixed backstop", () => {
    // The regression this replaces: one derived number reached a SHARED invoker,
    // so the settle timeout became every command's clock. At the 60 s default it
    // cut `market list` from 120 s to 90 s; at `--settleTimeoutMs 600000` it let
    // a hung `doctor` sit for ten and a half minutes. Neither command waits on a
    // settlement, and neither should move when that bound does.
    for (const argv of [["market", "list"], ["doctor"], ["account", "status"]]) {
      expect(processBackstopMs(argv, DEFAULT_PROCESS_TIMEOUT_MS)).toBe(
        DEFAULT_PROCESS_TIMEOUT_MS,
      );
    }
  });

  it("moves only the invocation that carries the deadline", () => {
    // The two are read from the same run, and must not track each other.
    const stretched = processBackstopMs(
      terminalWait(600_000),
      DEFAULT_PROCESS_TIMEOUT_MS,
    );
    const unrelated = processBackstopMs(
      ["market", "list"],
      DEFAULT_PROCESS_TIMEOUT_MS,
    );
    expect(stretched).toBeGreaterThan(600_000);
    expect(unrelated).toBe(DEFAULT_PROCESS_TIMEOUT_MS);
  });

  it("still honours an explicit override, even a shorter one", () => {
    // An operator who names a bound owns it; deriving over the top would take
    // away the only way to cap a run. It bounds the commands with no deadline of
    // their own — the terminal wait keeps the one it was handed, because a
    // backstop under that deadline is the original bug.
    expect(processBackstopMs(["market", "list"], 5_000)).toBe(5_000);
  });

  it("ignores a --timeoutMs that is not a usable number", () => {
    // A malformed deadline is not a deadline. Reading NaN here would arm the
    // kill timer with NaN, which fires immediately.
    for (const argv of [
      ["order", "reconcile", "--timeoutMs"],
      ["order", "reconcile", "--timeoutMs", "later"],
      ["order", "reconcile", "--timeoutMs", "0"],
    ]) {
      expect(processBackstopMs(argv, DEFAULT_PROCESS_TIMEOUT_MS)).toBe(
        DEFAULT_PROCESS_TIMEOUT_MS,
      );
    }
  });
});
