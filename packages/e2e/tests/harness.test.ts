/**
 * The harness, driven against itself.
 *
 * Two things are worth proving here and neither is "the E2E passes" — it has
 * not, and on this machine it cannot:
 *
 *  1. The write gate holds. A stub that answers every step perfectly, on an
 *     environment labelled for production, still never receives an `order
 *     execute` argv. The gate is checked as BEHAVIOUR — what the invoker was
 *     asked to run — not as a flag someone remembered to read.
 *  2. An unprovisioned run tells the truth. The real, installed binary is
 *     spawned with an empty environment; `describe` genuinely runs, everything
 *     else is NOT_RUN with named gaps, and the verdict is PARTIAL — never
 *     PASSED, and never a silent skip.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CliInvoker, CliRun } from '../src/cli-process.ts';
import { GAP_IDS } from '../src/gaps.ts';
import { render } from '../src/render.ts';
import { HARNESS_EXIT, exitCodeFor } from '../src/report.ts';
import { NON_PRODUCTION_ENVIRONMENTS, runE2e, runWith, writePermission } from '../src/run.ts';
import { DEFAULT_OPTIONS, STEPS, type HarnessOptions } from '../src/steps.ts';
import type { RuntimeFacts } from '../src/preflight.ts';

/* ── a stub that answers everything correctly ──────────────────────────────
 * Deliberately generous: every step it answers would PASS on its merits. That
 * is the point. If the transport rule ever stopped biting, this fixture would
 * report a fully green end-to-end that never touched a server. */

const PROVISIONED = {
  runtime: { name: 'waterx-predict' },
  api: { baseUrl: 'https://predict.testnet.invalid', environment: 'testnet' },
  identity: { agentWallet: '0xagent', defaultAccountId: '0xaccount', configFile: null },
  signer: { configured: true },
  policy: { mode: 'interactive' },
};

const RESPONSES: Record<string, unknown> = {
  describe: PROVISIONED,
  'account risk-limits': {
    limits: { available: true },
    delegation: { mayPlaceOrder: true, checkedAt: '2026-01-01T00:00:00.000Z' },
  },
  doctor: { failed: 0 },
  'market list': { markets: [{ marketId: 'mkt-1' }] },
  'market search': { resolution: { status: 'RESOLVED' }, marketId: 'mkt-1' },
  'market get': { market: { marketId: 'mkt-1' } },
  'market quote': { quote: { quoteId: 'q-1', expiresAt: '2026-01-01T00:00:30.000Z' } },
  'order preview': {
    placed: false,
    quote: { quoteId: 'q-2' },
    policy: { decision: 'APPROVAL_REQUIRED', approvalToken: 'appr-1' },
  },
  'order execute': { executionId: 'exec-1' },
  'order reconcile': { resolved: true },
  'order get': { execution: { executionId: 'exec-1', terminal: true } },
  'account positions': { positions: [] },
  'account fills': { fills: [] },
};

/** The command path, ignoring flags and their values. */
const keyOf = (argv: readonly string[]): string =>
  argv
    .filter((token) => !token.startsWith('--'))
    .slice(0, 2)
    .join(' ');

interface StubOptions {
  /** Overrides folded into `describe`'s `api` block. */
  readonly api?: Record<string, unknown>;
}

function stubInvoker(options: StubOptions = {}): { invoke: CliInvoker; seen: string[][] } {
  const seen: string[][] = [];
  const invoke: CliInvoker = async (argv) => {
    seen.push([...argv]);
    const key = keyOf(argv);
    const data =
      key === 'describe' ? { ...PROVISIONED, api: { ...PROVISIONED.api, ...options.api } } : RESPONSES[key];
    const run: CliRun = {
      // The one value this fixture may claim. `report.ts` reads it and voids the
      // whole report, which is the invariant under test.
      transport: 'STUB',
      argv,
      exitCode: 0,
      durationMs: 1,
      envelope:
        data === undefined
          ? null
          : { schemaVersion: '0.1.0', ok: true, command: key, requestId: 'req-stub', data },
      stderr: '',
    };
    return run;
  };
  return { invoke, seen };
}

const withOptions = (overrides: Partial<HarnessOptions> = {}): HarnessOptions => ({
  ...DEFAULT_OPTIONS,
  ...overrides,
});

/* ── the write gate ───────────────────────────────────────────────────────── */

const facts = (environment: string | null): RuntimeFacts => ({
  baseUrl: 'https://predict.example.invalid',
  environment,
  agentWallet: '0xagent',
  defaultAccountId: '0xaccount',
  signerConfigured: true,
  configFile: null,
  policyMode: 'interactive',
});

describe('the write gate', () => {
  it('refuses an unlabelled environment, because unlabelled is treated as production', () => {
    const permission = writePermission(facts(null), withOptions({ allowWrite: true }));
    expect(permission.permitted).toBe(false);
    expect(permission.withheldBecause).toContain('treated as production');
  });

  it('refuses a label it does not recognise, rather than reasoning about it', () => {
    // An allowlist, so a label nobody anticipated fails closed. `mainnet` is not
    // enumerated as forbidden anywhere — it simply is not permitted.
    for (const label of ['mainnet', 'prod', 'production', 'MAINNET', 'testnet-fork']) {
      const permission = writePermission(facts(label), withOptions({ allowWrite: true }));
      expect(permission.permitted, label).toBe(false);
    }
    expect(NON_PRODUCTION_ENVIRONMENTS.has('mainnet')).toBe(false);
  });

  it('refuses a recognised environment that was not opted into', () => {
    const permission = writePermission(facts('testnet'), withOptions({ allowWrite: false }));
    expect(permission.permitted).toBe(false);
    expect(permission.withheldBecause).toContain('--allow-write');
  });

  it('permits only a recognised label AND an explicit opt-in, together', () => {
    for (const label of NON_PRODUCTION_ENVIRONMENTS) {
      const permission = writePermission(facts(label), withOptions({ allowWrite: true }));
      expect(permission.permitted, label).toBe(true);
      expect(permission.withheldBecause, label).toBeNull();
    }
  });

  it('never sends `order execute` to the invoker when the label is a production one', async () => {
    const { invoke, seen } = stubInvoker({ api: { environment: 'mainnet' } });
    const report = await runWith(invoke, withOptions({ allowWrite: true }));

    // The gate is proven by what was NOT spawned. A flag read correctly but acted
    // on late would still have placed the order.
    expect(seen.map(keyOf)).not.toContain('order execute');

    const execute = report.steps.find((step) => step.step.id === 'order-execute');
    expect(execute?.status).toBe('NOT_RUN');
    expect(execute?.status === 'NOT_RUN' ? execute.reason : null).toBe('WRITE_WITHHELD');
    expect(report.environment.writesPermitted).toBe(false);
  });

  it('marks exactly one step as writing, so the gate covers the whole write surface', () => {
    expect(STEPS.filter((step) => step.writes).map((step) => step.id)).toEqual(['order-execute']);
  });
});

/* ── the stub rule ────────────────────────────────────────────────────────── */

describe('a run satisfied entirely by a stub', () => {
  it('is INVALID even though every single step passed on its merits', async () => {
    const { invoke } = stubInvoker();
    const report = await runWith(invoke, withOptions({ allowWrite: true }));

    // Every step ran and was correct — by the stub's account.
    expect(report.counts.notRun).toBe(0);
    expect(report.counts.failed).toBe(0);
    expect(report.counts.passed).toBe(STEPS.length);

    // And it still establishes nothing.
    expect(report.outcome).toBe('INVALID');
    expect(report.headline).toContain('A mock cannot stand in for a live path');
    expect(exitCodeFor(report.outcome)).toBe(HARNESS_EXIT.INVALID);
    expect(exitCodeFor(report.outcome)).not.toBe(0);
  });
});

/* ── the real, unprovisioned run ──────────────────────────────────────────── */

describe('the installed CLI with nothing provisioned', () => {
  const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));

  // The environment is REPLACED, not extended, so no WATERX_PREDICT_* variable of
  // the developer's can reach the child, and HOME points at nothing so no config
  // file is found either. This is the state the work package describes.
  const BARE_ENV = { HOME: join(PACKAGE_DIR, 'node_modules', '.no-such-home') };

  it('runs describe for real and reports everything else as NOT RUN', async () => {
    const report = await runE2e({ env: BARE_ENV, processTimeoutMs: 30_000 });

    if (report.outcome === 'NOT_RUN' && report.steps[0]?.status === 'NOT_RUN') {
      // Distinguish "the E2E could not run" from "this repository is not built",
      // which is a different problem with a different fix.
      expect(report.steps[0].reason, 'the CLI must be built: run `pnpm build`').not.toBe(
        'CLI_NOT_BUILT',
      );
    }

    const describe = report.steps[0];
    expect(describe?.step.id).toBe('describe');
    expect(describe?.status).toBe('PASSED');
    // It really was a subprocess. Nothing in this package can produce that value
    // except `cli-process.ts` spawning the installed binary.
    expect(describe?.status === 'PASSED' ? describe.evidence.transport : null).toBe('PROCESS');
    expect(describe?.status === 'PASSED' ? describe.evidence.exitCode : null).toBe(0);

    expect(report.counts.passed).toBe(1);
    expect(report.counts.failed).toBe(0);
    expect(report.counts.notRun).toBe(STEPS.length - 1);

    // One step passing is not an E2E, and the verdict says so.
    expect(report.outcome).toBe('PARTIAL');
    expect(report.headline).toContain('This is not a passing end-to-end.');
    expect(exitCodeFor(report.outcome)).toBe(HARNESS_EXIT.PARTIAL);
    expect(exitCodeFor(report.outcome)).not.toBe(0);
  });

  it('gives every unrun step a named cause, never a bare skip', async () => {
    const report = await runE2e({ env: BARE_ENV, processTimeoutMs: 30_000 });

    for (const result of report.steps.slice(1)) {
      expect(result.status, result.step.id).toBe('NOT_RUN');
      if (result.status !== 'NOT_RUN') continue;
      expect(result.detail.length, result.step.id).toBeGreaterThan(20);
      if (result.reason === 'NOT_PROVISIONED') {
        // Named gaps, so the reader knows who to ask.
        expect(result.missing.length, result.step.id).toBeGreaterThan(0);
        for (const id of result.missing) expect(GAP_IDS as readonly string[]).toContain(id);
      }
    }

    const execute = report.steps.find((step) => step.step.id === 'order-execute');
    expect(execute?.status === 'NOT_RUN' ? execute.reason : null).toBe('WRITE_WITHHELD');
  });

  it('reports all seven provisioning gaps, and never a satisfied one', async () => {
    const report = await runE2e({ env: BARE_ENV, processTimeoutMs: 30_000 });

    expect(report.provisioning.map((state) => state.id)).toEqual([...GAP_IDS]);
    for (const state of report.provisioning) {
      expect(state.status, state.id).not.toBe('SATISFIED');
      expect(state.observed.length, state.id).toBeGreaterThan(10);
    }

    // The two owner-authenticated gaps are UNCHECKED, not MISSING: no
    // authenticated read happened, so reporting "no delegation" would be a claim
    // about a conversation nobody had.
    const byId = new Map(report.provisioning.map((state) => [state.id, state]));
    expect(byId.get('delegation')?.status).toBe('UNCHECKED');
    expect(byId.get('ownerRiskProfile')?.status).toBe('UNCHECKED');
    expect(byId.get('baseUrl')?.status).toBe('MISSING');
  });

  it('renders a provisioning list that names a supplier for every outstanding gap', async () => {
    const report = await runE2e({ env: BARE_ENV, processTimeoutMs: 30_000 });
    const text = render(report);

    expect(text).toContain('Who must supply what (7 outstanding)');
    expect(text).toContain('[OPERATOR]');
    expect(text).toContain('[ACCOUNT_OWNER, OWNER-AUTHENTICATED]');
    for (const id of GAP_IDS) expect(text, id).toContain(id);
    expect(text).toContain('writes        WITHHELD');
    // A reader skimming the top must not be able to take away "it passed".
    expect(text.split('\n')[0]).toContain('PARTIAL');
  });
});
