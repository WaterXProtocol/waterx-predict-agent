/**
 * Delegation.
 *
 * The dispatcher's job is to be boring: validate, hand over, relay. These tests
 * are mostly about what it must NOT do — refuse for a reason of its own, coerce
 * an input, retry, or turn a partial success into a success.
 *
 * No test here spawns anything. The `CoreInvoker` is injected, which is the
 * same seam a host would use to run the core somewhere else.
 */
import { createToolDispatcher, isFullySettled } from '../src/dispatch.ts';
import type { CoreInvocation, CoreResponse } from '../src/core.ts';
import { toolNameFor } from '../src/tools.ts';

/** A valid BUY intent, so a test that is about delegation is not about sizing. */
const INTENT = {
  accountId: `0x${'1'.repeat(64)}`,
  marketId: 'mkt_1',
  outcomeId: 'YES',
  side: 'BUY',
  size: { buyAmount: '5.00' },
  referenceQuoteId: 'quote_1',
  maxSlippageBps: 100,
} as const;

interface Recorder {
  readonly calls: CoreInvocation[];
  invoke: (invocation: CoreInvocation) => Promise<CoreResponse>;
}

function recorder(response: Partial<CoreResponse> = {}): Recorder {
  const calls: CoreInvocation[] = [];
  return {
    calls,
    invoke: (invocation) => {
      calls.push(invocation);
      return Promise.resolve({
        exitCode: response.exitCode ?? 0,
        stdout:
          response.stdout ??
          JSON.stringify({ schemaVersion: '1', ok: true, command: invocation.command, data: {} }),
        stderr: response.stderr ?? '',
      });
    },
  };
}

describe('refusals the adapter makes itself', () => {
  it('rejects a tool nobody advertised, without running anything', async () => {
    const core = recorder();
    const outcome = await createToolDispatcher({ invoke: core.invoke }).call('not_a_tool', {});
    expect(outcome).toMatchObject({ ok: false, source: 'ADAPTER', code: 'UNKNOWN_TOOL' });
    expect(core.calls).toEqual([]);
  });

  it('rejects an input the command contract rejects, without running anything', async () => {
    // The important half is `calls` staying empty. A model that sends a JSON
    // number where a decimal string belongs must not reach a process that
    // could mint a quote for it.
    const core = recorder();
    const outcome = await createToolDispatcher({ invoke: core.invoke }).call(
      toolNameFor('order.execute'),
      { ...INTENT, size: { buyAmount: 12.5 } },
    );
    expect(outcome).toMatchObject({ ok: false, source: 'ADAPTER', code: 'INVALID_INPUT' });
    expect(core.calls).toEqual([]);
  });

  it('never validates with rules of its own', async () => {
    // `market.list` accepts an empty input. An adapter that required an
    // account here would be a second command surface with a stricter contract.
    const core = recorder();
    const outcome = await createToolDispatcher({ invoke: core.invoke }).call(
      toolNameFor('market.list'),
      {},
    );
    expect(outcome.ok).toBe(true);
    expect(core.calls).toHaveLength(1);
  });
});

describe('what reaches the command core', () => {
  it('is the command’s own CLI path and one validated JSON document', async () => {
    const core = recorder();
    await createToolDispatcher({ invoke: core.invoke }).call(toolNameFor('market.get'), {
      marketId: 'mkt_1',
    });
    expect(core.calls[0]?.argv).toEqual(['market', 'get', '--input', '{"marketId":"mkt_1"}']);
  });

  it('never puts an approval on the argv', async () => {
    // There is no code path that could. Asserted anyway, because this is the
    // one flag whose accidental appearance would let a model authorise its own
    // order.
    const core = recorder();
    await createToolDispatcher({ invoke: core.invoke }).call(toolNameFor('market.list'), {});
    expect(core.calls[0]?.argv.join(' ')).not.toContain('--approve');
  });

  it('passes a decimal through as the string it was typed as', async () => {
    // Round-tripping `"12.50"` through anything that parses it would deliver
    // `12.5` to the core — a different size, silently.
    const core = recorder();
    await createToolDispatcher({ invoke: core.invoke }).call(toolNameFor('market.quote'), {
      marketId: 'mkt_1',
      outcomeId: 'YES',
      side: 'BUY',
      size: { buyAmount: '12.50' },
    });
    expect(core.calls[0]?.argv.at(-1)).toContain('"buyAmount":"12.50"');
  });
});

describe('what comes back', () => {
  it('relays the core’s envelope unmodified', async () => {
    const envelope = {
      schemaVersion: '1',
      ok: false,
      command: 'order.execute',
      requestId: 'req_1',
      error: { code: 'POLICY_DENIED', message: 'needs approval', retryable: false, source: 'CLI' },
    };
    const core = recorder({ exitCode: 5, stdout: JSON.stringify(envelope) });
    const outcome = await createToolDispatcher({ invoke: core.invoke }).call(
      toolNameFor('order.execute'),
      INTENT,
    );
    expect(outcome).toMatchObject({ ok: false, source: 'CORE', exitCode: 5 });
    // Verbatim. Not re-worded, not re-coded, not softened.
    expect(outcome.source === 'CORE' ? outcome.envelope : null).toEqual(envelope);
  });

  it('does not call a partially filled batch settled', async () => {
    // The case this whole distinction exists for: the envelope says `ok`
    // because the call produced an authoritative per-leg result, and the exit
    // code says not every leg traded.
    const core = recorder({
      exitCode: 11,
      stdout: JSON.stringify({ schemaVersion: '1', ok: true, command: 'order.execute-many', data: {} }),
    });
    const outcome = await createToolDispatcher({ invoke: core.invoke }).call(
      toolNameFor('order.execute-many'),
      { orders: [INTENT] },
    );
    expect(outcome.ok).toBe(true);
    expect(isFullySettled(outcome)).toBe(false);
  });

  it('reports unreadable output as unknown, not as a failure', async () => {
    // A core that wrote nothing may still have executed. Reporting "it failed"
    // is how one intent becomes two orders.
    const core = recorder({ exitCode: 70, stdout: 'Killed\n' });
    const outcome = await createToolDispatcher({ invoke: core.invoke }).call(
      toolNameFor('market.list'),
      {},
    );
    expect(outcome).toMatchObject({ source: 'ADAPTER', code: 'CORE_OUTPUT_UNREADABLE' });
    expect(outcome.ok).toBe(false);
    expect(isFullySettled(outcome)).toBe(false);
    if (outcome.source === 'ADAPTER') expect(outcome.message).toContain('UNKNOWN');
  });

  it('keeps the core’s stderr out of the result unless asked', async () => {
    const core = recorder({ exitCode: 70, stdout: '', stderr: 'diagnostic detail' });
    const quiet = await createToolDispatcher({ invoke: core.invoke }).call(
      toolNameFor('market.list'),
      {},
    );
    expect(JSON.stringify(quiet)).not.toContain('diagnostic detail');

    const verbose = await createToolDispatcher({
      invoke: core.invoke,
      includeCoreDiagnostics: true,
    }).call(toolNameFor('market.list'), {});
    expect(JSON.stringify(verbose)).toContain('diagnostic detail');
  });

  it('never retries', async () => {
    // Retry belongs to the surface that owns the idempotency key. A second
    // attempt from here would be a second logical write.
    let calls = 0;
    const outcome = await createToolDispatcher({
      invoke: () => {
        calls += 1;
        return Promise.resolve({ exitCode: 7, stdout: JSON.stringify({ ok: false }), stderr: '' });
      },
    }).call(toolNameFor('market.list'), {});
    expect(calls).toBe(1);
    expect(outcome.ok).toBe(false);
  });
});
