import type { WebSocket as WebSocketClient } from 'ws';

import { AiError } from '../errors.js';
import type { SocketOpener, SocketSession } from '../ports.js';
import { CLOSE_GRACE_MS, createMessageQueue, isNormalClose } from '../transport/message-queue.js';

type WebSocketConstructor = typeof WebSocketClient;

/**
 * A socket opener backed by `ws`.
 *
 * The platform WebSocket sends headers on current Node, so this is not needed
 * to dictate on a server. It is for a host that wants the implementation it
 * already knows, or runs somewhere the platform socket falls short.
 *
 * `ws` is an optional peer dependency, loaded the first time a session opens.
 */
async function loadWebSocket(): Promise<WebSocketConstructor> {
  try {
    return (await import('ws')).WebSocket;
  } catch (cause) {
    throw new AiError(
      'invalid_request',
      'The `ws` socket opener needs the optional peer dependency "ws". Add it as a dependency, or use the platform socket.',
      { cause },
    );
  }
}

export const wsSocketOpener: SocketOpener = async (url, options) => {
  const WebSocket = await loadWebSocket();
  const socket: WebSocketClient = new WebSocket(url, options.protocols ?? [], {
    headers: options.headers,
  });

  const onAbort = (): void => socket.close(1000);
  const queue = createMessageQueue(() => options.signal.removeEventListener('abort', onAbort));

  socket.on('message', data => {
    queue.push(typeof data === 'string' ? data : data.toString('utf8'));
  });
  socket.on('error', cause => queue.fail(cause));
  let grace: ReturnType<typeof setTimeout> | undefined;
  socket.on('close', (code, reason) => {
    clearTimeout(grace);
    if (isNormalClose(code)) {
      queue.end();
    } else {
      const text = reason.toString('utf8');
      queue.fail(new Error(`closed with ${code}${text.length > 0 ? `: ${text}` : ''}`));
    }
  });
  options.signal.addEventListener('abort', onAbort, { once: true });

  const session: SocketSession = {
    messages: queue.messages,
    send: data => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    },
    close: payload => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (payload === undefined) {
        socket.close(1000);
        return;
      }
      // Left to the server, which flushes the last results before closing.
      socket.send(payload);
      grace ??= setTimeout(() => socket.close(1000), CLOSE_GRACE_MS);
    },
  };

  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(session));
    socket.once('error', reject);
    if (options.signal.aborted) {
      socket.close(1000);
      reject(new AiError('aborted', 'The live session was aborted'));
    }
  });
};
