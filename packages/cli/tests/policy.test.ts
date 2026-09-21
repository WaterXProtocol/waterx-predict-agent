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

import { ACCOUNT_ID, AUTH_OK, CONFIGURED_ENV, invoke, type InvokeOptions } from './harness.ts';

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

describe('the chooser as a person reads it', () => {
  const screen = async (options: InvokeOptions = {}): Promise<string> =>
    (await run(['policy'], options)).stderr;

  it('prints all three, marks the current one, and never wraps a command', async () => {
    // The person making this decision is at a terminal. Before this, `policy`
    // answered only in JSON and the agent relaying it built its own table —
    // a paraphrase of three descriptions of what may be signed with real
    // money (ADR-0026).
    const text = await screen();
    for (const mode of ['read-only', 'interactive', 'delegated-auto']) {
      expect(text, mode).toContain(mode);
    }
    expect(text).toContain("Pick one. This is a person's decision, not the agent's:");
    // The current one is marked, and only it.
    const marked = text.split('\n').filter((line) => line.includes('\u2192'));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain('read-only');

    // Every command is on a line of its own, unwrapped and copyable.
    for (const mode of ['read-only', 'interactive', 'delegated-auto']) {
      const command = `waterx-predict policy set --mode ${mode}`;
      const line = text.split('\n').find((row) => row.includes(command));
      expect(line, mode).toBeDefined();
      expect(line?.trim().startsWith('waterx-predict'), mode).toBe(true);
    }
  });

  it('keeps every line inside a terminal', async () => {
    // A sentence that wraps is ugly; a command that wraps cannot be copied.
    // The only lines allowed past 80 are commands, which are never broken.
    for (const line of (await screen()).split('\n')) {
      if (line.includes('waterx-predict')) continue;
      expect(line.length, line).toBeLessThanOrEqual(80);
    }
  });

  it('says what it would cost to take each one', async () => {
    const text = await screen();
    expect(text.match(/costs:/gu) ?? []).toHaveLength(3);
    // …and, for the one that cannot be taken yet, what it needs first.
    expect(text).toMatch(/needs a `policy\.scope`/u);
  });

  it('says whose choice it is and where it is recorded', async () => {
    const text = await screen();
    expect(text).toMatch(/chosen by\s+nobody: this is the default/u);
    expect(text).toContain(CONFIG);
    // On mainnet, what is at stake is on the first line.
    expect(text).toMatch(/policy\s+read-only \u2014 on mainnet, where an order spends real funds/u);
  });

  it('survives the pipe a host actually uses', async () => {
    // `| head -40` is what a session reached for. The screen is on stderr and
    // comes first, so the three options and their commands are inside the
    // first 40 lines even when the JSON below is cut off.
    const head = (await screen()).split('\n').slice(0, 40).join('\n');
    for (const mode of ['read-only', 'interactive', 'delegated-auto']) {
      expect(head, mode).toContain(`--mode ${mode}`);
    }
  });
});

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

/**
 * The pointer every envelope carries (ADR-0022).
 *
 * It is a promise about COPYING: whatever is in `meta.nextCommand` runs exactly
 * as printed. The two things that must never be in it are the two a host must
 * not supply on its own — a value only a person can choose, and a person's
 * consent.
 */
describe('where an answer points next', () => {
  it('never points at a command that needs a person’s consent', async () => {
    const refused = await run(['policy', 'set', '--mode', 'interactive'], {
      files: { [CONFIG]: JSON.stringify({ policy: { mode: 'read-only' } }) },
    });
    // The refusal names `--yes` in its message, where a person reads it…
    expect(refused.envelope.error?.message).toContain('--yes');
    // …and the pointer does not, because that is the one thing a host must not
    // add on its own initiative.
    expect(refused.envelope.meta?.nextCommand).not.toContain('--yes');
    expect(refused.envelope.meta?.nextCommand).toBe('waterx-predict next');
  });

  it('points onward from the chooser rather than at one of the three', async () => {
    const answer = await run(['policy']);
    expect(answer.envelope.meta?.nextCommand).toBe('waterx-predict next');
  });

  it('points at `next` once a setting has landed', async () => {
    const answer = await run(['policy', 'set', '--mode', 'read-only'], {
      files: { [CONFIG]: JSON.stringify({ policy: { mode: 'interactive' } }) },
    });
    expect(answer.envelope.meta?.nextCommand).toBe('waterx-predict next');
  });
});

/**
 * The choice that comes right after the signature (ADR-0025).
 *
 * Two permissions, not one: the OWNER grants this agent a delegation, and the
 * OPERATOR decides what this runtime may sign with it. The second one is due
 * the moment the first lands — on mainnet the default is read-only, so an
 * agent that has just been authorized still cannot place an order, and saying
 * "authorized" without saying that is the half-truth that wastes somebody's
 * afternoon.
 */
describe('after the owner signs', () => {
  it('tells the operator what is still missing, and does not claim it may trade', async () => {
    const result = await invoke(['onboard', '--wait', '--timeoutMs', '2000'], {
      homeDir: HOME,
      env: {
        ...CONFIGURED_ENV,
        WATERX_PREDICT_CONSOLE_URL: 'https://console.test.invalid',
        // What mainnet does by default (ADR-0017), without needing mainnet.
        WATERX_PREDICT_POLICY: 'read-only',
        WATERX_PREDICT_NO_BROWSER: '1',
      },
      routes: {
        'POST /agent-api/v1/auth': AUTH_OK,
        'GET /agent-api/v1/predict/accounts': {
          status: 200,
          body: {
            accounts: [
              {
                accountId: ACCOUNT_ID,
                ownerAddress: `0x${'a'.repeat(63)}9`,
                isSuspended: false,
                delegation: { mayPlaceOrder: true, status: 'ACTIVE' },
                riskProfile: { exists: true },
              },
            ],
          },
        },
      },
    });

    expect(result.envelope.ok).toBe(true);
    // The old sentence — "this agent may now trade" — was false here: on
    // mainnet the execution policy defaults to read-only, and the owner's
    // grant does not change it.
    expect(result.stderr).not.toContain('may now trade');
    expect(result.stderr).toContain('still places no order');
    // And it hands the loop onward rather than stopping on a half-truth:
    // `next` is where the account is adopted and the three modes are offered.
    expect(result.envelope.meta?.nextCommand).toBe('waterx-predict next');
  });
});
