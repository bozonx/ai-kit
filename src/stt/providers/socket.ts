import { AiError, isAiError } from '../../errors.js';
import type { SocketOpener, SocketSession } from '../../ports.js';
import { platformSocket } from '../../transport/platform.js';

/**
 * A live session through whichever socket the host supplied, with its
 * failures in the vocabulary the retry loop reads.
 *
 * The opener is a port and only promises plain errors; naming the provider,
 * telling an abort from an outage and keeping configuration errors
 * non-retryable happens here, once, for every opener.
 */

export interface OpenSessionOptions {
  headers?: Record<string, string>;
  protocols?: string[];
  signal: AbortSignal;
  /** Session-lifetime cancellation; defaults to the connection signal. */
  lifetimeSignal?: AbortSignal;
  context: { provider: string; model: string };
  /** Defaults to the platform WebSocket. */
  openSocket?: SocketOpener;
}

const aborted = (signal: AbortSignal): AiError =>
  (signal.reason as { name?: string } | undefined)?.name === 'TimeoutError'
    ? new AiError('timeout', 'Opening the live session ran out of its time budget')
    : new AiError('aborted', 'The live session was aborted');

export async function openSocket(url: string, options: OpenSessionOptions): Promise<SocketSession> {
  const { context, signal } = options;
  const lifetimeSignal = options.lifetimeSignal ?? signal;
  if (signal.aborted) throw aborted(signal);

  let session: SocketSession;
  try {
    session = await (options.openSocket ?? platformSocket)(url, {
      connectSignal: signal,
      signal: lifetimeSignal,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.protocols === undefined ? {} : { protocols: options.protocols }),
    });
  } catch (cause) {
    if (signal.aborted) throw aborted(signal);
    if (isAiError(cause)) throw cause;
    throw new AiError(
      'provider_unavailable',
      `Cannot open a live session with ${context.provider}`,
      {
        ...context,
        cause,
      },
    );
  }

  const messages: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      try {
        yield* session.messages;
      } catch (cause) {
        if (lifetimeSignal.aborted) throw aborted(lifetimeSignal);
        if (isAiError(cause)) throw cause;
        // Anything but a clean close cut the transcript short, and the caller
        // has to be told: the words already delivered are still owed and shown.
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new AiError(
          'provider_unavailable',
          `${context.provider} live session failed: ${reason}`,
          {
            ...context,
            cause,
          },
        );
      }
      if (lifetimeSignal.aborted) throw aborted(lifetimeSignal);
    },
  };

  return { messages, send: data => session.send(data), close: payload => session.close(payload) };
}
