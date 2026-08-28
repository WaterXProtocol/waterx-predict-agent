/**
 * Whether this machine may be asked to open a link.
 *
 * All refusals, which is the point. `--open` is a convenience for one case —
 * the operator and the account owner being the same person at the same desk —
 * and every case this rejects is one where a spawn would either fail obscurely
 * or open a window nobody is sitting in front of.
 */
import { describe, expect, it } from 'vitest';

import { resolveOpener } from '../src/browser.ts';

const URL = 'https://testnet.waterx.app/agent/authorize?agent=0x00';

describe('resolveOpener', () => {
  it('uses the platform opener on a desktop', () => {
    expect(resolveOpener('darwin', {}, URL)).toEqual({
      kind: 'spawn',
      command: 'open',
      args: [URL],
    });
    expect(resolveOpener('linux', { DISPLAY: ':0' }, URL)).toEqual({
      kind: 'spawn',
      command: 'xdg-open',
      args: [URL],
    });
    expect(resolveOpener('linux', { WAYLAND_DISPLAY: 'wayland-0' }, URL).kind).toBe('spawn');
  });

  it('refuses a Linux session with no display to open onto', () => {
    // `xdg-open` there either fails obscurely or picks a terminal browser
    // nobody is watching, and both look to an operator like it worked.
    const decision = resolveOpener('linux', {}, URL);
    expect(decision.kind).toBe('refused');
    expect(decision.kind === 'refused' && decision.reason).toMatch(/DISPLAY/u);
  });

  it('refuses automation, whatever the platform says it could do', () => {
    // A pipeline has no display, and an opener that blocks waiting for one is a
    // build that hangs until somebody kills it.
    for (const env of [{ CI: 'true' }, { CONTINUOUS_INTEGRATION: '1' }]) {
      for (const platform of ['darwin', 'linux'] as const) {
        const decision = resolveOpener(platform, env, URL);
        expect(decision.kind, `${platform} ${JSON.stringify(env)}`).toBe('refused');
      }
    }
  });

  it('refuses a platform nothing here has run on, rather than guessing', () => {
    // Windows is unverified for this runtime (ADR-0002). Naming an opener for
    // it would be a guess that fails in front of somebody instead of here.
    const decision = resolveOpener('win32', {}, URL);
    expect(decision.kind).toBe('refused');
    expect(decision.kind === 'refused' && decision.reason).toContain('win32');
  });

  it('passes the url through untouched', () => {
    // Query string intact: the agent address and the label live in it, and a
    // mangled one authorizes the wrong agent or none.
    const decision = resolveOpener('darwin', {}, URL);
    expect(decision.kind === 'spawn' && decision.args).toEqual([URL]);
  });
});
