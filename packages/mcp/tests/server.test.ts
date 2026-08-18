/**
 * The MCP method surface.
 *
 * The dispatcher is injected, so nothing here spawns the command core, opens a
 * port or touches a network. What is asserted is that this adapter is a
 * transport: the tools it lists are the contract's, the arguments it forwards
 * are untouched, the envelope it returns is verbatim, and the one judgement it
 * makes — `isError` — treats a partially filled batch as not settled.
 */
import { AGENT_COMMANDS } from '@waterx/predict-agent-schema';
import {
  renderAgentInstructions,
  toolNameFor,
  type ToolCallOutcome,
  type ToolDispatcher,
} from '@waterx/predict-agent-adapters';

import { createMcpServer, DEFAULT_SERVER_INFO } from '../src/server.ts';
import { JSON_RPC_ERRORS, MCP_PROTOCOL_VERSION, SERVED_METHODS } from '../src/protocol.ts';

interface Recorded {
  readonly tool: string;
  readonly input: unknown;
}

function stubDispatcher(outcome?: Partial<ToolCallOutcome>): {
  dispatcher: ToolDispatcher;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  return {
    calls,
    dispatcher: {
      call: (tool, input) => {
        calls.push({ tool, input });
        return Promise.resolve({
          ok: true,
          source: 'CORE',
          tool,
          command: 'market.list',
          argv: ['market', 'list'],
          exitCode: 0,
          envelope: { schemaVersion: '1', ok: true, command: 'market.list', data: {} },
          ...outcome,
        } as ToolCallOutcome);
      },
    },
  };
}

const request = (method: string, params?: unknown, id: string | number | null = 1) => ({
  jsonrpc: '2.0' as const,
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

const resultOf = (response: unknown): Record<string, unknown> =>
  (response as { result: Record<string, unknown> }).result;

const errorOf = (response: unknown): { code: number; message: string } =>
  (response as { error: { code: number; message: string } }).error;

describe('initialize', () => {
  it('hands the client the host-neutral instructions', async () => {
    // The whole point of the package: an MCP client's model reads the same
    // rules the CLI agent and a function-calling host read, from one document.
    const server = createMcpServer({ dispatcher: stubDispatcher().dispatcher });
    const result = resultOf(await server.handle(request('initialize')));
    expect(result['instructions']).toBe(renderAgentInstructions());
    expect(result['serverInfo']).toEqual(DEFAULT_SERVER_INFO);
  });

  it('advertises tools and nothing it cannot serve', async () => {
    // Advertising `resources` or `sampling` here would be a capability a
    // client discovers is missing halfway through a session instead of at
    // handshake.
    const server = createMcpServer({ dispatcher: stubDispatcher().dispatcher });
    const result = resultOf(await server.handle(request('initialize')));
    expect(result['capabilities']).toEqual({ tools: {} });
  });

  it('echoes a version it speaks, and falls back rather than failing', async () => {
    const server = createMcpServer({ dispatcher: stubDispatcher().dispatcher });
    const older = resultOf(
      await server.handle(request('initialize', { protocolVersion: '2025-03-26' })),
    );
    expect(older['protocolVersion']).toBe('2025-03-26');

    const unknown = resultOf(
      await server.handle(request('initialize', { protocolVersion: '1999-01-01' })),
    );
    expect(unknown['protocolVersion']).toBe(MCP_PROTOCOL_VERSION);
  });
});

describe('tools/list', () => {
  it('lists exactly the commands in the contract', async () => {
    // Not a list kept here. A command added to the contract appears through
    // the adapter core, and a tool that exists only in MCP would be a second
    // command surface.
    const server = createMcpServer({ dispatcher: stubDispatcher().dispatcher });
    const result = resultOf(await server.handle(request('tools/list')));
    const names = (result['tools'] as Array<{ name: string }>).map((tool) => tool.name);
    expect(names).toEqual(AGENT_COMMANDS.map((command) => toolNameFor(command.name)));
  });

  it('does not promise a page it would never serve', async () => {
    const server = createMcpServer({ dispatcher: stubDispatcher().dispatcher });
    const result = resultOf(await server.handle(request('tools/list')));
    expect(result['nextCursor']).toBeUndefined();
  });
});

describe('tools/call', () => {
  it('forwards the name and arguments to the dispatcher untouched', async () => {
    // Especially the decimal string. Anything here that re-serialized the
    // arguments through a parse would deliver a different size to the core.
    const { dispatcher, calls } = stubDispatcher();
    const server = createMcpServer({ dispatcher });
    await server.handle(
      request('tools/call', {
        name: toolNameFor('market.quote'),
        arguments: { marketId: 'mkt_1', outcomeId: 'YES', side: 'BUY', size: { buyAmount: '12.50' } },
      }),
    );
    expect(calls[0]?.tool).toBe(toolNameFor('market.quote'));
    expect(calls[0]?.input).toEqual({
      marketId: 'mkt_1',
      outcomeId: 'YES',
      side: 'BUY',
      size: { buyAmount: '12.50' },
    });
  });

  it('treats a missing `arguments` as an empty input, not as an error', async () => {
    const { dispatcher, calls } = stubDispatcher();
    const server = createMcpServer({ dispatcher });
    await server.handle(request('tools/call', { name: toolNameFor('market.list') }));
    expect(calls[0]?.input).toEqual({});
  });

  it('carries the whole outcome into the content, verbatim', async () => {
    const envelope = {
      schemaVersion: '1',
      ok: false,
      command: 'order.execute',
      error: { code: 'POLICY_DENIED', message: 'needs approval', retryable: false, source: 'CLI' },
    };
    const { dispatcher } = stubDispatcher({ ok: false, exitCode: 5, envelope });
    const server = createMcpServer({ dispatcher });
    const result = resultOf(
      await server.handle(request('tools/call', { name: toolNameFor('order.execute') })),
    );
    const content = result['content'] as Array<{ type: string; text: string }>;
    expect(content[0]?.type).toBe('text');
    expect(JSON.parse(content[0]?.text ?? '{}').envelope).toEqual(envelope);
  });

  it('does not show a partially filled batch as a success', async () => {
    // `ok: true` with a non-zero exit is the batch where one leg traded and
    // another did not. `isError: false` here would report to a model that
    // everything filled.
    const { dispatcher } = stubDispatcher({ ok: true, exitCode: 11 });
    const server = createMcpServer({ dispatcher });
    const result = resultOf(
      await server.handle(request('tools/call', { name: toolNameFor('order.execute-many') })),
    );
    expect(result['isError']).toBe(true);
  });

  it('marks a settled call as not an error', async () => {
    const server = createMcpServer({ dispatcher: stubDispatcher().dispatcher });
    const result = resultOf(
      await server.handle(request('tools/call', { name: toolNameFor('market.list') })),
    );
    expect(result['isError']).toBe(false);
  });

  it('reports an adapter refusal as a tool result, not a protocol error', async () => {
    // A model has to read why its call was refused. A JSON-RPC error goes to
    // the client's plumbing, where the model never sees it and retries blind.
    const { dispatcher } = stubDispatcher({
      ok: false,
      source: 'ADAPTER',
      code: 'INVALID_INPUT',
      message: 'order.execute: /size: must match exactly one schema',
      details: {},
    } as Partial<ToolCallOutcome>);
    const server = createMcpServer({ dispatcher });
    const response = await server.handle(request('tools/call', { name: 'whatever' }));
    expect(errorOf(response)).toBeUndefined();
    const result = resultOf(response);
    expect(result['isError']).toBe(true);
    expect((result['content'] as Array<{ text: string }>)[0]?.text).toContain('INVALID_INPUT');
  });

  it('refuses a call with no tool name at the protocol level', async () => {
    const { dispatcher, calls } = stubDispatcher();
    const server = createMcpServer({ dispatcher });
    const response = await server.handle(request('tools/call', { arguments: {} }));
    expect(errorOf(response).code).toBe(JSON_RPC_ERRORS.INVALID_PARAMS);
    expect(calls).toEqual([]);
  });

  it('refuses non-object arguments without running anything', async () => {
    const { dispatcher, calls } = stubDispatcher();
    const server = createMcpServer({ dispatcher });
    const response = await server.handle(
      request('tools/call', { name: toolNameFor('market.list'), arguments: ['mkt_1'] }),
    );
    expect(errorOf(response).code).toBe(JSON_RPC_ERRORS.INVALID_PARAMS);
    expect(calls).toEqual([]);
  });
});

describe('the rest of the protocol', () => {
  const server = createMcpServer({ dispatcher: stubDispatcher().dispatcher });

  it('answers a ping', async () => {
    expect(resultOf(await server.handle(request('ping')))).toEqual({});
  });

  it('says nothing to a notification', async () => {
    expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(await server.handle({ jsonrpc: '2.0', method: 'notifications/cancelled' })).toBeNull();
  });

  it('names what it does not serve, rather than failing vaguely', async () => {
    // A client that asked for resources should learn this adapter has none,
    // not that something went wrong.
    for (const method of ['resources/list', 'prompts/list', 'sampling/createMessage']) {
      const error = errorOf(await server.handle(request(method)));
      expect(error.code, method).toBe(JSON_RPC_ERRORS.METHOD_NOT_FOUND);
      expect(error.message, method).toContain(method);
      expect(error.message, method).toContain('tools only');
    }
  });

  it('serves every method it says it serves', async () => {
    for (const method of SERVED_METHODS) {
      const response = await server.handle(request(method, { name: toolNameFor('market.list') }));
      if (response !== null) {
        expect(errorOf(response)?.code, method).not.toBe(JSON_RPC_ERRORS.METHOD_NOT_FOUND);
      }
    }
  });

  it('refuses something that is not JSON-RPC 2.0', async () => {
    const response = await server.handle({ jsonrpc: '1.0', id: 1, method: 'ping' });
    expect(errorOf(response).code).toBe(JSON_RPC_ERRORS.INVALID_REQUEST);
  });

  it('answers with the id it was given', async () => {
    expect((await server.handle(request('ping', undefined, 'req-7'))) as { id: unknown }).toMatchObject(
      { id: 'req-7' },
    );
  });
});
