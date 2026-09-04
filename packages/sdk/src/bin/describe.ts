#!/usr/bin/env node
/**
 * `npx @waterx/predict-agent-sdk` — what did I just install, and what does it
 * still need?
 *
 * The zero-install discovery entry point. The CLI's `describe` is the canonical
 * one and it is not published (ADR-0009 D-28), so until it is, the only package
 * an agent can actually reach has to be able to answer for itself. It runs with
 * no configuration, no network and no signer, which is the state a caller is in
 * at the exact moment they need the answer.
 *
 * One JSON document on stdout, human lines on stderr — the CLI's discipline, for
 * the same reason: a caller that parses stdout must never have to strip prose out
 * of it, and a person watching a terminal should not have to read JSON.
 *
 * It cannot trade. There is no client here, no transport imported and nothing to
 * authenticate with, and `tests/workspace.test.ts` fails if that changes. A
 * discovery command that could place an order is a second trading surface with
 * none of the command core's policy, approval or idempotency attached to it.
 */
import { describeInstallation, type InstallationReport } from '../installation.ts';

/** The CLI's `CONFIG` code. A different number for the same fact helps nobody. */
const EXIT_CONFIG = 3;

const line = (text: string): void => {
  process.stderr.write(`${text}\n`);
};

function summarize(report: InstallationReport): void {
  const name = report.package?.name ?? '@waterx/predict-agent-sdk';
  line(`${name}${report.package === undefined ? '' : ` ${report.package.version}`}`);

  if (report.instructionsPath === undefined) {
    line('');
    line('The agent instructions were not found beside this module. Read them at');
    line('agent-instructions/AGENT_INSTRUCTIONS.md in the repository instead.');
  } else {
    line('');
    line('Read the operating rules before the first order:');
    line(`  ${report.instructionsPath}`);
  }

  if (report.recipesPath !== undefined) {
    line('');
    line('Runnable recipes for the reads and the write, so nothing has to be composed:');
    line(`  ${report.recipesPath}`);
  }

  const cli = report.surfaces.find((surface) => surface.id === 'cli');
  if (cli !== undefined && cli.present === false) {
    line('');
    line('The `waterx-predict` CLI is not on PATH, so this machine holds the library');
    line('only: the composed commands are out of reach. That is NOT a statement about');
    line('whether this agent may trade.');
  }

  // Said on every run, present CLI or absent. The question "can I actually place
  // an order from here" was being answered by looking at PATH, and PATH has
  // nothing to do with it.
  line('');
  line('What gates a write from this library:');
  line(`  ${report.writes.gatedBy} — settle it with \`${report.writes.settleWith}\``);
  line('  The CLI\'s execution policy and its POLICY_DENIED refusal are enforced inside');
  line('  that CLI\'s process. They are not conditions this API imposes on this package.');

  if (report.missing.length > 0) {
    line('');
    line(`Missing (${String(report.missing.length)}):`);
    for (const requirement of report.missing) {
      line(`  ${requirement.title} — ${requirement.suppliedBy}`);
      line(`    ${requirement.supplyWith[0] ?? ''}`);
    }
  }

  if (report.unchecked.length > 0) {
    line('');
    line(`Not checked here (${String(report.unchecked.length)}), because settling them needs an`);
    line('authenticated read and this command issues none:');
    for (const requirement of report.unchecked) {
      line(`  ${requirement.title} — ${requirement.suppliedBy}`);
    }
  }

  if (report.nextStep.action !== '') {
    line('');
    line(`Next — ${report.nextStep.actor}: ${report.nextStep.action}`);
  }
}

const report = describeInstallation();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
summarize(report);

/**
 * Non-zero while something is missing.
 *
 * A fresh install legitimately exits non-zero here, which is the point: a script
 * that runs this after `npm install` should stop, and an agent that ignores the
 * body still cannot read the exit code as "ready". `UNCHECKED` never contributes
 * — nothing was looked at, so there is nothing to fail on.
 */
process.exitCode = report.missing.length > 0 ? EXIT_CONFIG : 0;
