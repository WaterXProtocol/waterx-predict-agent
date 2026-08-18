/**
 * Newline-delimited JSON-RPC over a pair of streams.
 *
 * The transport MCP defines for a locally spawned server: one JSON document per
 * line on stdin, one per line on stdout, and stdout carries nothing else. A
 * stray write there corrupts the client's parse for the rest of the session, so
 * every diagnostic in this package goes to stderr.
 *
 * Requests are handled ONE AT A TIME, in arrival order. Concurrency would let a
 * client's second order start before its first had answered, and each call is a
 * subprocess against a real account — serialising is the honest default, and a
 * host that wants parallelism can run two sessions.
 */
import type { JsonRpcRequest, JsonRpcResponse } from './protocol.ts';
import { failure, JSON_RPC_ERRORS } from './protocol.ts';

export interface LineReader {
  setEncoding(encoding: 'utf8'): void;
  on(event: 'data', listener: (chunk: string) => void): void;
  on(event: 'end', listener: () => void): void;
}

export interface LineWriter {
  write(chunk: string): void;
}

export interface StdioServerOptions {
  readonly input: LineReader;
  readonly output: LineWriter;
  handle(request: JsonRpcRequest): Promise<JsonRpcResponse | null>;
}

/** Resolves when the input stream ends and the last reply has been written. */
export function serveStdio(options: StdioServerOptions): Promise<void> {
  return new Promise<void>((resolve) => {
    let buffer = '';
    let queue: Promise<void> = Promise.resolve();
    let ended = false;

    const respond = (response: JsonRpcResponse | null): void => {
      if (response !== null) options.output.write(`${JSON.stringify(response)}\n`);
    };

    const handleLine = (line: string): void => {
      if (line.trim() === '') return;
      queue = queue.then(async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          respond(failure(null, JSON_RPC_ERRORS.PARSE_ERROR, 'Not valid JSON.'));
          return;
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          // Batches are not supported, and are refused rather than silently
          // half-handled.
          respond(failure(null, JSON_RPC_ERRORS.INVALID_REQUEST, 'Expected a single request object.'));
          return;
        }
        try {
          respond(await options.handle(parsed as JsonRpcRequest));
        } catch (error) {
          const request = parsed as JsonRpcRequest;
          if (request.id === undefined) return;
          respond(
            failure(
              request.id ?? null,
              JSON_RPC_ERRORS.INTERNAL_ERROR,
              error instanceof Error ? error.message : String(error),
            ),
          );
        }
      });
    };

    options.input.setEncoding('utf8');
    options.input.on('data', (chunk) => {
      buffer += chunk;
      for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        handleLine(line);
      }
    });
    options.input.on('end', () => {
      if (ended) return;
      ended = true;
      // A last line without a trailing newline is still a request.
      handleLine(buffer);
      buffer = '';
      queue.then(() => {
        resolve();
      }, () => {
        resolve();
      });
    });
  });
}
