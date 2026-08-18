/**
 * The slice of MCP this adapter speaks, written out.
 *
 * Hand-rolled rather than taken from an SDK, for two reasons. The transport is
 * newline-delimited JSON-RPC 2.0 and the surface below is five methods, so the
 * dependency would be larger than the thing it replaces. And this package sits
 * one hop from a process that signs transactions — every runtime dependency
 * here is a decision about what runs next to that, and "none" is the easiest
 * one to defend.
 *
 * What is NOT implemented is as load-bearing as what is: there are no
 * resources, no prompts, no sampling, no completions, no subscriptions and no
 * server-initiated requests. `initialize` advertises `tools` only, so a client
 * discovers the absence rather than meeting it as a failure mid-session.
 */

/** The version this adapter was written against. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/**
 * Versions this adapter will answer on. A client asking for one of these gets
 * it echoed back; anything else is answered with `MCP_PROTOCOL_VERSION`, which
 * is what the specification asks a server to do rather than failing.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ['2025-06-18', '2025-03-26'];

export const JSON_RPC_VERSION = '2.0';

/** The standard codes. No custom code is minted: a refusal is a tool result. */
export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  readonly jsonrpc: string;
  /** Absent on a notification, which is answered with nothing. */
  readonly id?: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcSuccess {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly id: JsonRpcId;
  readonly result: unknown;
}

export interface JsonRpcFailure {
  readonly jsonrpc: typeof JSON_RPC_VERSION;
  readonly id: JsonRpcId;
  readonly error: { readonly code: number; readonly message: string; readonly data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;

export const success = (id: JsonRpcId, result: unknown): JsonRpcSuccess => ({
  jsonrpc: JSON_RPC_VERSION,
  id,
  result,
});

export const failure = (id: JsonRpcId, code: number, message: string): JsonRpcFailure => ({
  jsonrpc: JSON_RPC_VERSION,
  id,
  error: { code, message },
});

/** The methods served. Anything else is `METHOD_NOT_FOUND`, by name. */
export const SERVED_METHODS: readonly string[] = [
  'initialize',
  'notifications/initialized',
  'ping',
  'tools/list',
  'tools/call',
];
