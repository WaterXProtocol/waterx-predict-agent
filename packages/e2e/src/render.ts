/**
 * The report as text, for stderr.
 *
 * stdout carries the machine report and nothing else, so this is free to be
 * long. It is deliberately long: the useful output of a run that could NOT
 * happen is the provisioning list, and a list nobody can act on is not a
 * deliverable. Each unsatisfied gap prints who supplies it, how, and what would
 * settle it.
 *
 * Nothing here prints a value that could be a secret. Base URL, environment
 * label, account id and wallet ADDRESS are configuration; tokens, signatures and
 * keys are not rendered anywhere, and the harness never holds one.
 */
import { getGap, type GapState } from './gaps.ts';
import type { E2eReport, StepResult } from './report.ts';

const MARK: Record<StepResult['status'], string> = {
  PASSED: 'PASS   ',
  FAILED: 'FAIL   ',
  NOT_RUN: 'NOT RUN',
};

const GAP_MARK: Record<GapState['status'], string> = {
  SATISFIED: 'ok       ',
  MISSING: 'MISSING  ',
  UNCHECKED: 'UNCHECKED',
};

export function render(report: E2eReport): string {
  const lines: string[] = [];
  const write = (line = ''): void => void lines.push(line);

  write(`${report.harness} — ${report.outcome}`);
  write(report.headline);
  write();

  write('Environment');
  write(`  base URL      ${report.environment.baseUrl ?? '(not configured)'}`);
  write(`  label         ${report.environment.label ?? '(not configured)'}`);
  write(`  config file   ${report.environment.configFile ?? '(none)'}`);
  for (const [index, permission] of report.environment.writes.entries()) {
    write(
      `  ${index === 0 ? 'writes      ' : '            '}  ${permission.capability.padEnd(10)} ${
        permission.permitted ? 'PERMITTED' : 'WITHHELD'
      }`,
    );
    if (permission.withheldBecause !== null) write(`                ${permission.withheldBecause}`);
  }
  write();

  write('Steps');
  for (const result of report.steps) {
    write(
      `  ${MARK[result.status]}  ${result.step.title}${
        result.step.writes === null ? '' : `  [WRITE: ${result.step.writes}]`
      }`,
    );
    if (result.status === 'FAILED') write(`           ↳ ${result.why}`);
    if (result.status === 'NOT_RUN') write(`           ↳ ${result.reason}: ${result.detail}`);
  }
  write();

  write('Provisioning');
  for (const state of report.provisioning) {
    const gap = getGap(state.id);
    write(`  ${GAP_MARK[state.status]}  ${state.id} — ${gap.title}`);
    write(`             ${state.observed}`);
  }

  const outstanding = report.provisioning.filter((state) => state.status !== 'SATISFIED');
  if (outstanding.length > 0) {
    write();
    write(`Who must supply what (${outstanding.length} outstanding)`);
    for (const state of outstanding) {
      const gap = getGap(state.id);
      write();
      write(
        `  ${gap.id} — ${gap.title}  [${gap.suppliedBy}${gap.ownerAuthenticated ? ', OWNER-AUTHENTICATED' : ''}]`,
      );
      write(`    why       ${gap.why}`);
      for (const [index, how] of gap.supplyWith.entries()) {
        write(`    ${index === 0 ? 'supply' : '      '}    ${how}`);
      }
      write(`    settled   ${gap.settledBy}`);
    }
  }

  write();
  write(
    `${report.counts.passed} passed, ${report.counts.failed} failed, ${report.counts.notRun} not run.`,
  );
  return `${lines.join('\n')}\n`;
}
