/**
 * Running the ONE command in this harness that is not the CLI: the operator's
 * Runner restart.
 *
 * Crash recovery cannot be demonstrated without a crash, and nothing in this
 * build supervises the daemon — so the restart is the operator's, supplied
 * explicitly with `--runner-restart`, and run here rather than invented. What
 * this module refuses to do is as much the point as what it does:
 *
 *  - it never constructs a way to stop a Runner. No `pkill`, no signal, no
 *    guessed pid file. A harness that killed a process it did not start would be
 *    killing whatever else happened to match;
 *  - it never backgrounds anything. The child is awaited with a bound and killed
 *    if it outstays it, so nothing this harness spawns outlives the run;
 *  - it captures the child's output instead of letting it inherit stdout. stdout
 *    carries exactly one JSON report, and a restart command that printed a banner
 *    would corrupt it.
 */
import { spawn } from 'node:child_process';

export interface ExternalResult {
  readonly exitCode: number;
  /** Trimmed and truncated: enough to explain a failure, not a log dump. */
  readonly output: string;
}

export interface ExternalRunner {
  (command: string): Promise<ExternalResult>;
}

const MAX_OUTPUT = 2_000;

/**
 * Run one operator-supplied shell command and wait for it.
 *
 * Through `sh -c` because that is the form the operator wrote it in — a service
 * manager invocation is rarely one bare executable. It is the operator's own
 * string, given on their own command line, and it runs with their privileges and
 * nobody else's.
 */
export const shellRunner =
  (timeoutMs: number): ExternalRunner =>
  (command) =>
    new Promise<ExternalResult>((resolve) => {
      const child = spawn('/bin/sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });

      let output = '';
      const collect = (chunk: string): void => {
        if (output.length < MAX_OUTPUT) output += chunk;
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      timer.unref?.();

      // A spawn failure is reported as a result rather than thrown: "your restart
      // command does not exist" is a fact about provisioning, and the step it
      // belongs to should say so instead of the harness dying mid-report.
      child.on('error', (error: Error) => {
        clearTimeout(timer);
        resolve({ exitCode: 127, output: error.message });
      });

      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        resolve({
          exitCode: timedOut ? 124 : (code ?? -1),
          output: timedOut
            ? `${output.trim()}\n(killed after ${timeoutMs}ms — a restart command must return by itself)`.trim()
            : output.trim().slice(0, MAX_OUTPUT),
        });
      });
    });
