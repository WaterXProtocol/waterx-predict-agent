#!/usr/bin/env node
/**
 * Run the release preflight over this workspace.
 *
 *   waterx-predict-release-preflight [--strict]
 *
 * Exit 0 when everything checked passed. Exit 1 on any failure, and — with
 * `--strict` — on any unresolved check. The release workflow runs `--strict`.
 */
import { exitCodeFor, formatReport, runPreflight } from '../preflight.ts';

const strict = process.argv.slice(2).includes('--strict');
const report = runPreflight();

process.stdout.write(formatReport(report, strict));
process.exitCode = exitCodeFor(report, strict);
