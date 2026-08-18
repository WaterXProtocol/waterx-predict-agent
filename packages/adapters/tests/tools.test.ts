/**
 * The tool projection.
 *
 * The properties worth testing here are the ones a host would otherwise
 * discover by shipping: a tool name its grammar rejects, a schema with a
 * pointer into a document it never received, and an annotation that says a
 * write is safe to repeat.
 */
import {
  AGENT_COMMANDS,
  COMMAND_SCHEMA_DEFS,
  type JsonSchema,
} from '@waterx/predict-agent-schema';

import {
  AGENT_TOOLS,
  getTool,
  toAnthropicTools,
  toMcpTools,
  toOpenAiTools,
  toolNameFor,
} from '../src/tools.ts';

/** Every `$ref` anywhere inside a schema. */
function refsIn(schema: JsonSchema): string[] {
  const found: string[] = [];
  const visit = (node: JsonSchema | undefined): void => {
    if (node === undefined) return;
    if (node.$ref !== undefined) found.push(node.$ref);
    for (const child of Object.values(node.properties ?? {})) visit(child);
    for (const child of Object.values(node.$defs ?? {})) visit(child);
    visit(node.items);
    for (const child of node.oneOf ?? []) visit(child);
    for (const child of node.allOf ?? []) visit(child);
  };
  visit(schema);
  return found;
}

describe('the tool registry', () => {
  it('advertises exactly the commands in the contract, and nothing else', () => {
    // An extra tool is a capability an adapter invented; a missing one is a
    // command reachable from the CLI and not from a model host. Both break the
    // rule that the same intent is available everywhere.
    expect(AGENT_TOOLS.map((tool) => tool.command)).toEqual(
      AGENT_COMMANDS.map((command) => command.name),
    );
  });

  it('gives every tool a host-legal, unique name', () => {
    const names = AGENT_TOOLS.map((tool) => tool.name);
    for (const name of names) expect(name, name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/u);
    expect(new Set(names).size).toBe(names.length);
    expect(toolNameFor('order.execute-many')).toBe('waterx_predict_order_execute_many');
  });

  it('routes a tool name back to the command it was made from', () => {
    for (const command of AGENT_COMMANDS) {
      const tool = getTool(toolNameFor(command.name));
      expect(tool?.command, command.name).toBe(command.name);
      // The CLI path is carried through unchanged: this is what the dispatcher
      // turns into argv, and a tool that carried a stale path would run a
      // different command than it advertised.
      expect(tool?.annotations.cli, command.name).toBe(command.cli);
    }
  });

  it('has no dangling pointer once handed to a host', () => {
    // A model host receives one tool, not the command document. Every `$ref`
    // in its input schema must resolve inside that schema.
    for (const tool of AGENT_TOOLS) {
      const available = new Set(Object.keys(tool.inputSchema.$defs ?? {}));
      for (const ref of refsIn(tool.inputSchema)) {
        expect(ref, `${tool.name} ${ref}`).toMatch(/^#\/\$defs\//u);
        expect(available.has(ref.slice('#/$defs/'.length)), `${tool.name} ${ref}`).toBe(true);
      }
    }
  });

  it('carries the definitions it reaches and no others', () => {
    // The whole `$defs` block in front of every tool would put twenty-three
    // definitions in a model's context to list a market.
    const marketList = getTool(toolNameFor('market.list'));
    expect(Object.keys(marketList?.inputSchema.$defs ?? {})).not.toContain('orderIntent');

    const executeMany = getTool(toolNameFor('order.execute-many'));
    const defs = Object.keys(executeMany?.inputSchema.$defs ?? {});
    expect(defs).toContain('orderIntent');
    // Reached transitively, through `orderIntent`, not directly by the command.
    expect(defs).toContain('maxSlippageBps');
    expect(defs.length).toBeLessThan(Object.keys(COMMAND_SCHEMA_DEFS).length);
    // Sorted, so a regenerated definition set is a readable diff.
    expect(defs).toEqual([...defs].sort());
  });

  it('never rewrites the contract’s own input schema', () => {
    for (const command of AGENT_COMMANDS) {
      const tool = getTool(toolNameFor(command.name));
      const { $defs: _defs, ...rest } = tool?.inputSchema ?? {};
      expect(rest, command.name).toEqual(command.input);
    }
  });

  it('warns a model about a write in the description itself', () => {
    // A host that shows only the description, and not the annotations, still
    // has to see that this one moves money and will be refused without an
    // operator's approval.
    const execute = getTool(toolNameFor('order.execute'));
    expect(execute?.description).toContain('WRITE');
    expect(execute?.description).toContain('read-only');
    expect(execute?.description).toContain('approval');
    expect(getTool(toolNameFor('market.list'))?.description).not.toContain('WRITE');
  });
});

describe('the MCP hints', () => {
  const byName = new Map(toMcpTools().map((tool) => [tool.name, tool]));

  it('marks every write as not idempotent, including the keyed one', () => {
    // `order.execute` takes an idempotency key, which makes a REPLAY of the
    // same bytes safe. Calling the tool twice is not a replay: it mints a
    // second key and buys twice. The hint describes the tool.
    const execute = byName.get(toolNameFor('order.execute'));
    expect(execute?.annotations.readOnlyHint).toBe(false);
    expect(execute?.annotations.idempotentHint).toBe(false);
    expect(execute?.annotations.destructiveHint).toBe(true);
  });

  it('does not call a strategy cancellation destructive', () => {
    // It is a write, and it moves no funds. Flagging it alongside an order
    // would train a host to ignore the flag on the one that matters.
    const cancel = byName.get(toolNameFor('strategy.cancel'));
    expect(cancel?.annotations.readOnlyHint).toBe(false);
    expect(cancel?.annotations.destructiveHint).toBe(false);
  });

  it('closes the open-world hint for exactly the two local commands', () => {
    // Derived from the contract's `Local only:` marker rather than a list kept
    // here. This test is what makes that marker load-bearing: a command that
    // stops saying it, or starts, changes this set and fails.
    const local = toMcpTools()
      .filter((tool) => !tool.annotations.openWorldHint)
      .map((tool) => tool.name);
    expect(local.sort()).toEqual(
      [toolNameFor('runtime.describe'), toolNameFor('runtime.command-schema')].sort(),
    );
  });
});

describe('the host shapes', () => {
  it('give every host the same names and the same schemas', () => {
    // The rename is the only difference allowed between them. If one host's
    // schema could drift from another's, the same tool call would validate in
    // one place and fail in the other.
    const openai = toOpenAiTools();
    const anthropic = toAnthropicTools();
    const mcp = toMcpTools();
    for (const [index, tool] of AGENT_TOOLS.entries()) {
      expect(openai[index]?.function.name).toBe(tool.name);
      expect(anthropic[index]?.name).toBe(tool.name);
      expect(mcp[index]?.name).toBe(tool.name);
      expect(openai[index]?.function.parameters).toEqual(tool.inputSchema);
      expect(anthropic[index]?.input_schema).toEqual(tool.inputSchema);
      expect(mcp[index]?.inputSchema).toEqual(tool.inputSchema);
    }
  });

  it('never claims OpenAI strict mode', () => {
    // Strict mode requires every property present and every object closed,
    // which would mean emitting a different schema than the contract's — and
    // one where a BUY would have to carry `sellShares`.
    for (const tool of toOpenAiTools()) {
      expect(Object.keys(tool.function)).toEqual(['name', 'description', 'parameters']);
    }
  });
});
