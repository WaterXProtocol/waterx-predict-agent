/**
 * `policy` and `policy set` — the decision that turns writes on, and the bounds
 * on who may take it.
 *
 * Two properties are the whole point. The chooser shows all THREE modes with
 * what each allows, because the mode a sentence happens to name is the mode a
 * relaying agent hands over. And widening is a person's act: `--yes` is a
 * dispatcher flag, unreachable from `--input <json>`, so a model host cannot
 * both propose the change and consent to it (ADR-0021).
 */
import { describe, expect, it } from 'vitest';

import { invoke, type InvokeOptions } from './harness.ts';

const HOME = '/home/op';
const CONFIG = `${HOME}/.config/waterx-predict/config.json`;
const ACCOUNT = `0x${'c'.repeat(63)}2`;

const SCOPE = {
  accounts: [ACCOUNT],
  sides: ['BUY'],
  maxBuyAmount: '25',
  maxCumulativeBuyAmount: '100',
  maxSlippageBps: 100,
  maxLegs: 1,
  notAfter: '2099-01-01T00:00:00.000Z',
};

const run = async (argv: readonly string[], options: InvokeOptions = {}) =>
  await invoke(argv, { homeDir: HOME, env: {}, ...options });

interface Choice {
  mode: string;
  current: boolean;
  means: string;
  costs: string;
  command: string;
  requires?: string;
}
interface Chooser {
  current: { mode: string; source: string; hasScope: boolean };
  choices: Choice[];
  configFile: string | null;
  who: string;
}
interface SetResult {
  configFile: string;
  mode: string;
  previous: string;
  changed: boolean;
  widened: boolean;
  shadowedBy?: string;
  warning?: string;
  realFunds?: string;
}

describe('the policy chooser', () => {
  it('shows all three, in rank order, each with what it allows and the command that takes it', async () => {
    const answer = (await run(['policy'])).envelope.data as Chooser;
    expect(answer.choices.map((choice) => choice.mode)).toEqual([
      'read-only',
      'interactive',
      'delegated-auto',
    ]);
    for (const choice of answer.choices) {
      expect(choice.means.length, choice.mode).toBeGreaterThan(0);
      expect(choice.costs.length, choice.mode).toBeGreaterThan(0);
      // A command split across a terminal wrap is one nobody can copy, so each
      // is a field of its own and carries no newline.
      expect(choice.command, choice.mode).toMatch(/^waterx-predict policy set --mode /u);
      expect(choice.command, choice.mode).not.toContain('\n');
    }
    expect(answer.who).toBe('AGENT_OPERATOR');
  });

  it('asks for --yes exactly where the choice widens what may be signed', async () => {
    const fromInteractive = (await run(['policy'], { env: { WATERX_PREDICT_POLICY: 'interactive' } }))
      .envelope.data as Chooser;
    const by = (rows: Choice[], mode: string): Choice | undefined => rows.find((row) => row.mode === mode);
    // Turning writes off is never something to confirm.
    expect(by(fromInteractive.choices, 'read-only')?.command).not.toContain('--yes');
    expect(by(fromInteractive.choices, 'delegated-auto')?.command).toContain('--yes');

    const fromReadOnly = (await run(['policy'], { env: { WATERX_PREDICT_POLICY: 'read-only' } }))
      .envelope.data as Chooser;
    expect(by(fromReadOnly.choices, 'interactive')?.command).toContain('--yes');
  });

  it('names the prerequisite where the option is offered, not at the refusal', async () => {
    const answer = (await run(['policy'])).envelope.data as Chooser;
    const auto = answer.choices.find((choice) => choice.mode === 'delegated-auto');
    expect(auto?.requires).toMatch(/policy\.scope/u);
    expect(auto?.requires).toMatch(/maxCumulativeBuyAmount/u);

    const scoped = (await run(['policy'], {
      files: { [CONFIG]: JSON.stringify({ policy: { mode: 'interactive', scope: SCOPE } }) },
    })).envelope.data as Chooser;
    expect(scoped.current.hasScope).toBe(true);
    expect(scoped.choices.find((choice) => choice.mode === 'delegated-auto')?.requires).toBeUndefined();
  });

  it('changes nothing', async () => {
    const answer = await run(['policy']);
    expect(answer.secretWrites).toEqual([]);
    expect(answer.fetches).toEqual([]);
    expect(answer.signerRuns).toEqual([]);
  });
});

describe('setting the policy', () => {
  it('narrows without ceremony', async () => {
    const answer = await run(['policy', 'set', '--mode', 'read-only'], {
      env: { WATERX_PREDICT_POLICY: 'interactive' },
      files: { [CONFIG]: JSON.stringify({ policy: { mode: 'interactive' } }) },
    });
    expect(answer.envelope.ok).toBe(true);
    const data = answer.envelope.data as SetResult;
    expect(data.mode).toBe('read-only');
    expect(data.widened).toBe(false);
    expect(JSON.parse(answer.secretWrites[0]?.contents ?? '{}')).toMatchObject({
      policy: { mode: 'read-only' },
    });
  });

  it('refuses to widen without a person saying so, and names the command that says it', async () => {
    const answer = await run(['policy', 'set', '--mode', 'interactive'], {
      files: { [CONFIG]: JSON.stringify({ policy: { mode: 'read-only' } }) },
    });
    expect(answer.envelope.ok).toBe(false);
    expect(answer.envelope.error?.code).toBe('POLICY_DENIED');
    expect(answer.envelope.error?.message).toContain('--yes');
    expect(answer.secretWrites).toEqual([]);
  });

  it('widens when it is confirmed, and keeps the scope it did not touch', async () => {
    const answer = await run(['policy', 'set', '--mode', 'interactive', '--yes'], {
      files: { [CONFIG]: JSON.stringify({ policy: { mode: 'read-only', scope: SCOPE }, environment: 'testnet' }) },
    });
    const data = answer.envelope.data as SetResult;
    expect(data.widened).toBe(true);
    expect(data.previous).toBe('read-only');
    const written = JSON.parse(answer.secretWrites[0]?.contents ?? '{}') as {
      policy: { mode: string; scope: unknown };
      environment: string;
    };
    expect(written.policy.mode).toBe('interactive');
    // The scope is the operator's document, and the cumulative budget is
    // counted against it — rewriting it from a mode change would reset that.
    expect(written.policy.scope).toEqual(SCOPE);
    expect(written.environment).toBe('testnet');
  });

  it('refuses delegated-auto with no scope, rather than letting someone walk into it', async () => {
    const answer = await run(['policy', 'set', '--mode', 'delegated-auto', '--yes'], {
      files: { [CONFIG]: JSON.stringify({ policy: { mode: 'interactive' } }) },
    });
    expect(answer.envelope.ok).toBe(false);
    expect(answer.envelope.error?.code).toBe('NOT_CONFIGURED');
    expect(answer.envelope.error?.message).toMatch(/maxCumulativeBuyAmount/u);
    expect(answer.secretWrites).toEqual([]);
  });

  it('takes delegated-auto once the scope is there', async () => {
    const answer = await run(['policy', 'set', '--mode', 'delegated-auto', '--yes'], {
      files: { [CONFIG]: JSON.stringify({ policy: { mode: 'interactive', scope: SCOPE } }) },
    });
    expect(answer.envelope.ok).toBe(true);
    expect((answer.envelope.data as SetResult).mode).toBe('delegated-auto');
  });

  it('says when the environment will keep shadowing what it just wrote', async () => {
    const answer = await run(['policy', 'set', '--mode', 'read-only'], {
      env: { WATERX_PREDICT_POLICY: 'interactive' },
      files: { [CONFIG]: JSON.stringify({ policy: { mode: 'interactive' } }) },
    });
    const data = answer.envelope.data as SetResult;
    expect(data.shadowedBy).toBe('ENVIRONMENT');
    expect(data.warning).toMatch(/WATERX_PREDICT_POLICY/u);
  });

  it('cannot be confirmed from the input document', async () => {
    // `--yes` is a dispatcher flag. A model host reaches this CLI through
    // `--input <json>`, and a confirmation carried there would let one
    // generated document both propose the change and agree to it.
    const answer = await run(['policy', 'set', '--input', JSON.stringify({ mode: 'interactive', yes: true })], {
      files: { [CONFIG]: JSON.stringify({ policy: { mode: 'read-only' } }) },
    });
    expect(answer.envelope.ok).toBe(false);
    expect(answer.envelope.error?.code).toBe('INVALID_INPUT');
    expect(answer.secretWrites).toEqual([]);
  });
});
