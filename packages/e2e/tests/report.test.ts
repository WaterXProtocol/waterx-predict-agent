/**
 * The honesty invariants, tested as behaviour rather than trusted as intent.
 *
 * Three claims are made in `report.ts`: a step that did not run can never be
 * reported as passing, a stub can never stand in for a live path, and only a
 * fully-executed plan exits 0. Each is checked here against the summarizer,
 * because each is the kind of thing that quietly stops being true.
 */
import { GAP_IDS, type GapState } from '../src/gaps.ts';
import {
  HARNESS_EXIT,
  exitCodeFor,
  summarize,
  type E2eReport,
  type Evidence,
  type StepResult,
} from '../src/report.ts';

const ENVIRONMENT: E2eReport['environment'] = {
  baseUrl: 'https://predict.test.invalid',
  label: 'testnet',
  configFile: null,
  writesPermitted: false,
  writeWithheldBecause: 'not requested',
};

const GAPS: readonly GapState[] = GAP_IDS.map((id) => ({
  id,
  status: 'SATISFIED',
  observed: 'stubbed for this test',
}));

const evidence = (transport: Evidence['transport'] = 'PROCESS'): Evidence => ({
  transport,
  argv: ['describe'],
  exitCode: 0,
  ok: true,
  command: 'describe',
  requestId: 'req-0001',
  durationMs: 12,
});

const step = (id: string, writes = false): StepResult['step'] => ({
  id,
  title: id,
  proves: `what ${id} would establish`,
  writes,
});

const passed = (id: string): StepResult => ({ step: step(id), status: 'PASSED', evidence: evidence() });
const failed = (id: string): StepResult => ({
  step: step(id),
  status: 'FAILED',
  evidence: evidence(),
  why: 'the server answered with a shape nobody expected',
});
const notRun = (id: string): StepResult => ({
  step: step(id),
  status: 'NOT_RUN',
  reason: 'NOT_PROVISIONED',
  missing: ['baseUrl'],
  detail: 'Not provisioned: baseUrl.',
});

const report = (steps: readonly StepResult[]): E2eReport =>
  summarize(steps, ENVIRONMENT, GAPS, 'test');

describe('an E2E that did not run', () => {
  it('is NOT_RUN, not PASSED, when nothing executed', () => {
    const result = report([notRun('a'), notRun('b')]);
    expect(result.outcome).toBe('NOT_RUN');
    expect(result.counts.passed).toBe(0);
    expect(exitCodeFor(result.outcome)).not.toBe(0);
    expect(result.headline).toContain('Nothing about the system under test has been established');
  });

  it('is PARTIAL, not PASSED, when only some steps executed', () => {
    const result = report([passed('a'), notRun('b')]);
    expect(result.outcome).toBe('PARTIAL');
    // The exact sentence someone might quote out of context has to carry the
    // caveat with it, because the quote is what travels.
    expect(result.headline).toContain('This is not a passing end-to-end.');
    expect(exitCodeFor(result.outcome)).toBe(HARNESS_EXIT.PARTIAL);
  });

  it('carries no evidence field at all, so "passed without running" is unrepresentable', () => {
    const result = report([notRun('a')]);
    const only = result.steps[0];
    expect(only?.status).toBe('NOT_RUN');
    expect(only).not.toHaveProperty('evidence');
  });

  it('names the gaps responsible rather than saying "skipped"', () => {
    const only = report([notRun('a')]).steps[0];
    expect(only?.status === 'NOT_RUN' ? only.missing : []).toEqual(['baseUrl']);
  });
});

describe('a mock standing in for a live path', () => {
  it('voids the whole report, even when every step passed', () => {
    const stubbed: StepResult = {
      step: step('a'),
      status: 'PASSED',
      evidence: evidence('STUB'),
    };
    const result = report([stubbed, passed('b')]);
    // Not PASSED, and not PARTIAL either: a report containing a fabricated run
    // establishes nothing at all, including about the steps that were real.
    expect(result.outcome).toBe('INVALID');
    expect(result.headline).toContain('A mock cannot stand in for a live path');
    expect(exitCodeFor(result.outcome)).toBe(HARNESS_EXIT.INVALID);
  });

  it('outranks a genuine failure, because the failure might be the stub talking', () => {
    const result = report([{ step: step('a'), status: 'PASSED', evidence: evidence('STUB') }, failed('b')]);
    expect(result.outcome).toBe('INVALID');
  });
});

describe('the overall verdict', () => {
  it('exits 0 only when every step ran against the real thing and was correct', () => {
    const result = report([passed('a'), passed('b')]);
    expect(result.outcome).toBe('PASSED');
    expect(exitCodeFor(result.outcome)).toBe(0);
  });

  it('is FAILED when something ran and was wrong', () => {
    const result = report([passed('a'), failed('b'), notRun('c')]);
    expect(result.outcome).toBe('FAILED');
    expect(result.counts).toEqual({ passed: 1, failed: 1, notRun: 1 });
  });

  it('gives 0 to nothing except PASSED', () => {
    for (const [outcome, code] of Object.entries(HARNESS_EXIT)) {
      expect(code === 0, outcome).toBe(outcome === 'PASSED');
    }
  });
});
