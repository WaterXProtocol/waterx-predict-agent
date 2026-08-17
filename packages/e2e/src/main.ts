#!/usr/bin/env node
/**
 * The `waterx-predict-e2e` binary.
 *
 * Thin on purpose — everything worth testing is in `run.ts`, `report.ts` and
 * `options.ts`. stdout carries exactly one JSON report; stderr carries the human
 * account of it, including the provisioning list.
 *
 * `process.exitCode` rather than `process.exit()`, so the report finishes
 * writing. 0 means PASSED and only PASSED: 10 PARTIAL, 11 NOT RUN, 12 FAILED,
 * 70 INVALID.
 */
import { parseOptions, USAGE } from './options.ts';
import { render } from './render.ts';
import { exitCodeFor, HARNESS_EXIT } from './report.ts';
import { runE2e } from './run.ts';

const options = parseOptions(process.argv.slice(2));

if (options === 'HELP') {
  process.stderr.write(USAGE);
} else {
  try {
    const report = await runE2e(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(render(report));
    process.exitCode = exitCodeFor(report.outcome);
  } catch (error: unknown) {
    // The harness itself broke. That is not a verdict about the system under
    // test, so it is INVALID rather than FAILED, and nothing is written to
    // stdout — a partial report would be read as a real one.
    process.stderr.write(
      `waterx-predict-e2e: the harness failed before it could report: ${
        error instanceof Error ? error.message : 'unknown error'
      }\n`,
    );
    process.exitCode = HARNESS_EXIT.INVALID;
  }
}
