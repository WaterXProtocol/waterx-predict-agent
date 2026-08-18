/**
 * The subprocess seam.
 *
 * `spawn` is injected throughout: nothing here starts a real process, opens a
 * port, or reaches a network. What is asserted is the boundary — which flags an
 * operator may pin, and that a non-zero exit is data rather than an exception.
 */
import { EventEmitter } from 'node:events';
import type { spawn as nodeSpawn } from 'node:child_process';

import { ALLOWED_OPERATOR_FLAGS, assertOperatorFlags, createCliInvoker } from '../src/core.ts';

class FakeStream extends EventEmitter {
  setEncoding(): void {
    // The invoker sets utf8; the fake emits strings already.
  }
}

interface Spawned {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string | undefined>;
}

function fakeSpawn(result: { stdout?: string; stderr?: string; code?: number | null; signal?: NodeJS.Signals | null }) {
  const spawned: Spawned[] = [];
  const spawn = ((command: string, args: readonly string[], options: { env: Record<string, string | undefined> }) => {
    spawned.push({ command, args, env: options.env });
    const child = new EventEmitter() as EventEmitter & {
      stdout: FakeStream;
      stderr: FakeStream;
      kill: (signal?: string) => boolean;
    };
    child.stdout = new FakeStream();
    child.stderr = new FakeStream();
    child.kill = () => true;
    setImmediate(() => {
      if (result.stdout !== undefined) child.stdout.emit('data', result.stdout);
      if (result.stderr !== undefined) child.stderr.emit('data', result.stderr);
      child.emit('close', 'code' in result ? result.code : 0, result.signal ?? null);
    });
    return child;
  }) as unknown as typeof nodeSpawn;
  return { spawn, spawned };
}

describe('the operator flag allowlist', () => {
  it('accepts the four flags that are an operator’s to pin', () => {
    for (const flag of ALLOWED_OPERATOR_FLAGS) {
      expect(() => assertOperatorFlags([flag, 'value'])).not.toThrow();
    }
  });

  it('refuses an approval, and says why', () => {
    // The load-bearing one. A pinned approval would either be useless — the
    // token digests one exact intent — or would pre-authorise an order the
    // model had not written yet.
    expect(() => assertOperatorFlags(['--approve', 'apv1_deadbeef'])).toThrow(/one exact intent/u);
  });

  it('refuses to let an input arrive from anywhere but the dispatcher', () => {
    for (const flag of ['--input', '--file', '--stdin']) {
      expect(() => assertOperatorFlags([flag, 'x'])).toThrow();
    }
  });

  it('refuses a flag smuggled in as another flag’s value', () => {
    expect(() => assertOperatorFlags(['--config', '--approve'])).toThrow(/as its value/u);
  });

  it('is enforced when the invoker is built, not when an order is placed', () => {
    expect(() => createCliInvoker({ operatorArgs: ['--approve', 'apv1_x'] })).toThrow();
  });
});

describe('the CLI invoker', () => {
  const invocation = { command: 'market.list', argv: ['market', 'list', '--input', '{}'] };

  it('runs the binary with the operator flags before the command’s own argv', async () => {
    const { spawn, spawned } = fakeSpawn({ stdout: '{"ok":true}' });
    const invoke = createCliInvoker({
      binary: '/tmp/waterx-predict.js',
      execPath: '/tmp/node',
      operatorArgs: ['--policy', 'read-only'],
      spawn,
      env: { HOME: '/tmp' },
    });
    await invoke(invocation);
    expect(spawned[0]?.command).toBe('/tmp/node');
    expect(spawned[0]?.args).toEqual([
      '/tmp/waterx-predict.js',
      '--policy',
      'read-only',
      'market',
      'list',
      '--input',
      '{}',
    ]);
  });

  it('hands the child only the environment it was given', async () => {
    // An inherited environment is how a token an operator scoped to one
    // adapter reaches a different one.
    const { spawn, spawned } = fakeSpawn({ stdout: '{}' });
    await createCliInvoker({ binary: '/tmp/x.js', spawn, env: { ONLY: 'this' } })(invocation);
    expect(spawned[0]?.env).toEqual({ ONLY: 'this' });
  });

  it('returns a non-zero exit as data, not as a thrown error', async () => {
    // A partially successful batch exits non-zero WITH a valid envelope.
    // Throwing here would lose the legs.
    const { spawn } = fakeSpawn({ stdout: '{"ok":true}', stderr: 'note', code: 11 });
    const response = await createCliInvoker({ binary: '/tmp/x.js', spawn })(invocation);
    expect(response).toEqual({ exitCode: 11, stdout: '{"ok":true}', stderr: 'note' });
  });

  it('never reports a child that produced no exit code as a success', async () => {
    // A core killed by the timeout has no exit code. Reporting 0 would make
    // "the core never answered" indistinguishable from "it worked".
    const killed = fakeSpawn({ code: null, signal: 'SIGKILL' });
    expect((await createCliInvoker({ binary: '/tmp/x.js', spawn: killed.spawn })(invocation)).exitCode).toBe(137);

    const vanished = fakeSpawn({ code: null, signal: null });
    expect(
      (await createCliInvoker({ binary: '/tmp/x.js', spawn: vanished.spawn })(invocation)).exitCode,
    ).toBe(-1);
  });
});
