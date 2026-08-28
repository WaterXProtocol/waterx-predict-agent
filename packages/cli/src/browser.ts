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

export function resolveOpener(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  url: string,
): OpenerDecision {
  if (isAutomation(env)) {
    return { kind: 'refused', reason: 'this looks like an automated environment (CI is set)' };
  }

  switch (platform) {
    case 'darwin':
      return { kind: 'spawn', command: 'open', args: [url] };
    case 'linux': {
      // Without one of these there is no session to open onto, and `xdg-open`
      // either fails obscurely or picks a terminal browser nobody is watching.
      const display = (env.DISPLAY ?? '') !== '' || (env.WAYLAND_DISPLAY ?? '') !== '';
      return display
        ? { kind: 'spawn', command: 'xdg-open', args: [url] }
        : { kind: 'refused', reason: 'no DISPLAY or WAYLAND_DISPLAY is set' };
    }
    default:
      // Windows is unverified for this runtime (ADR-0002), and naming an opener
      // for a platform nothing here has run on would be a guess that fails in
      // front of somebody rather than here.
      return { kind: 'refused', reason: `opening a browser is not supported on ${platform}` };
  }
}
