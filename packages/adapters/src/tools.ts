/**
 * The command contract, rendered as tool definitions.
 *
 * This is a projection and nothing else. Every field below is read off an
 * `AgentCommandSpec`; none of it is authored here. That is the whole point of
 * the package: an MCP host and a function-calling host advertise the SAME
 * tools, with the same input schema and the same annotations, because both read
 * this file and this file reads the contract.
 *
 * Two things a host cannot do without and the contract does not hand over
 * directly:
 *
 *  - **A legal tool name.** `order.execute` is not one for most hosts, whose
 *    grammars are `[a-zA-Z0-9_-]{1,64}`. The mapping is mechanical, and the
 *    reverse map is built from the registry rather than by un-mangling, so a
 *    collision is a thrown error at module load instead of two commands
 *    quietly sharing a tool.
 *  - **A self-contained schema.** A command's `input` is full of
 *    `#/$defs/<name>` pointers into a document the host never received. Each
 *    tool therefore carries the transitive closure of the definitions its
 *    input actually reaches — not the whole `$defs` block, which would put
 *    twenty-three definitions in front of a model asking for a market list.
 *
 * What is deliberately NOT here: any notion of approval, retry, pricing or job
 * state. A tool definition describes an intent; deciding whether that intent
 * may execute belongs to the command core, behind the boundary this package
 * only ever talks to as a subprocess.
 */
import {
  AGENT_COMMANDS,
  COMMAND_SCHEMA_DEFS,
  type AgentCommandSpec,
  type JsonSchema,
} from '@waterx/predict-agent-schema';

/**
 * Prepended to every tool name so this set can be merged into a host's tool
 * list without colliding with somebody else's `market_list`.
 */
export const TOOL_NAME_PREFIX = 'waterx_predict_';

/** What most hosts accept. Asserted, not assumed. */
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/u;

/** Everything a host needs to route a call, and to know what it costs. */
export interface AgentToolAnnotations {
  /** The contract command name, e.g. `order.execute`. */
  readonly command: string;
  /** The CLI path the core is invoked through, e.g. `order execute`. */
  readonly cli: string;
  readonly classification: AgentCommandSpec['classification'];
  readonly sideEffects: AgentCommandSpec['sideEffects'];
  readonly longRunning: boolean;
  readonly confirmation: AgentCommandSpec['confirmation'];
  readonly idempotency: AgentCommandSpec['idempotency'];
  readonly implementation: AgentCommandSpec['implementation'];
  /** False only for the two commands that issue no request at all. */
  readonly reachesTheOutsideWorld: boolean;
}

export interface AgentToolDefinition {
  /** Host-legal, prefixed, unique. */
  readonly name: string;
  /** The contract command name, unmangled. */
  readonly command: string;
  readonly title: string;
  readonly description: string;
  /** Self-contained: carries the `$defs` its `$ref`s reach, and no others. */
  readonly inputSchema: JsonSchema;
  readonly annotations: AgentToolAnnotations;
}

export const toolNameFor = (command: string): string =>
  `${TOOL_NAME_PREFIX}${command.replace(/[.-]/gu, '_')}`;

/**
 * `#/$defs/x` → `x`. Anything else is a bug in the contract rather than
 * something to be lenient about: a `$ref` this cannot follow would silently
 * ship a tool whose schema has a dangling pointer.
 */
function refName(ref: string): string {
  const name = ref.startsWith('#/$defs/') ? ref.slice('#/$defs/'.length) : '';
  if (name === '' || name.includes('/')) {
    throw new Error(`The command contract used an unsupported $ref: ${ref}`);
  }
  return name;
}

/** Every definition reachable from `schema`, sorted for a stable emission. */
function reachableDefs(schema: JsonSchema): Record<string, JsonSchema> {
  const found = new Map<string, JsonSchema>();

  const visit = (node: JsonSchema | undefined): void => {
    if (node === undefined) return;
    if (node.$ref !== undefined) {
      const name = refName(node.$ref);
      if (!found.has(name)) {
        const target = COMMAND_SCHEMA_DEFS[name];
        if (target === undefined) {
          throw new Error(`The command contract references an unknown definition: ${name}`);
        }
        found.set(name, target);
        visit(target);
      }
    }
    for (const child of Object.values(node.properties ?? {})) visit(child);
    for (const child of Object.values(node.$defs ?? {})) visit(child);
    visit(node.items);
    for (const child of node.oneOf ?? []) visit(child);
    for (const child of node.allOf ?? []) visit(child);
  };

  visit(schema);
  return Object.fromEntries([...found].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * A one-line title. The summary is written as a sentence, and a host that
 * renders titles in a list wants it without the full stop.
 */
const titleFor = (spec: AgentCommandSpec): string => spec.summary.replace(/\.$/u, '');

/**
 * The description a model reads. The contract's own prose, plus the two facts
 * that are structural rather than descriptive: that a write is gated, and how
 * the intent is keyed. Both are things a model that skips them gets wrong in a
 * way that costs money.
 */
function descriptionFor(spec: AgentCommandSpec): string {
  const parts = [spec.summary, spec.description];
  if (spec.classification === 'write') {
    parts.push(
      'This is a WRITE. It is refused outright under a read-only policy, and under the default interactive policy it requires an operator approval this adapter cannot supply — see the host-neutral instructions before offering it to a user.',
    );
  }
  if (spec.idempotency.required) {
    parts.push(`Idempotency: ${spec.idempotency.note}`);
  }
  return parts.join('\n\n');
}

/**
 * `implementation.note` opens with `Local only:` for exactly the commands that
 * issue no request to anything. A workspace test pins which those are, so the
 * marker cannot quietly stop being load-bearing.
 */
const reachesTheOutsideWorld = (spec: AgentCommandSpec): boolean =>
  !(spec.implementation.kind === 'runtime' && spec.implementation.note.startsWith('Local only:'));

function defineTool(spec: AgentCommandSpec): AgentToolDefinition {
  const name = toolNameFor(spec.name);
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new Error(`\`${spec.name}\` does not map to a host-legal tool name (got \`${name}\`).`);
  }
  const defs = reachableDefs(spec.input);
  return {
    name,
    command: spec.name,
    title: titleFor(spec),
    description: descriptionFor(spec),
    inputSchema:
      Object.keys(defs).length === 0 ? spec.input : { ...spec.input, $defs: defs },
    annotations: {
      command: spec.name,
      cli: spec.cli,
      classification: spec.classification,
      sideEffects: spec.sideEffects,
      longRunning: spec.longRunning,
      confirmation: spec.confirmation,
      idempotency: spec.idempotency,
      implementation: spec.implementation,
      reachesTheOutsideWorld: reachesTheOutsideWorld(spec),
    },
  };
}

/** One tool per contract command. Built once; the contract does not change. */
export const AGENT_TOOLS: readonly AgentToolDefinition[] = AGENT_COMMANDS.map(defineTool);

const BY_TOOL_NAME: ReadonlyMap<string, AgentToolDefinition> = new Map(
  AGENT_TOOLS.map((tool) => [tool.name, tool]),
);

if (BY_TOOL_NAME.size !== AGENT_TOOLS.length) {
  // Two commands mangled to one tool name. Loudly, at load, rather than by a
  // host routing one command's input into the other's handler.
  throw new Error('Two commands map to the same tool name.');
}

export const getTool = (name: string): AgentToolDefinition | undefined => BY_TOOL_NAME.get(name);

export const listToolNames = (): readonly string[] => AGENT_TOOLS.map((tool) => tool.name);

// ---------------------------------------------------------------------------
// Host shapes.
//
// Each of these is a rename of the fields above and nothing more. If one ever
// needs to compute something, it belongs in `defineTool` so every host gets it.
// ---------------------------------------------------------------------------

export interface OpenAiTool {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: JsonSchema;
  };
}

/**
 * OpenAI Chat Completions shape.
 *
 * `strict` is deliberately not set. Structured-output strict mode requires
 * every property to be required and every object closed, which would mean
 * emitting a DIFFERENT schema from the contract's — a second command surface,
 * and one where `buyAmount` and `sellShares` would both have to be present on
 * every order.
 */
export const toOpenAiTools = (
  tools: readonly AgentToolDefinition[] = AGENT_TOOLS,
): readonly OpenAiTool[] =>
  tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));

export interface AnthropicTool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: JsonSchema;
}

export const toAnthropicTools = (
  tools: readonly AgentToolDefinition[] = AGENT_TOOLS,
): readonly AnthropicTool[] =>
  tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));

export interface McpToolAnnotations {
  readonly title: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface McpTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly annotations: McpToolAnnotations;
}

/**
 * MCP's `Tool`, with its four hints derived rather than asserted.
 *
 * `idempotentHint` is false for every write, including `order.execute`, whose
 * idempotency key makes a REPLAY of the same bytes safe. Repeating the tool
 * CALL is not that: a model that calls it twice mints a second key and buys
 * twice. The hint describes the tool, so it says no.
 */
export const toMcpTools = (tools: readonly AgentToolDefinition[] = AGENT_TOOLS): readonly McpTool[] =>
  tools.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      title: tool.title,
      readOnlyHint: tool.annotations.classification === 'read',
      destructiveHint: tool.annotations.sideEffects.includes('MOVES_FUNDS'),
      idempotentHint: tool.annotations.classification === 'read',
      openWorldHint: tool.annotations.reachesTheOutsideWorld,
    },
  }));
