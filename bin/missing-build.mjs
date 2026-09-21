/**
 * What both binaries say when this package installed without its build.
 *
 * `prepare` compiles the workspace at install time (ADR-0019), and npm ≥ 11
 * prints `npm warn allow-scripts` about it. Measured on npm 11.16.0 that notice
 * is bookkeeping and the build runs — but where install scripts are actually
 * refused (`--ignore-scripts`, an approval policy that is never answered, a
 * locked-down CI), the package installs "successfully" with no `dist/` and
 * nothing says so.
 *
 * What the caller got then, measured twice on a packed install with scripts
 * off: an `ERR_MODULE_NOT_FOUND` stack naming a path inside `node_modules`,
 * EMPTY stdout, and exit 1 — the code this contract reserves for "this process
 * fell over" (`exit-codes.ts`), so an automated caller could not tell an
 * unbuilt install from a crash. On the very first command.
 *
 * THE REMEDIES ARE THE MEASURED ONES, which are not the obvious ones:
 *
 * - `npm rebuild waterx-predict-agent-runtime` reports "rebuilt dependencies
 *   successfully" and produces no `dist/`. Rebuild does not run `prepare`.
 * - Re-installing a packed tarball OF THIS REPOSITORY does not either: npm runs
 *   `prepare` for a git dependency and a directory, not for a tarball.
 * - Re-running `npm install github:WaterXProtocol/waterx-predict-agent` does
 *   work, which is what the message leads with.
 *
 * This file is loaded only on that path. It imports nothing but Node, because
 * everything else in this package is the thing that is missing.
 */

/** Everything after the binary name, as a person typed it. */
const invocationOf = (argv) => argv.filter((argument) => !argument.startsWith('-')).join(' ');

/**
 * Reports the missing build and exits 3.
 *
 * @param {{ argv: string[], envelope?: (invocation: string) => unknown, binary?: string }} options
 *   `envelope` is the JSON document to write when `--json` was asked for. The
 *   keystore has no envelope contract, so it passes none and gets stderr alone.
 */
export function reportMissingBuild({ argv, envelope, binary = 'waterx-predict' }) {
  if (envelope !== undefined && argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(envelope(invocationOf(argv)), null, 2)}\n`);
  }
  process.stderr.write(
    `${binary}: this package installed without its build, so there is nothing to run.\n` +
      '  The compile happens in the `prepare` script at install time, and it did not run here.\n' +
      '  This fixes it:\n' +
      '    npm install github:WaterXProtocol/waterx-predict-agent   # a git install runs prepare\n' +
      '  If your npm holds install scripts for approval, answer it first:\n' +
      '    npm approve-scripts waterx-predict-agent-runtime\n' +
      '  These do NOT fix it, measured: `npm rebuild` (it runs no prepare and reports success),\n' +
      '  and re-installing a packed tarball of this repository (npm runs prepare for a git\n' +
      '  dependency, not for a tarball).\n',
  );
  process.exit(3);
}
