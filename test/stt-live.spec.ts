import { describe, it, expect, afterEach } from '@jest/globals';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';

import { isAiError } from '../src/errors.js';
import { assemblyAiSttProvider } from '../src/stt/providers/assemblyai.js';
import { deepgramSttProvider } from '../src/stt/providers/deepgram.js';
import { openSocket } from '../src/stt/providers/socket.js';
import type {
  AudioChunk,
  ProviderStreamRequest,
  SttProvider,
  SttStreamEvent,
} from '../src/stt/types.js';

/**
 * Live sessions, against a real socket.
 *
 * A mocked WebSocket proves nothing here: everything that goes wrong in a live
 * transcription goes wrong in the socket — a session closed without a reason,
 * an abort in the middle of a sentence, a provider that keeps talking after
 * the audio has stopped.
 */

let server: WebSocketServer | undefined;

/** Starts a server that plays a script at whoever connects. */
async function serve(
  onConnection: (
    socket: WebSocket,
    request: { url?: string; headers: Record<string, unknown> },
  ) => void,
): Promise<string> {
  const created = new WebSocketServer({ port: 0 });
  server = created;
  await new Promise<void>(resolve => created.once('listening', resolve));
  created.on('connection', (socket, request) => {
    onConnection(socket, { url: request.url, headers: request.headers });
  });
  const { port } = created.address() as AddressInfo;
  return `ws://127.0.0.1:${String(port)}`;
}

afterEach(async () => {
  const running = server;
  server = undefined;
  if (running) await new Promise<void>(resolve => running.close(() => resolve()));
});

const audio: AsyncIterable<AudioChunk> = {
  // eslint-disable-next-line @typescript-eslint/require-await
  async *[Symbol.asyncIterator]() {
    yield { data: new Uint8Array([1, 2, 3, 4]) };
  },
};

/** Opens a live session, refusing an adapter that does not have one. */
function live(provider: SttProvider, request: ProviderStreamRequest) {
  if (!provider.transcribeStream) throw new Error('This adapter has no live session');
  return provider.transcribeStream(request);
}

async function collect(events: AsyncIterable<SttStreamEvent>): Promise<SttStreamEvent[]> {
  const seen: SttStreamEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

describe('openSocket', () => {
  it('delivers messages in order and ends when the server closes cleanly', async () => {
    const url = await serve(socket => {
      socket.send('one');
      socket.send('two');
      socket.close(1000);
    });

    const session = await openSocket(url, {
      signal: AbortSignal.timeout(5_000),
      context: { provider: 'test', model: 'test' },
    });

    const messages: string[] = [];
    for await (const message of session.messages) messages.push(message);
    expect(messages).toEqual(['one', 'two']);
  });

  it('reports a session the server cut short, because the words are still owed', async () => {
    const url = await serve(socket => {
      socket.send('one');
      socket.close(1011, 'internal');
    });

    const session = await openSocket(url, {
      signal: AbortSignal.timeout(5_000),
      context: { provider: 'test', model: 'test' },
    });

    const messages: string[] = [];
    const error = await (async () => {
      try {
        for await (const message of session.messages) messages.push(message);
        return undefined;
      } catch (caught: unknown) {
        return caught;
      }
    })();

    expect(messages).toEqual(['one']);
    expect(isAiError(error) && error.kind).toBe('provider_unavailable');
  });

  it('carries the authorization header, which is why it is not the platform socket', async () => {
    let seen: unknown;
    const url = await serve((socket, request) => {
      seen = request.headers.authorization;
      socket.close(1000);
    });

    const session = await openSocket(url, {
      headers: { authorization: 'Token secret' },
      signal: AbortSignal.timeout(5_000),
      context: { provider: 'test', model: 'test' },
    });
    for await (const _ of session.messages) void _;

    expect(seen).toBe('Token secret');
  });

  it('fails rather than hanging when nobody is listening at the other end', async () => {
    const error = await openSocket('ws://127.0.0.1:1/nothing', {
      signal: AbortSignal.timeout(5_000),
      context: { provider: 'test', model: 'test' },
    }).catch((caught: unknown) => caught);

    expect(isAiError(error) && error.kind).toBe('provider_unavailable');
  });

  it('ends the session when the caller aborts', async () => {
    const controller = new AbortController();
    const url = await serve(socket => {
      socket.send('one');
    });

    const session = await openSocket(url, {
      signal: controller.signal,
      context: { provider: 'test', model: 'test' },
    });

    const messages: string[] = [];
    const error = await (async () => {
      try {
        for await (const message of session.messages) {
          messages.push(message);
          controller.abort();
        }
        return undefined;
      } catch (caught: unknown) {
        return caught;
      }
    })();

    expect(messages).toEqual(['one']);
    expect(isAiError(error) && error.kind).toBe('aborted');
  });
});

describe('the Deepgram live session', () => {
  it('separates drafts from settled speech and times both in milliseconds', async () => {
    const url = await serve(socket => {
      socket.on('message', () => undefined);
      socket.send(
        JSON.stringify({
          type: 'Results',
          is_final: false,
          start: 0,
          duration: 0.5,
          channel: { alternatives: [{ transcript: 'при' }] },
        }),
      );
      socket.send(
        JSON.stringify({
          type: 'Results',
          is_final: true,
          start: 0,
          duration: 0.9,
          channel: { alternatives: [{ transcript: 'Привет' }] },
        }),
      );
      // Empty transcripts arrive constantly during silence and mean nothing.
      socket.send(
        JSON.stringify({
          type: 'Results',
          is_final: true,
          channel: { alternatives: [{ transcript: '' }] },
        }),
      );
      socket.send(JSON.stringify({ type: 'Metadata' }));
      setTimeout(() => socket.close(1000), 50);
    });

    const events = await collect(
      await live(deepgramSttProvider({ apiKey: 'k', baseUrl: url }), {
        modelId: 'nova-3',
        options: { language: 'ru' },
        sampleRate: 16_000,
        audio,
        signal: AbortSignal.timeout(5_000),
      }),
    );

    expect(events).toEqual([
      { type: 'partial', text: 'при', startMs: 0 },
      { type: 'final', segment: { startMs: 0, endMs: 900, text: 'Привет' } },
    ]);
  });

  it('describes the audio it is about to send in the query string', async () => {
    let path: string | undefined;
    const url = await serve((socket, request) => {
      path = request.url;
      socket.close(1000);
    });

    await collect(
      await live(deepgramSttProvider({ apiKey: 'k', baseUrl: url }), {
        modelId: 'nova-3',
        options: { language: 'ru' },
        sampleRate: 24_000,
        audio,
        signal: AbortSignal.timeout(5_000),
      }),
    );

    expect(path).toContain('encoding=linear16');
    expect(path).toContain('sample_rate=24000');
    expect(path).toContain('interim_results=true');
  });
});

describe('the AssemblyAI live session', () => {
  it('treats the end of a turn as settled text and everything before it as a draft', async () => {
    const url = await serve(socket => {
      socket.on('message', () => undefined);
      socket.send(JSON.stringify({ type: 'Turn', transcript: 'hel', end_of_turn: false }));
      socket.send(
        JSON.stringify({
          type: 'Turn',
          transcript: 'Hello there.',
          end_of_turn: true,
          words: [
            { start: 100, end: 400, text: 'Hello' },
            { start: 400, end: 800, text: 'there.' },
          ],
        }),
      );
      setTimeout(() => socket.close(1000), 50);
    });

    const events = await collect(
      await live(assemblyAiSttProvider({ apiKey: 'k', baseUrl: url }), {
        modelId: 'universal-streaming',
        options: {},
        sampleRate: 16_000,
        audio,
        signal: AbortSignal.timeout(5_000),
      }),
    );

    expect(events).toEqual([
      { type: 'partial', text: 'hel', startMs: 0 },
      { type: 'final', segment: { startMs: 100, endMs: 800, text: 'Hello there.' } },
    ]);
  });
});
