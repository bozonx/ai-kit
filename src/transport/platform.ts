import { AiError } from '../errors.js';
import type { FetchFunction, SocketOpener, SocketSession, Transport } from '../ports.js';
import { CLOSE_GRACE_MS, createMessageQueue, isNormalClose } from './message-queue.js';

/**
 * The platform's own network, which is the default transport.
 *
 * Both are looked up at call time rather than captured when the module loads,
 * so that a host which installs or replaces `fetch` later — a polyfill, a test
 * double — is the one that gets used.
 */

export const platformFetch: FetchFunction = (input, init) => globalThis.fetch(input, init);

/**
 * The standard WebSocket.
 *
 * The standard constructor has nowhere to put a request header, and every
 * speech provider authenticates a live session with one. Node, Deno and Bun
 * accept headers through a non-standard second argument, and that is what is
 * used when there are headers to send. A browser refuses it, and refuses it
 * with a configuration error rather than a provider outage: the fix is a
 * `transport.openSocket` that can send headers, not another attempt.
 */
export const platformSocket: SocketOpener = (url, options) => {
  const Socket = globalThis.WebSocket as typeof WebSocket | undefined;
  if (Socket === undefined) {
    return Promise.reject(
      new AiError(
        'invalid_request',
        'This runtime has no WebSocket. Pass `transport.openSocket` to use a realtime speech model.',
      ),
    );
  }

  const headers = options.headers ?? {};
  const protocols = options.protocols ?? [];
  let socket: WebSocket;
  try {
    socket =
      Object.keys(headers).length === 0
        ? new Socket(url, protocols)
        : new Socket(url, { protocols, headers } as unknown as string[]);
  } catch (cause) {
    return Promise.reject(
      new AiError(
        'invalid_request',
        "This runtime's WebSocket cannot send request headers, which the speech provider needs. Pass a `transport.openSocket` that can.",
        { cause },
      ),
    );
  }
  socket.binaryType = 'arraybuffer';

  const decoder = new TextDecoder();
  const connectSignal = options.connectSignal ?? options.signal;
  const onAbort = (): void => socket.close(1000);
  const queue = createMessageQueue(() => options.signal.removeEventListener('abort', onAbort));

  socket.addEventListener('message', event => {
    const data: unknown = event.data;
    queue.push(typeof data === 'string' ? data : decoder.decode(data as ArrayBuffer));
  });
  let grace: ReturnType<typeof setTimeout> | undefined;
  socket.addEventListener('close', event => {
    clearTimeout(grace);
    if (isNormalClose(event.code)) {
      queue.end();
    } else {
      queue.fail(
        new Error(`closed with ${event.code}${event.reason.length > 0 ? `: ${event.reason}` : ''}`),
      );
    }
  });
  options.signal.addEventListener('abort', onAbort, { once: true });

  const session: SocketSession = {
    messages: queue.messages,
    send: data => {
      if (socket.readyState === Socket.OPEN) socket.send(data);
    },
    close: payload => {
      if (socket.readyState !== Socket.OPEN) return;
      if (payload === undefined) {
        socket.close(1000);
        return;
      }
      // A closing socket drops every frame that arrives after it, which here
      // would be the tail of the transcript: the server closes, not us.
      socket.send(payload);
      grace ??= setTimeout(() => socket.close(1000), CLOSE_GRACE_MS);
    },
  };

  return new Promise((resolve, reject) => {
    const onConnectAbort = (): void => {
      socket.close(1000);
      reject(new AiError('aborted', 'Opening the live session was aborted'));
    };
    const finishOpening = (): void => connectSignal.removeEventListener('abort', onConnectAbort);
    socket.addEventListener(
      'open',
      () => {
        finishOpening();
        resolve(session);
      },
      { once: true },
    );
    // The platform socket says nothing useful about why it failed: an error
    // event carries no reason, and the close that follows carries 1006.
    socket.addEventListener(
      'error',
      () => {
        finishOpening();
        reject(new Error('the socket failed'));
      },
      { once: true },
    );
    connectSignal.addEventListener('abort', onConnectAbort, { once: true });
    if (connectSignal.aborted || options.signal.aborted) {
      finishOpening();
      socket.close(1000);
      reject(new AiError('aborted', 'The live session was aborted'));
    }
  });
};

/** The platform's transport with whatever the host replaced laid over it. */
export function resolveTransport(overrides: Partial<Transport> = {}): Transport {
  return {
    fetch: overrides.fetch ?? platformFetch,
    openSocket: overrides.openSocket ?? platformSocket,
  };
}
