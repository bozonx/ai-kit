import { describe, it, expect, afterEach } from '@jest/globals';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';

import { isAiError } from '../src/errors.js';
import { assemblyAiSttProvider } from '../src/stt/providers/assemblyai.js';
import { deepgramSttProvider } from '../src/stt/providers/deepgram.js';
import { createPcm16ToFloat32, sherpaOnnxSttProvider } from '../src/stt/providers/sherpa-onnx.js';
import { wsSocketOpener } from '../src/node/ws.js';
import type { SocketOpener } from '../src/ports.js';
import { openSocket } from '../src/stt/providers/socket.js';
import { platformSocket } from '../src/transport/platform.js';
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

const openers: Array<[string, SocketOpener]> = [
  ['the platform WebSocket', platformSocket],
  ['ws', wsSocketOpener],
];

describe.each(openers)('openSocket over %s', (_name, opener) => {
  it('delivers messages in order and ends when the server closes cleanly', async () => {
    const url = await serve(socket => {
      socket.send('one');
      socket.send('two');
      socket.close(1000);
    });

    const session = await openSocket(url, {
      signal: AbortSignal.timeout(5_000),
      context: { provider: 'test', model: 'test' },
      openSocket: opener,
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
      openSocket: opener,
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

  it('carries the authorization header', async () => {
    let seen: unknown;
    const url = await serve((socket, request) => {
      seen = request.headers.authorization;
      socket.close(1000);
    });

    const session = await openSocket(url, {
      headers: { authorization: 'Token secret' },
      signal: AbortSignal.timeout(5_000),
      context: { provider: 'test', model: 'test' },
      openSocket: opener,
    });
    for await (const _ of session.messages) void _;

    expect(seen).toBe('Token secret');
  });

  it('still delivers what the server sends after being told the stream is over', async () => {
    const url = await serve(socket => {
      socket.on('message', (data: Buffer) => {
        if (data.toString() !== 'end') return;
        socket.send('tail');
        setTimeout(() => socket.close(1000), 20);
      });
    });

    const session = await openSocket(url, {
      signal: AbortSignal.timeout(5_000),
      context: { provider: 'test', model: 'test' },
      openSocket: opener,
    });
    session.close('end');

    const messages: string[] = [];
    for await (const message of session.messages) messages.push(message);
    expect(messages).toEqual(['tail']);
  });

  it('fails rather than hanging when nobody is listening at the other end', async () => {
    const error = await openSocket('ws://127.0.0.1:1/nothing', {
      signal: AbortSignal.timeout(5_000),
      context: { provider: 'test', model: 'test' },
      openSocket: opener,
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
      openSocket: opener,
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

  it('detaches the connection deadline after the socket opens', async () => {
    const connect = new AbortController();
    const lifetime = new AbortController();
    const url = await serve(socket => {
      setTimeout(() => {
        socket.send('late');
        socket.close(1000);
      }, 20);
    });

    const session = await openSocket(url, {
      signal: connect.signal,
      lifetimeSignal: lifetime.signal,
      context: { provider: 'test', model: 'test' },
      openSocket: opener,
    });
    connect.abort();

    const messages: string[] = [];
    for await (const message of session.messages) messages.push(message);
    expect(messages).toEqual(['late']);
  });
});

describe('the Deepgram live session', () => {
  it('reports a dropped socket without waiting for the microphone to end', async () => {
    const neverEndingAudio: AsyncIterable<AudioChunk> = {
      [Symbol.asyncIterator]() {
        return { next: () => new Promise<IteratorResult<AudioChunk>>(() => undefined) };
      },
    };
    const provider = deepgramSttProvider({
      apiKey: 'k',
      openSocket: () =>
        Promise.resolve({
          send: () => undefined,
          close: () => undefined,
          messages: {
            [Symbol.asyncIterator]() {
              return { next: () => Promise.reject(new Error('provider disconnected')) };
            },
          },
        }),
    });
    const events = await live(provider, {
      modelId: 'nova-3',
      options: {},
      sampleRate: 16_000,
      audio: neverEndingAudio,
      signal: new AbortController().signal,
    });
    await expect(collect(events)).rejects.toThrow('provider disconnected');
  });
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

  it('follows any spoken language when none is set, as a live session cannot detect one', async () => {
    let path: string | undefined;
    const url = await serve((socket, request) => {
      path = request.url;
      socket.close(1000);
    });

    await collect(
      await live(deepgramSttProvider({ apiKey: 'k', baseUrl: url }), {
        modelId: 'nova-3',
        options: {},
        sampleRate: 16_000,
        audio,
        signal: AbortSignal.timeout(5_000),
      }),
    );

    expect(path).toContain('language=multi');
    expect(path).toContain('endpointing=100');
    expect(path).not.toContain('detect_language');
  });

  it('keeps the multilingual endpointing when the caller names it, and only then', async () => {
    const paths: string[] = [];
    const url = await serve((socket, request) => {
      paths.push(request.url ?? '');
      socket.close(1000);
    });

    for (const language of ['multi', 'ru']) {
      await collect(
        await live(deepgramSttProvider({ apiKey: 'k', baseUrl: url }), {
          modelId: 'nova-3',
          options: { language },
          sampleRate: 16_000,
          audio,
          signal: AbortSignal.timeout(5_000),
        }),
      );
    }

    expect(paths[0]).toContain('language=multi');
    expect(paths[0]).toContain('endpointing=100');
    expect(paths[1]).toContain('language=ru');
    expect(paths[1]).not.toContain('endpointing');
  });
});

describe('the AssemblyAI live session', () => {
  it('emits a formatted turn once and sends the selected model', async () => {
    let path: string | undefined;
    const url = await serve((socket, request) => {
      path = request.url;
      for (const formatted of [false, true]) {
        socket.send(
          JSON.stringify({
            type: 'Turn',
            turn_order: 0,
            transcript: formatted ? 'Hello.' : 'hello',
            end_of_turn: true,
            turn_is_formatted: formatted,
          }),
        );
      }
      setTimeout(() => socket.close(1000), 20);
    });
    const events = await collect(
      await live(assemblyAiSttProvider({ apiKey: 'k', baseUrl: url }), {
        modelId: 'whisper-rt',
        options: {},
        sampleRate: 16_000,
        audio,
        signal: AbortSignal.timeout(5_000),
      }),
    );
    expect(path).toContain('speech_model=whisper-rt');
    expect(events).toEqual([
      { type: 'partial', text: 'hello', startMs: 0 },
      { type: 'final', segment: { startMs: 0, endMs: 0, text: 'Hello.' } },
    ]);
  });
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

/** Float32 little-endian samples, as the sherpa-onnx server reads them. */
function floats(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.byteLength / 4 }, (_, index) =>
    view.getFloat32(index * 4, true),
  );
}

function pcm16(...samples: number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return bytes;
}

describe('PCM16 for the sherpa-onnx server', () => {
  it('scales samples to float32 as they are when the rates match', () => {
    const convert = createPcm16ToFloat32(16_000, 16_000);
    expect(floats(convert(pcm16(0, 16_384, -32_768)))).toEqual([0, 0.5, -1]);
  });

  it('interpolates across chunk boundaries when the capture rate is lower', () => {
    const convert = createPcm16ToFloat32(8_000, 16_000);
    const first = floats(convert(pcm16(0, 16_384)));
    const second = floats(convert(pcm16(0)));
    expect(first).toEqual([0, 0.25, 0.5]);
    // The sample between the chunks is interpolated from both of them.
    expect(second).toEqual([0.25, 0]);
  });

  it('refuses audio that is not whole PCM16 samples', () => {
    const convert = createPcm16ToFloat32(16_000, 16_000);
    expect(() => convert(new Uint8Array(3))).toThrow('odd number of bytes');
  });
});

describe('the sherpa-onnx live session', () => {
  const result = (fields: Record<string, unknown>): string =>
    JSON.stringify({ tokens: [], ys_probs: [], words: [], is_eof: false, ...fields });

  it('streams float32 audio, ends it with Done, and settles each segment once', async () => {
    const received: Array<string | number[]> = [];
    const url = await serve(socket => {
      socket.on('message', (data: Buffer, isBinary: boolean) => {
        if (!isBinary) {
          received.push(data.toString());
          socket.send(
            result({
              text: 'HOW ARE YOU',
              segment: 1,
              start_time: 1.5,
              timestamps: [0, 0.4],
              is_final: true,
            }),
          );
          socket.send('Done!');
          return;
        }
        received.push(floats(new Uint8Array(data)));
        socket.send(result({ text: '', segment: 0, start_time: 0, is_final: false }));
        socket.send(result({ text: 'HELLO', segment: 0, start_time: 0, is_final: false }));
        // Repeated after every decoding step until something changes.
        socket.send(result({ text: 'HELLO', segment: 0, start_time: 0, is_final: false }));
        socket.send(
          result({
            text: 'HELLO WORLD',
            segment: 0,
            start_time: 0,
            timestamps: [0.1, 0.9],
            is_final: true,
          }),
        );
        socket.send(result({ text: 'HOW', segment: 1, start_time: 1.5, is_final: false }));
      });
    });

    const events = await collect(
      await live(sherpaOnnxSttProvider({ apiKey: '', baseUrl: url }), {
        modelId: 'server-model',
        options: { language: 'en' },
        sampleRate: 16_000,
        audio: {
          // eslint-disable-next-line @typescript-eslint/require-await
          async *[Symbol.asyncIterator]() {
            yield { data: pcm16(16_384) };
          },
        },
        signal: AbortSignal.timeout(5_000),
      }),
    );

    expect(received).toEqual([[0.5], 'Done']);
    expect(events).toEqual([
      { type: 'partial', text: 'HELLO', startMs: 0 },
      { type: 'final', segment: { startMs: 0, endMs: 900, text: 'HELLO WORLD' } },
      { type: 'partial', text: 'HOW', startMs: 1500 },
      { type: 'final', segment: { startMs: 1500, endMs: 1900, text: 'HOW ARE YOU' } },
    ]);
  });

  it('clears a draft that its segment ended without', async () => {
    const url = await serve(socket => {
      socket.on('message', () => undefined);
      socket.send(result({ text: 'UH', segment: 0, start_time: 0, is_final: false }));
      socket.send(result({ text: '', segment: 0, start_time: 0, is_final: true }));
      socket.send('Done!');
    });

    const events = await collect(
      await live(sherpaOnnxSttProvider({ apiKey: '', baseUrl: url }), {
        modelId: 'server-model',
        options: {},
        sampleRate: 16_000,
        audio,
        signal: AbortSignal.timeout(5_000),
      }),
    );

    expect(events).toEqual([
      { type: 'partial', text: 'UH', startMs: 0 },
      { type: 'partial', text: '', startMs: 0 },
    ]);
  });

  it('names the provider when the server cannot be reached', async () => {
    const provider = sherpaOnnxSttProvider({ apiKey: '', baseUrl: 'ws://127.0.0.1:1' });
    await expect(
      live(provider, {
        modelId: 'server-model',
        options: {},
        sampleRate: 16_000,
        audio,
        signal: AbortSignal.timeout(5_000),
      }),
    ).rejects.toThrow('sherpa-onnx');
  });

  it('has no batch transcription', async () => {
    const provider = sherpaOnnxSttProvider({ apiKey: '' });
    await expect(
      provider.transcribe({
        modelId: 'server-model',
        source: { data: new Uint8Array(), mimeType: 'audio/wav' },
        options: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('live audio only');
  });
});
