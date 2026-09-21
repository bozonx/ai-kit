import type { WebSocket as WebSocketClient } from 'ws';

type WebSocketConstructor = typeof WebSocketClient;

import { AiError } from '../../errors.js';

/**
 * A WebSocket in the shape the streaming adapters want.
 *
 * `ws` rather than the platform's own WebSocket because every speech provider
 * authenticates a live session with a request header, and the standard
 * constructor has nowhere to put one. Handing a short-lived provider token to a
 * browser is the alternative, and it is rejected for a different reason: the
 * clock that decides what a session costs must not run on the client.
 *
 * It is an optional peer dependency, loaded the first time a live session is
 * opened: a product that transcribes files and never dictates has no reason to
 * carry it.
 */

export interface SocketSession {
  /** Text frames, in arrival order. Ends when the socket closes. */
  messages: AsyncIterable<string>;
  send(data: Uint8Array | string): void;
  /** Closes the socket. Safe to call more than once. */
  close(payload?: string): void;
}

export interface OpenSocketOptions {
  headers?: Record<string, string>;
  protocols?: string[];
  signal: AbortSignal;
  context: { provider: string; model: string };
}

async function loadWebSocket(): Promise<WebSocketConstructor> {
  try {
    return (await import('ws')).WebSocket;
  } catch (cause) {
    throw new AiError(
      'invalid_request',
      'Live transcription needs the optional peer dependency "ws". Add it as a dependency to use a realtime speech model.',
      { cause },
    );
  }
}

export async function openSocket(url: string, options: OpenSocketOptions): Promise<SocketSession> {
  const { context } = options;
  const WebSocket = await loadWebSocket();
  const socket: WebSocketClient = new WebSocket(url, options.protocols ?? [], {
    headers: options.headers,
  });

  const queue: string[] = [];
  let notify: (() => void) | undefined;
  let done = false;
  let failure: AiError | undefined;

  const wake = (): void => {
    notify?.();
    notify = undefined;
  };

  const fail = (error: AiError): void => {
    failure ??= error;
    done = true;
    wake();
  };

  socket.on('message', data => {
    queue.push(typeof data === 'string' ? data : data.toString('utf8'));
    wake();
  });
  socket.on('error', cause => {
    fail(
      new AiError('provider_unavailable', `${context.provider} live session failed`, {
        ...context,
        cause,
      }),
    );
  });
  socket.on('close', (code, reason) => {
    // 1000 and 1005 are the ways a session ends on purpose; anything else cut
    // the transcript short and the caller has to be told, because the words
    // already delivered are still owed and still shown.
    if (code !== 1000 && code !== 1005 && !failure) {
      failure = new AiError(
        'provider_unavailable',
        `${context.provider} closed the live session (${code}${reason.length > 0 ? `: ${reason.toString('utf8')}` : ''})`,
        context,
      );
    }
    done = true;
    wake();
  });

  const onAbort = (): void => {
    fail(new AiError('aborted', 'The live session was aborted'));
    socket.close(1000);
  };
  options.signal.addEventListener('abort', onAbort, { once: true });

  const messages: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      try {
        for (;;) {
          const message = queue.shift();
          if (message !== undefined) {
            yield message;
            continue;
          }
          if (done) {
            if (failure) throw failure;
            return;
          }
          await new Promise<void>(resolve => {
            notify = resolve;
          });
        }
      } finally {
        options.signal.removeEventListener('abort', onAbort);
      }
    },
  };

  const session: SocketSession = {
    messages,
    send: data => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    },
    close: payload => {
      if (socket.readyState === WebSocket.OPEN) {
        if (payload !== undefined) socket.send(payload);
        socket.close(1000);
      }
    },
  };

  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve(session));
    socket.once('error', cause => {
      reject(
        new AiError('provider_unavailable', `Cannot open a live session with ${context.provider}`, {
          ...context,
          cause,
        }),
      );
    });
    if (options.signal.aborted) {
      socket.close(1000);
      reject(new AiError('aborted', 'The live session was aborted'));
    }
  });
}
