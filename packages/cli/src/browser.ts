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

/* ── Opening by default, and the memory that makes it bearable ─────────────── */

/**
 * Whether something in the environment says not to open a browser here.
 *
 * The escape hatch that makes opening-by-default defensible: a server, a
 * container and a CI runner have no browser and nobody watching, and they are
 * exactly the places that set these. `resolveOpener` already refuses CI and a
 * Linux host with no display; this is the explicit "don't", for a machine that
 * looks openable and is not.
 */
export const browserSuppressed = (
  env: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  const value = env['WATERX_PREDICT_NO_BROWSER'];
  const on = value !== undefined && value.trim() !== '' && value.trim() !== '0' && value.trim().toLowerCase() !== 'false';
  return on ? 'WATERX_PREDICT_NO_BROWSER is set' : undefined;
};

/**
 * How long an opened link stays opened.
 *
 * `onboard --wait` is run again constantly — the agent asks `next`, is told to
 * wait, the wait runs out, it asks again — and opening every time turns a
 * five-minute wait into twenty tabs of one page.
 */
export const REOPEN_AFTER_MS = 30 * 60_000;

export interface OpenMemoryIo {
  readFile(path: string): string | null;
  writeFile(path: string, contents: string): void;
  now(): number;
}

/** Whether this exact link was opened from this machine recently enough not to open again. */
export function openedRecently(path: string, url: string, io: OpenMemoryIo): boolean {
  let opened: Record<string, unknown>;
  try {
    const raw = io.readFile(path);
    if (raw === null) return false;
    opened = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // An unreadable memory counts as no memory. The worst that does is open
    // one more tab, which is not worth a failure.
    return false;
  }
  const at = opened[url];
  return typeof at === 'number' && io.now() - at < REOPEN_AFTER_MS;
}

/** Writes it down. Never throws: this is a convenience, not a record. */
export function rememberOpened(path: string, url: string, io: OpenMemoryIo): void {
  try {
    const raw = io.readFile(path);
    const opened = raw === null ? {} : (JSON.parse(raw) as Record<string, unknown>);
    io.writeFile(path, `${JSON.stringify({ ...opened, [url]: io.now() })}\n`);
  } catch {
    /* the link was still opened; only the memory of it is lost */
  }
}
