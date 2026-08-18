/**
 * The stdio framing.
 *
 * Streams are fakes: no process is spawned, no descriptor is opened, and every
 * test ends when the fake input emits `end`. The properties that matter are the
 * ones a client cannot recover from — a frame split across chunks, a reply
 * written out of order, and anything on stdout that is not one JSON document
 * per line.
 */
import { EventEmitter } from 'node:events';

import { serveStdio } from '../src/stdio.ts';
import { JSON_RPC_ERRORS, success, type JsonRpcRequest, type JsonRpcResponse } from '../src/protocol.ts';

class FakeInput extends EventEmitter {
  encoding: string | undefined;
  setEncoding(encoding: 'utf8'): void {
    this.encoding = encoding;
  }
}

function harness(handle: (request: JsonRpcRequest) => Promise<JsonRpcResponse | null>) {
  const input = new FakeInput();
  const written: string[] = [];
  const done = serveStdio({ input, output: { write: (chunk) => written.push(chunk) }, handle });
  return {
    input,
    written,
    /** Feeds a raw chunk, ends the stream, and resolves once every reply is out. */
    async run(...chunks: string[]): Promise<Record<string, unknown>[]> {
      for (const chunk of chunks) input.emit('data', chunk);
      input.emit('end');
      await done;
      return written.map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}

const echo = async (request: JsonRpcRequest): Promise<JsonRpcResponse | null> =>
  request.id === undefined ? null : success(request.id, { method: request.method });

describe('framing', () => {
  it('writes exactly one JSON document per line', async () => {
    const io = harness(echo);
    const responses = await io.run('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    expect(io.written).toHaveLength(1);
    expect(io.written[0]?.endsWith('\n')).toBe(true);
    expect(io.written[0]?.slice(0, -1)).not.toContain('\n');
    expect(responses[0]).toMatchObject({ jsonrpc: '2.0', id: 1 });
  });

  it('reassembles a request split across chunks', async () => {
    // A client writing a large `tools/call` gets chunked by the pipe. Treating
    // a partial chunk as a frame would answer PARSE_ERROR to a valid request.
    const io = harness(echo);
    const responses = await io.run('{"jsonrpc":"2.0","id', '":1,"method":"pi', 'ng"}\n');
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ id: 1 });
  });

  it('handles several requests arriving in one chunk', async () => {
    const io = harness(echo);
    const responses = await io.run(
      '{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n',
    );
    expect(responses.map((response) => response['id'])).toEqual([1, 2]);
  });

  it('reads a final line with no trailing newline', async () => {
    const io = harness(echo);
    const responses = await io.run('{"jsonrpc":"2.0","id":9,"method":"ping"}');
    expect(responses.map((response) => response['id'])).toEqual([9]);
  });

  it('ignores blank lines', async () => {
    const io = harness(echo);
    const responses = await io.run('\n\n{"jsonrpc":"2.0","id":1,"method":"ping"}\n\n');
    expect(responses).toHaveLength(1);
  });
});

describe('ordering', () => {
  it('answers in arrival order however long a call takes', async () => {
    // Serialised deliberately: each call is a subprocess against a real
    // account, and a second order starting before the first answered is a
    // concurrency this adapter has no way to reason about.
    const started: number[] = [];
    const io = harness(async (request) => {
      const id = request.id as number;
      started.push(id);
      // The first call is the slow one; without serialisation it answers last.
      await new Promise((resolve) => setTimeout(resolve, id === 1 ? 20 : 0));
      return success(id, {});
    });
    const responses = await io.run(
      '{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n',
    );
    expect(started).toEqual([1, 2]);
    expect(responses.map((response) => response['id'])).toEqual([1, 2]);
  });

  it('writes nothing for a notification', async () => {
    const io = harness(echo);
    const responses = await io.run('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    expect(responses).toEqual([]);
  });
});

describe('malformed input', () => {
  it('reports unparseable input without ending the session', async () => {
    const io = harness(echo);
    const responses = await io.run('not json\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
    expect(responses[0]?.['error']).toMatchObject({ code: JSON_RPC_ERRORS.PARSE_ERROR });
    // The session survives: the next well-formed frame is still served.
    expect(responses[1]).toMatchObject({ id: 2 });
  });

  it('refuses a batch rather than half-serving it', async () => {
    const io = harness(echo);
    const responses = await io.run('[{"jsonrpc":"2.0","id":1,"method":"ping"}]\n');
    expect(responses[0]?.['error']).toMatchObject({ code: JSON_RPC_ERRORS.INVALID_REQUEST });
  });

  it('turns a thrown handler into an error response, not a crash', async () => {
    const io = harness(() => Promise.reject(new Error('dispatcher exploded')));
    const responses = await io.run(
      '{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0","id":2,"method":"ping"}\n',
    );
    expect(responses[0]?.['error']).toMatchObject({
      code: JSON_RPC_ERRORS.INTERNAL_ERROR,
      message: 'dispatcher exploded',
    });
    expect(responses).toHaveLength(2);
  });

  it('stays silent when a notification’s handler throws', async () => {
    const io = harness(() => Promise.reject(new Error('boom')));
    expect(await io.run('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')).toEqual([]);
  });
});
