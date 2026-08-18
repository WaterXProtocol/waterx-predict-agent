/**
 * The MCP adapter: a transport, and nothing more.
 *
 * Read what this file does NOT do. It does not decide what a tool is — the
 * definitions come from the adapter core, which projects them from the command
 * contract. It does not validate — the dispatcher does, with the same
 * validator the CLI uses. It does not retry, price, sign, or track a job. It
 * does not interpret an error: the command core's envelope is handed to the
 * client verbatim.
 *
 * The one judgement it makes is `isError`, and it is deliberately strict. A
 * batch where one leg failed answers `ok: true` with a non-zero exit code,
 * because the call really did produce an authoritative per-leg result. Shown to
 * a model as a plain success, that is a report that everything traded. So
 * `isError` is true unless the whole intent settled, and the envelope with
 * every leg in it is in the content either way.
 */
import {
  isFullySettled,
  toMcpTools,
  buildAgentInstructions,
  renderAgentInstructions,
  type ToolCallOutcome,
  type ToolDispatcher,
} from '@waterx/predict-agent-adapters';

import {
  failure,
  JSON_RPC_ERRORS,
  MCP_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  success,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './protocol.ts';

export interface McpServerInfo {
  readonly name: string;
  readonly title: string;
  readonly version: string;
}

export const DEFAULT_SERVER_INFO: McpServerInfo = {
  name: 'waterx-predict',
  title: 'WaterX Predict',
  version: '0.1.0',
};

export interface McpServerOptions {
  readonly dispatcher: ToolDispatcher;
  readonly serverInfo?: McpServerInfo;
  /**
   * Overrides the instructions returned by `initialize`. Present for tests;
   * a deployment should not use it. Two hosts reading different instructions
   * is the thing plan §6.7 exists to prevent.
   */
  readonly instructions?: string;
}

export interface McpServer {
  /** Returns `null` for a notification, which JSON-RPC answers with silence. */
  handle(request: JsonRpcRequest): Promise<JsonRpcResponse | null>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The tool result.
 *
 * `structuredContent` is not emitted: MCP ties it to a declared `outputSchema`,
 * and the command contract describes inputs only. Rather than invent an output
 * schema here — a second contract, owned by an adapter — the whole outcome is
 * serialized into the text content, which is what a model reads anyway.
 */
function toolResult(outcome: ToolCallOutcome): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(outcome, null, 2) }],
    isError: !isFullySettled(outcome),
  };
}

export function createMcpServer(options: McpServerOptions): McpServer {
  const serverInfo = options.serverInfo ?? DEFAULT_SERVER_INFO;
  const instructions = options.instructions ?? renderAgentInstructions();

  return {
    async handle(request) {
      const id = request.id ?? null;
      const isNotification = request.id === undefined;

      if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
        return isNotification
          ? null
          : failure(id, JSON_RPC_ERRORS.INVALID_REQUEST, 'Not a JSON-RPC 2.0 request.');
      }

      switch (request.method) {
        case 'initialize': {
          const params = isRecord(request.params) ? request.params : {};
          const asked = params['protocolVersion'];
          const protocolVersion =
            typeof asked === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(asked)
              ? asked
              : MCP_PROTOCOL_VERSION;
          return success(id, {
            protocolVersion,
            // Tools only. No resources, prompts, sampling or subscriptions
            // exist here, and advertising one would be a capability this
            // adapter cannot serve.
            capabilities: { tools: {} },
            serverInfo,
            // The host-neutral instructions, in the field MCP reserves for
            // exactly this. A client that surfaces them gives its model the
            // same rules the CLI agent and the function-calling host get.
            instructions,
          });
        }

        case 'notifications/initialized':
          return null;

        case 'ping':
          return isNotification ? null : success(id, {});

        case 'tools/list':
          // No pagination: twenty-three tools fit in one response, and a
          // `nextCursor` this server would never honour is worse than none.
          return success(id, { tools: toMcpTools() });

        case 'tools/call': {
          const params = isRecord(request.params) ? request.params : {};
          const name = params['name'];
          if (typeof name !== 'string') {
            return failure(id, JSON_RPC_ERRORS.INVALID_PARAMS, '`name` is required, as a string.');
          }
          const args = params['arguments'];
          if (args !== undefined && !isRecord(args)) {
            return failure(id, JSON_RPC_ERRORS.INVALID_PARAMS, '`arguments` must be an object.');
          }
          // A tool that refuses is a RESULT with `isError`, not a JSON-RPC
          // error: the model has to see why, and a protocol-level error is
          // reported to the client's plumbing instead.
          const outcome = await options.dispatcher.call(name, args ?? {});
          return success(id, toolResult(outcome));
        }

        default:
          return isNotification
            ? null
            : failure(
                id,
                JSON_RPC_ERRORS.METHOD_NOT_FOUND,
                `\`${request.method}\` is not served by this adapter. It advertises tools only: no resources, prompts, sampling or subscriptions.`,
              );
      }
    },
  };
}

/** Re-exported so a host can render the same document the server returns. */
export { buildAgentInstructions, renderAgentInstructions };
