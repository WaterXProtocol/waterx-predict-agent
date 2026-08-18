/**
 * `@waterx/predict-agent-mcp` — the optional MCP stdio adapter.
 *
 * It owns a transport and a JSON-RPC dispatch table. Everything an agent can
 * actually do comes from `@waterx/predict-agent-adapters`, which is this
 * package's only dependency, and is executed by the installed `waterx-predict`
 * binary. There is no second command surface here.
 */
export {
  createMcpServer,
  DEFAULT_SERVER_INFO,
  buildAgentInstructions,
  renderAgentInstructions,
  type McpServer,
  type McpServerInfo,
  type McpServerOptions,
} from './server.ts';

export {
  JSON_RPC_ERRORS,
  JSON_RPC_VERSION,
  MCP_PROTOCOL_VERSION,
  SERVED_METHODS,
  SUPPORTED_PROTOCOL_VERSIONS,
  type JsonRpcFailure,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcSuccess,
} from './protocol.ts';

export { serveStdio, type LineReader, type LineWriter, type StdioServerOptions } from './stdio.ts';
