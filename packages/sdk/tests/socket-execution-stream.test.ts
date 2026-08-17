/**
 * Tests the SHIPPED Socket.IO execution stream.
 *
 * Everything here goes through the `connect` seam, so no socket is opened and no
 * port is bound. What is asserted is the part that is easy to get wrong and
 * expensive when it is: the cursor that a reconnect replays from, the gap the
 * server declares when it cannot replay, the reconnect it does not declare, the
 * refusal budget that stops a login loop, and the sockets and listeners that must
 * not survive the wait that opened them.
 *
 * The one property none of this can weaken: a frame is a hint. `waitForExecution`
 * still confirms terminal state over REST — `execution-stream.test.ts` covers
 * that against the seam, and it is the same code path.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  PREDICT_AGENT_STREAM_NAMESPACE,
  PREDICT_EXECUTION_STREAM,
  PREDICT_STREAM_READY,
} from '../src/contract.ts';
import {
  SocketExecutionStream,
  type SocketExecutionStreamOptions,
  type StreamHandshake,
  type StreamSocket,
} from '../src/execution-stream.ts';

/** A socket whose events this test drives by hand. */
class FakeSocket implements StreamSocket {
  readonly handlers = new Map<string, (payload: unknown) => void>();
  disconnects = 0;
  throwOnDisconnect = false;

  on(event: string, listener: (payload: unknown) => void): void {
    this.handlers.set(event, listener);
  }

  disconnect(): void {
    this.disconnects += 1;
    if (this.throwOnDisconnect) throw new Error('socket already closed');
  }

  emit(event: string, payload: unknown): void {
    this.handlers.get(event)?.(payload);
  }

  ready(cursor: string, gap = false): void {
    this.emit(PREDICT_STREAM_READY, {
      stream: PREDICT_EXECUTION_STREAM,
      agentWallet: '0xagent',
      cursor,
      replayed: 0,
      gap,
    });
  }

  frame(cursor: string, executionId: string, status = 'PENDING_FILL'): void {
    this.emit(PREDICT_EXECUTION_STREAM, {
      stream: PREDICT_EXECUTION_STREAM,
      cursor,
      executionId,
      status,
      occurredAt: '2026-08-17T00:00:00.000Z',
    });
  }
}

interface Harness {
  stream: SocketExecutionStream;
  sockets: FakeSocket[];
  urls: string[];
  /** Every handshake the connector has been asked to build, in order. */
  handshakes: StreamHandshake[];
  /** Force a reconnect: the transport builds a fresh handshake and a fresh socket. */
  reconnect: () => Promise<FakeSocket>;
  connected: () => Promise<FakeSocket>;
}

function harness(options: Partial<SocketExecutionStreamOptions> = {}): Harness {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const handshakes: StreamHandshake[] = [];
  let build: (() => Promise<StreamHandshake>) | undefined;

  const stream = new SocketExecutionStream({
    baseUrl: 'https://api.test/',
    token: async () => await Promise.resolve('tok'),
    ...options,
    connect: async ({ url, handshake }) => {
      urls.push(url);
      build = handshake;
      handshakes.push(await handshake());
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });

  const connected = async (): Promise<FakeSocket> => {
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(0));
    const socket = sockets.at(-1);
    if (socket === undefined) throw new Error('no socket');
    return socket;
  };

  return {
    stream,
    sockets,
    urls,
    handshakes,
    connected,
    // socket.io owns reconnection; the seam models it as "the transport asks for
    // a fresh handshake and produces a fresh socket", which is exactly what a
    // reconnect looks like from this class's side.
    reconnect: async () => {
      const socket = await connected();
      if (build === undefined) throw new Error('never connected');
      handshakes.push(await build());
      // The same handler table: socket.io reuses one Socket object across
      // reconnects, so re-registering is not part of the contract.
      return socket;
    },
  };
}

describe('SocketExecutionStream connection lifecycle', () => {
  it('does not connect until something is waiting', async () => {
    const { sockets } = harness();
    // Constructing a client must not open a socket. A CLI that only reads a
    // market would otherwise pay for — and have to close — a connection.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(sockets).toHaveLength(0);
  });

  it('connects to the private namespace under the REST base URL', async () => {
    const h = harness();
    h.stream.onExecutionUpdate('exec-1', () => undefined);
    await h.connected();

    // One trailing slash on the base URL must not become two in the path.
    expect(h.urls).toEqual([`https://api.test${PREDICT_AGENT_STREAM_NAMESPACE}`]);
  });

  it('presents the session token in the handshake, and no cursor on a fresh session', async () => {
    const h = harness();
    h.stream.onExecutionUpdate('exec-1', () => undefined);
    await h.connected();

    // No cursor means "start from now". Sending 0 would ask the server to replay
    // this agent's entire history on every first connection.
    expect(h.handshakes[0]).toEqual({ token: 'tok' });
  });

  it('disconnects as soon as the last waiter leaves', async () => {
    const h = harness();
    const off = h.stream.onExecutionUpdate('exec-1', () => undefined);
    const socket = await h.connected();

    off();

    // A socket per finished trade is a socket the process has to be told to drop
    // before it can exit.
    expect(socket.disconnects).toBe(1);
  });

  it('keeps the socket while another waiter is still on it', async () => {
    const h = harness();
    const first = h.stream.onExecutionUpdate('exec-1', () => undefined);
    h.stream.onExecutionUpdate('exec-2', () => undefined);
    const socket = await h.connected();

    first();

    expect(socket.disconnects).toBe(0);
  });

  it('ignores a repeated unsubscribe rather than evicting a later listener', async () => {
    const h = harness();
    const wake = vi.fn();
    const off = h.stream.onExecutionUpdate('exec-1', () => undefined);
    off();
    off();
    h.stream.onExecutionUpdate('exec-1', wake);
    const socket = await h.connected();

    socket.frame('1', 'exec-1');

    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('reconnects for a new wait after the previous one released the socket', async () => {
    const h = harness();
    const off = h.stream.onExecutionUpdate('exec-1', () => undefined);
    await h.connected();
    off();

    h.stream.onExecutionUpdate('exec-2', () => undefined);
    await vi.waitFor(() => expect(h.sockets).toHaveLength(2));
  });

  it('does not keep a socket that arrived after the last waiter left', async () => {
    const h = harness();
    const off = h.stream.onExecutionUpdate('exec-1', () => undefined);
    // Unsubscribe inside the same tick, while the connector is still in flight.
    off();
    const socket = await h.connected();

    // Otherwise the connection is orphaned: nothing holds a reference to close
    // it, and it keeps the event loop alive until the server times it out.
    await vi.waitFor(() => expect(socket.disconnects).toBe(1));
  });

  it('closes the socket and forgets every listener on close()', async () => {
    const h = harness();
    const wake = vi.fn();
    h.stream.onExecutionUpdate('exec-1', wake);
    const socket = await h.connected();

    h.stream.close();
    socket.frame('1', 'exec-1');

    expect(socket.disconnects).toBe(1);
    expect(wake).not.toHaveBeenCalled();
    // A subscribe after close must not silently open a socket nobody will close.
    h.stream.onExecutionUpdate('exec-2', () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.sockets).toHaveLength(1);
  });

  it('survives a disconnect that throws', async () => {
    const h = harness();
    h.stream.onExecutionUpdate('exec-1', () => undefined);
    const socket = await h.connected();
    socket.throwOnDisconnect = true;

    expect(() => {
      h.stream.close();
    }).not.toThrow();
  });

  it('degrades instead of throwing when the transport cannot be loaded', async () => {
    const degraded: string[] = [];
    const stream = new SocketExecutionStream({
      baseUrl: 'https://api.test',
      token: async () => await Promise.resolve('tok'),
      onDegraded: (reason) => degraded.push(reason),
      connect: () => Promise.reject(new Error('socket.io-client is not installed')),
    });

    // The unsubscribe must still be a function: the wait's `finally` calls it.
    const off = stream.onExecutionUpdate('exec-1', () => undefined);
    await vi.waitFor(() => expect(degraded).toHaveLength(1));

    expect(degraded[0]).toContain('not installed');
    expect(stream.isDegraded).toBe(true);
    expect(() => off()).not.toThrow();
  });
});

describe('SocketExecutionStream cursor and replay', () => {
  it('sends a persisted cursor so a restart replays the window it missed', async () => {
    const h = harness({ cursor: '41' });
    h.stream.onExecutionUpdate('exec-1', () => undefined);
    await h.connected();

    expect(h.handshakes[0]).toEqual({ token: 'tok', cursor: '41' });
  });

  it('advances the cursor on every frame and reconnects from the newest one', async () => {
    const persisted: string[] = [];
    const h = harness({ onCursor: (cursor) => persisted.push(cursor) });
    h.stream.onExecutionUpdate('exec-1', () => undefined);
    const socket = await h.connected();

    socket.frame('7', 'exec-1');
    socket.frame('8', 'exec-1');
    await h.reconnect();

    expect(persisted).toEqual(['7', '8']);
    expect(h.stream.cursor).toBe('8');
    expect(h.handshakes[1]).toEqual({ token: 'tok', cursor: '8' });
  });

  it('never rewinds the cursor when a replay redelivers older frames', async () => {
    const h = harness();
    h.stream.onExecutionUpdate('exec-1', () => undefined);
    const socket = await h.connected();

    socket.frame('9', 'exec-1');
    // The dispatcher publishes before it marks rows published, so a crash there
    // re-broadcasts. Taking the lower cursor would make the next reconnect ask
    // for a window it has already consumed.
    socket.frame('4', 'exec-1');

    expect(h.stream.cursor).toBe('9');
  });

  it('compares cursors numerically, not as strings', async () => {
    const h = harness();
    h.stream.onExecutionUpdate('exec-1', () => undefined);
    const socket = await h.connected();

    socket.frame('9', 'exec-1');
    // '10' < '9' lexicographically. The cursor is a BIGSERIAL, and a string
    // comparison would freeze the resume point for the next 90 million frames.
    socket.frame('10', 'exec-1');

    expect(h.stream.cursor).toBe('10');
  });

  it('adopts the server cursor on a fresh session so it starts from now', async () => {
    const h = harness();
    h.stream.onExecutionUpdate('exec-1', () => undefined);
    const socket = await h.connected();

    socket.ready('512');

    expect(h.stream.cursor).toBe('512');
  });

  it('refuses a malformed cursor rather than making it the resume point', async () => {
    const h = harness({ cursor: '41' });
    h.stream.onExecutionUpdate('exec-1', () => undefined);
    const socket = await h.connected();

    socket.frame('not-a-cursor', 'exec-1');
    socket.ready('');

    expect(h.stream.cursor).toBe('41');
  });

  it('keeps persisting from advancing even when the caller cannot store it', async () => {
    const h = harness({
      onCursor: () => {
        throw new Error('disk full');
      },
    });
    h.stream.onExecutionUpdate('exec-1', () => undefined);
    const socket = await h.connected();

    // A checkpoint the caller failed to write is a restart problem, not a reason
    // to tear down a socket in the middle of a trade.
    expect(() => socket.frame('7', 'exec-1')).not.toThrow();
    expect(h.stream.cursor).toBe('7');
  });
});

describe('SocketExecutionStream frame delivery', () => {
  it('wakes only the execution the frame names', async () => {
    const h = harness();
    const one = vi.fn();
    const two = vi.fn();
    h.stream.onExecutionUpdate('exec-1', one);
    h.stream.onExecutionUpdate('exec-2', two);
    const socket = await h.connected();

    socket.frame('1', 'exec-1');

    expect(one).toHaveBeenCalledTimes(1);
    expect(two).not.toHaveBeenCalled();
  });

  it('wakes every listener on the same execution', async () => {
    const h = harness();
    const one = vi.fn();
    const two = vi.fn();
    h.stream.onExecutionUpdate('exec-1', one);
    h.stream.onExecutionUpdate('exec-1', two);
    const socket = await h.connected();

    socket.frame('1', 'exec-1');

    expect(one).toHaveBeenCalledTimes(1);
    expect(two).toHaveBeenCalledTimes(1);
  });

  it('does not let one throwing listener strand the waits behind it', async () => {
    const h = harness();
    const after = vi.fn();
    h.stream.onExecutionUpdate('exec-1', () => {
      throw new Error('listener blew up');
    });
    h.stream.onExecutionUpdate('exec-1', after);
    const socket = await h.connected();

    expect(() => socket.frame('1', 'exec-1')).not.toThrow();
    expect(after).toHaveBeenCalledTimes(1);
    // …and the stream is still usable afterwards.
    expect(h.stream.cursor).toBe('1');
  });

  it('drops a frame with no usable execution id instead of waking everyone', async () => {
    const h = harness();
    const wake = vi.fn();
    h.stream.onExecutionUpdate('exec-1', wake);
    const socket = await h.connected();

    socket.emit(PREDICT_EXECUTION_STREAM, { cursor: '1' });
    socket.emit(PREDICT_EXECUTION_STREAM, { cursor: '1', executionId: '' });
    socket.emit(PREDICT_EXECUTION_STREAM, 'not-a-frame');
    socket.emit(PREDICT_EXECUTION_STREAM, null);

    expect(wake).not.toHaveBeenCalled();
    expect(h.stream.cursor).toBeUndefined();
  });

  it('ignores frames for executions nobody is waiting on', async () => {
    const h = harness();
    const wake = vi.fn();
    h.stream.onExecutionUpdate('exec-1', wake);
    const socket = await h.connected();

    // Another strategy on the same agent wallet shares this socket; its frames
    // still have to move the cursor, or a reconnect would replay them forever.
    socket.frame('12', 'exec-other');

    expect(wake).not.toHaveBeenCalled();
    expect(h.stream.cursor).toBe('12');
  });
});

describe('SocketExecutionStream gap and reconnect reconciliation', () => {
  it('wakes every waiter when the server declares a gap', async () => {
    const h = harness({ cursor: '3' });
    const one = vi.fn();
    const two = vi.fn();
    h.stream.onExecutionUpdate('exec-1', one);
    h.stream.onExecutionUpdate('exec-2', two);
    const socket = await h.connected();

    // The server served nothing and said so. The only correct response is for
    // every waiter to re-read over REST.
    socket.ready('3', true);

    expect(one).toHaveBeenCalledTimes(1);
    expect(two).toHaveBeenCalledTimes(1);
  });

  it('keeps the stale cursor through a gap rather than skipping the unread window', async () => {
    const h = harness({ cursor: '3' });
    h.stream.onExecutionUpdate('exec-1', () => undefined);
    const socket = await h.connected();

    socket.ready('3', true);

    // Forgetting it would turn an unreconciled gap into a silent one if this
    // process died before the REST reads landed.
    expect(h.stream.cursor).toBe('3');
  });

  it('treats an unreadable ready frame as a gap', async () => {
    const h = harness({ cursor: '3' });
    const wake = vi.fn();
    h.stream.onExecutionUpdate('exec-1', wake);
    const socket = await h.connected();

    // Absent `gap` is not evidence of being caught up.
    socket.emit(PREDICT_STREAM_READY, {});

    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('does not wake anyone on the first ready of a healthy session', async () => {
    const h = harness();
    const wake = vi.fn();
    h.stream.onExecutionUpdate('exec-1', wake);
    const socket = await h.connected();

    socket.ready('100');

    // Nothing was missed; a spurious wake is a spurious REST read per wait.
    expect(wake).not.toHaveBeenCalled();
  });

  it('wakes every waiter on a reconnect the server did not call a gap', async () => {
    const h = harness();
    const wake = vi.fn();
    h.stream.onExecutionUpdate('exec-1', wake);
    const socket = await h.connected();
    socket.ready('100');

    await h.reconnect();
    socket.ready('100');

    // A dropped connection loses frames silently. Assuming a clean replay covered
    // it is exactly the assumption that leaves a filled order unnoticed.
    expect(wake).toHaveBeenCalledTimes(1);
  });
});

describe('SocketExecutionStream handshake refusals', () => {
  const refuse = (socket: FakeSocket, reason: string): void => {
    socket.emit('error', { reason });
  };

  it('replaces a token the server refused before reconnecting with it', async () => {
    const refreshed: string[] = [];
    const h = harness({
      refreshToken: async (rejected) => {
        refreshed.push(rejected);
        return await Promise.resolve('tok-2');
      },
    });
    h.stream.onExecutionUpdate('exec-1', () => undefined);
    const socket = await h.connected();

    refuse(socket, 'invalid_token');
    await h.reconnect();

    expect(refreshed).toEqual(['tok']);
    expect(h.handshakes[1]).toEqual({ token: 'tok-2' });
  });

  it('does not re-authenticate for a refusal that is not about the token', async () => {
    const refresh = vi.fn(async () => await Promise.resolve('tok-2'));
    const h = harness({ refreshToken: refresh });
    h.stream.onExecutionUpdate('exec-1', () => undefined);
    const socket = await h.connected();

    // The server has no JWT secret configured. Signing a fresh challenge changes
    // nothing about that.
    refuse(socket, 'not_configured');
    await h.reconnect();

    expect(refresh).not.toHaveBeenCalled();
    expect(h.handshakes[1]).toEqual({ token: 'tok' });
  });

  it('falls back to the current token when re-authentication is not allowed', async () => {
    const h = harness({ refreshToken: async () => await Promise.resolve(undefined) });
    h.stream.onExecutionUpdate('exec-1', () => undefined);
    const socket = await h.connected();

    refuse(socket, 'invalid_token');
    await h.reconnect();

    // `undefined` means this session may not re-authenticate. Sending nothing at
    // all would be refused as `missing_token` and hide the real reason.
    expect(h.handshakes[1]).toEqual({ token: 'tok' });
  });

  it('gives up after a bounded number of consecutive refusals', async () => {
    const degraded: string[] = [];
    const h = harness({ maxHandshakeFailures: 3, onDegraded: (r) => degraded.push(r) });
    h.stream.onExecutionUpdate('exec-1', () => undefined);
    const socket = await h.connected();

    refuse(socket, 'invalid_token');
    refuse(socket, 'invalid_token');
    expect(h.stream.isDegraded).toBe(false);
    refuse(socket, 'invalid_token');

    // A server that has answered three times will answer the same way again;
    // the wait still has its REST poll, which is the whole reason this is safe.
    expect(h.stream.isDegraded).toBe(true);
    expect(socket.disconnects).toBe(1);
    expect(degraded[0]).toContain('invalid_token');
  });

  it('stops reconnecting once it has given up', async () => {
    const h = harness({ maxHandshakeFailures: 1 });
    const off = h.stream.onExecutionUpdate('exec-1', () => undefined);
    const socket = await h.connected();
    refuse(socket, 'invalid_token');
    off();

    h.stream.onExecutionUpdate('exec-2', () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(h.sockets).toHaveLength(1);
  });

  it('resets the budget when a handshake finally succeeds', async () => {
    const h = harness({ maxHandshakeFailures: 3 });
    h.stream.onExecutionUpdate('exec-1', () => undefined);
    const socket = await h.connected();

    refuse(socket, 'invalid_token');
    refuse(socket, 'invalid_token');
    socket.ready('1');
    refuse(socket, 'invalid_token');
    refuse(socket, 'invalid_token');

    // The budget is for CONSECUTIVE refusals. A day-long strategy that meets one
    // expiry an hour must not accumulate its way into a dead stream.
    expect(h.stream.isDegraded).toBe(false);
  });
});
