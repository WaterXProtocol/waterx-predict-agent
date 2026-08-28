/**
 * Whether this machine can be asked to open a link, and with what.
 *
 * Split from the spawning so the decision is testable without launching
 * anything: a test that had to open a real browser to check "refuses on a
 * headless host" would be a test nobody runs twice.
 *
 * The refusals are the substance. `--open` is a convenience for the one case
 * where the operator and the account owner are the same person at the same
 * desk; every other case either has no display to open onto, or has a person
 * somewhere else who is the one that must see the page. Guessing wrong is not
 * expensive, but silently doing nothing is — an operator who believes a browser
 * opened waits for a window that will never appear.
 */
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

export type OpenerDecision =
  | { readonly kind: 'spawn'; readonly command: string; readonly args: readonly string[] }
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * `CI` is set by every mainstream runner and by nothing else that matters here.
 * A pipeline has no display, and an `xdg-open` that blocks on one is a build
 * that hangs until it is killed.
 */
const isAutomation = (env: Readonly<Record<string, string | undefined>>): boolean =>
  (env.CI ?? '') !== '' || (env.CONTINUOUS_INTEGRATION ?? '') !== '';

/** The default `isInstalled`: an executable of that name somewhere on PATH. */
const onPath = (command: string): boolean => {
  const raw = process.env.PATH;
  if (raw === undefined || raw === '') return false;
  return raw.split(delimiter).some((directory) => {
    if (directory === '') return false;
    try {
      accessSync(join(directory, command), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
};

export function resolveOpener(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  url: string,
  /**
   * Is this opener actually installed?
   *
   * Checked BEFORE anything is claimed, because a spawn failure arrives on the
   * child's `error` event — asynchronously, after the caller has already told
   * somebody their browser is opening. `xdg-open` is a package a minimal Linux
   * image routinely lacks, so this is the common failure rather than an exotic
   * one. Injected so the check is testable without a filesystem.
   */
  isInstalled: (command: string) => boolean = onPath,
): OpenerDecision {
  if (isAutomation(env)) {
    return { kind: 'refused', reason: 'this looks like an automated environment (CI is set)' };
  }

  const spawnable = (command: string): OpenerDecision =>
    isInstalled(command)
      ? { kind: 'spawn', command, args: [url] }
      : { kind: 'refused', reason: `\`${command}\` is not installed on this machine` };

  switch (platform) {
    case 'darwin':
      return spawnable('open');
    case 'linux': {
      // Without one of these there is no session to open onto, and `xdg-open`
      // either fails obscurely or picks a terminal browser nobody is watching.
      const display = (env.DISPLAY ?? '') !== '' || (env.WAYLAND_DISPLAY ?? '') !== '';
      return display
        ? spawnable('xdg-open')
        : { kind: 'refused', reason: 'no DISPLAY or WAYLAND_DISPLAY is set' };
    }
    default:
      // Windows is unverified for this runtime (ADR-0002), and naming an opener
      // for a platform nothing here has run on would be a guess that fails in
      // front of somebody rather than here.
      return { kind: 'refused', reason: `opening a browser is not supported on ${platform}` };
  }
}
