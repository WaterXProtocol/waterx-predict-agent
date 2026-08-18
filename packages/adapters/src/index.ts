/**
 * `@waterx/predict-agent-adapters` — the thin adapter core.
 *
 * Three things, and deliberately nothing else:
 *
 *  - the host-neutral agent instructions (`instructions.ts`),
 *  - the command contract projected into tool definitions (`tools.ts`),
 *  - a dispatcher that validates against that same contract and hands the call
 *    to the installed command core (`dispatch.ts`, `core.ts`).
 *
 * There is no pricing, retry, signing, policy or job state here, and no way to
 * add any: this package imports the schema and the Node standard library, and
 * reaches the core only as a subprocess.
 */
export {
  AGENT_INSTRUCTIONS_VERSION,
  buildAgentInstructions,
  renderAgentInstructions,
  type AgentInstructionsDocument,
  type InstructionCommandEntry,
  type InstructionRule,
  type InstructionSection,
} from './instructions.ts';

export {
  AGENT_TOOLS,
  TOOL_NAME_PREFIX,
  getTool,
  listToolNames,
  toAnthropicTools,
  toMcpTools,
  toOpenAiTools,
  toolNameFor,
  type AgentToolAnnotations,
  type AgentToolDefinition,
  type AnthropicTool,
  type McpTool,
  type McpToolAnnotations,
  type OpenAiTool,
} from './tools.ts';

export {
  createToolDispatcher,
  isFullySettled,
  type AdapterRefusal,
  type CoreOutcome,
  type ToolCallOutcome,
  type ToolDispatcher,
  type ToolDispatcherOptions,
} from './dispatch.ts';

export {
  ALLOWED_OPERATOR_FLAGS,
  assertOperatorFlags,
  createCliInvoker,
  locateCommandCore,
  type CliInvokerOptions,
  type CoreInvocation,
  type CoreInvokeOptions,
  type CoreInvoker,
  type CoreResponse,
} from './core.ts';
