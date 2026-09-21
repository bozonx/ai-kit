import { describe, it, expect, afterEach } from '@jest/globals';
import { generateText } from 'ai';

import { Catalog } from '../src/catalog/catalog.js';
import { AiError, isAiError } from '../src/errors.js';
import type { FetchFunction, SocketOpener, SocketSession } from '../src/ports.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { openAiCompatibleSttProvider } from '../src/stt/providers/openai-compatible.js';
import { openSocket } from '../src/stt/providers/socket.js';
import { SttProviderRegistry } from '../src/stt/registry.js';
import type { ProviderTranscribeRequest } from '../src/stt/types.js';
import { platformSocket, resolveTransport, platformFetch } from '../src/transport/platform.js';
import { MtProviderRegistry } from '../src/translate/registry.js';

/**
 * The network as a port.
 *
 * What these tests hold the package to is that a host which supplies its own
 * `fetch` or socket gets every request through it — the one that slips past is
 * the one a Tauri app finds blocked by CORS in production.
 */

interface Call {
  url: string;
  init: RequestInit;
}

/** A `fetch` that answers every request with `body` and records what was asked. */
function recordingFetch(body: unknown, status = 200): { fetch: FetchFunction; calls: Call[] } {
  const calls: Call[] = [];
  const fetch = ((input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: input instanceof Request ? input.url : String(input), init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as FetchFunction;
  return { fetch, calls };
}

function headersOf(init: RequestInit): Headers {
  return new Headers(init.headers);
}

const catalog = Catalog.fromYaml(`
models:
  - name: local
    provider: openai-compatible
    model: llama3
    baseUrl: http://localhost:11434/v1
    tier: standard
    contextSize: 8192
    maxOutputTokens: 1024
    pricing:
      version: 'test'
      inputPerMTok: 0
      outputPerMTok: 0
    routes:
      - provider: deepseek
        model: deepseek-chat
      - provider: groq
        model: whisper-large-v3
      - provider: google-translate
        model: nmt
      - provider: bare
        model: bare-model
taskClasses:
  chat: [local]
`);

const model = catalog.require('local');
const [local, deepseek, groq, translate, bare] = catalog.routesOf('local');
if (!local || !deepseek || !groq || !translate || !bare) throw new Error('Test catalog is short');

const keys = { get: () => Promise.resolve('secret') };
const noKey = { get: () => Promise.resolve('') };

describe('resolveTransport', () => {
  it('fills in the platform for whatever the host did not supply', () => {
    const { fetch } = recordingFetch({});
    const transport = resolveTransport({ fetch });

    expect(transport.fetch).toBe(fetch);
    expect(transport.openSocket).toBe(platformSocket);
    expect(resolveTransport().fetch).toBe(platformFetch);
  });
});

describe('the language model registry with a transport', () => {
  it("hands the host's fetch to every adapter, custom ones included", async () => {
    const { fetch } = recordingFetch({});
    const seen: Array<FetchFunction | undefined> = [];
    const registry = new ProviderRegistry({
      keys,
      transport: resolveTransport({ fetch }),
      factories: {
        bare: params => {
          seen.push(params.fetch);
          return 'bare' as never;
        },
      },
    });

    await registry.languageModel(model, bare);

    expect(seen).toEqual([fetch]);
  });

  it('talks to an OpenAI-compatible server at its endpoint, through that fetch', async () => {
    const { fetch, calls } = recordingFetch({
      id: 'c1',
      object: 'chat.completion',
      created: 0,
      model: 'llama3',
      choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    });
    const registry = new ProviderRegistry({ keys: noKey, transport: resolveTransport({ fetch }) });

    const result = await generateText({
      model: await registry.languageModel(model, local),
      prompt: 'hello',
      maxRetries: 0,
    });

    expect(result.text).toBe('hi');
    expect(calls[0]?.url).toBe('http://localhost:11434/v1/chat/completions');
    // A local server has no key, and an empty bearer token is a refusal.
    expect(headersOf(calls[0]?.init ?? {}).has('authorization')).toBe(false);
  });

  it('sends the key as a bearer token when there is one', async () => {
    const { fetch, calls } = recordingFetch({
      id: 'c1',
      object: 'chat.completion',
      created: 0,
      model: 'llama3',
      choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
    });
    const registry = new ProviderRegistry({ keys, transport: resolveTransport({ fetch }) });

    await generateText({
      model: await registry.languageModel(model, local),
      prompt: 'hello',
      maxRetries: 0,
    });

    expect(headersOf(calls[0]?.init ?? {}).get('authorization')).toBe('Bearer secret');
  });

  it('refuses an OpenAI-compatible route without an endpoint, as a catalog mistake', async () => {
    const registry = new ProviderRegistry({ keys });
    const { baseUrl: _, ...withoutEndpoint } = local;

    const error = await registry
      .languageModel(model, { ...withoutEndpoint })
      .catch((caught: unknown) => caught);

    expect(isAiError(error) && error.kind).toBe('invalid_request');
    expect((error as Error).message).toMatch(/baseUrl/);
  });

  it('ships DeepSeek, and an embedding adapter for OpenAI-compatible servers', async () => {
    const registry = new ProviderRegistry({ keys });

    expect(registry.has('deepseek')).toBe(true);
    const built = await registry.languageModel(model, deepseek);
    expect(typeof built === 'object' && built.provider).toMatch(/deepseek/);

    const embedding = await registry.embeddingModel(model, local);
    expect(typeof embedding === 'object' && embedding.modelId).toBe('llama3');
  });
});

describe('the speech and translation registries with a transport', () => {
  it('send speech through the host fetch', async () => {
    const { fetch, calls } = recordingFetch({ text: 'hello', duration: 1 });
    const registry = new SttProviderRegistry({ keys, transport: resolveTransport({ fetch }) });

    const provider = await registry.provider(model, groq);
    const result = await provider.transcribe({
      modelId: 'whisper-large-v3',
      source: { url: 'https://storage.test/a.opus' },
      options: {},
      signal: AbortSignal.timeout(5_000),
    });

    expect(result.text).toBe('hello');
    expect(calls[0]?.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
  });

  it('send translation through the host fetch', async () => {
    const { fetch, calls } = recordingFetch({
      data: { translations: [{ translatedText: 'hola' }] },
    });
    const registry = new MtProviderRegistry({ keys, transport: resolveTransport({ fetch }) });

    const provider = await registry.provider(model, translate);
    const result = await provider.translate({
      modelId: 'nmt',
      texts: ['hello'],
      targetLanguage: 'es',
      signal: AbortSignal.timeout(5_000),
    });

    expect(result.translations).toEqual(['hola']);
    expect(calls).toHaveLength(1);
  });

  it('hand the host socket to speech adapters', async () => {
    const opener: SocketOpener = () => Promise.reject(new Error('unused'));
    const seen: unknown[] = [];
    const registry = new SttProviderRegistry({
      keys,
      transport: resolveTransport({ openSocket: opener }),
      factories: {
        bare: init => {
          seen.push(init.openSocket);
          return { transcribe: () => Promise.reject(new Error('unused')) };
        },
      },
    });

    await registry.provider(model, bare);

    expect(seen).toEqual([opener]);
  });
});

describe('the OpenAI-compatible speech adapter', () => {
  const request = (
    overrides: Partial<ProviderTranscribeRequest> = {},
  ): ProviderTranscribeRequest => ({
    modelId: 'whisper-1',
    source: { data: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' },
    options: { language: 'en', wordTimings: true },
    signal: AbortSignal.timeout(5_000),
    ...overrides,
  });

  it('uploads to the catalog endpoint and reads the verbose answer', async () => {
    const { fetch, calls } = recordingFetch({
      text: ' hello there ',
      language: 'en',
      duration: 2.5,
      segments: [{ start: 0, end: 2.5, text: ' hello there ' }],
      words: [{ word: 'hello', start: 0, end: 0.4 }],
    });

    const result = await openAiCompatibleSttProvider({
      apiKey: '',
      baseUrl: 'http://localhost:8000/v1/',
      fetch,
    }).transcribe(request());

    expect(calls[0]?.url).toBe('http://localhost:8000/v1/audio/transcriptions');
    expect(headersOf(calls[0]?.init ?? {}).has('authorization')).toBe(false);
    expect((calls[0]?.init.body as FormData).get('file')).toBeInstanceOf(Blob);
    expect(result).toMatchObject({
      text: 'hello there',
      audioSeconds: 2.5,
      segments: [{ index: 0, startMs: 0, endMs: 2500, text: 'hello there' }],
      words: [{ startMs: 0, endMs: 400, text: 'hello' }],
    });
  });

  it('refuses to run without an endpoint', async () => {
    const error = await openAiCompatibleSttProvider({ apiKey: 'k' })
      .transcribe(request())
      .catch((caught: unknown) => caught);

    expect(isAiError(error) && error.kind).toBe('invalid_request');
  });

  it('refuses audio by URL rather than downloading it on the caller’s behalf', async () => {
    const { fetch, calls } = recordingFetch({});

    const error = await openAiCompatibleSttProvider({
      apiKey: 'k',
      baseUrl: 'http://localhost:8000/v1',
      fetch,
    })
      .transcribe(request({ source: { url: 'https://storage.test/a.opus' } }))
      .catch((caught: unknown) => caught);

    expect(isAiError(error) && error.kind).toBe('invalid_request');
    expect(calls).toHaveLength(0);
  });
});

describe('the platform socket where the platform falls short', () => {
  const original = globalThis.WebSocket;
  afterEach(() => {
    globalThis.WebSocket = original;
  });

  it('says there is no WebSocket rather than failing as an outage', async () => {
    // @ts-expect-error -- a runtime without the global is exactly the case.
    delete globalThis.WebSocket;

    const error = await platformSocket('ws://x.test', {
      signal: AbortSignal.timeout(1_000),
    }).catch((caught: unknown) => caught);

    expect(isAiError(error) && error.kind).toBe('invalid_request');
  });

  it('says a browser socket cannot send headers, which retrying will not change', async () => {
    // What a browser does with the non-standard init: reads it as a protocol
    // list and refuses it.
    globalThis.WebSocket = class {
      constructor(_url: string, protocols: unknown) {
        if (!Array.isArray(protocols)) throw new SyntaxError('invalid subprotocol');
      }
    } as unknown as typeof WebSocket;

    const error = await platformSocket('ws://x.test', {
      headers: { authorization: 'Token k' },
      signal: AbortSignal.timeout(1_000),
    }).catch((caught: unknown) => caught);

    expect(isAiError(error) && error.kind).toBe('invalid_request');
    expect(isAiError(error) && error.retryable).toBe(false);
  });
});

describe('a live session through a host socket', () => {
  const context = { provider: 'acme', model: 'm' };

  function session(messages: AsyncIterable<string>): SocketSession {
    return { messages, send: () => undefined, close: () => undefined };
  }

  it('names the provider when the socket would not open', async () => {
    const error = await openSocket('ws://x.test', {
      context,
      signal: AbortSignal.timeout(1_000),
      openSocket: () => Promise.reject(new Error('refused')),
    }).catch((caught: unknown) => caught);

    expect(isAiError(error) && error.kind).toBe('provider_unavailable');
    expect((error as Error).message).toMatch(/acme/);
  });

  it('keeps a failure the opener already classified', async () => {
    const error = await openSocket('ws://x.test', {
      context,
      signal: AbortSignal.timeout(1_000),
      openSocket: () => Promise.reject(new AiError('auth', 'bad key')),
    }).catch((caught: unknown) => caught);

    expect(isAiError(error) && error.kind).toBe('auth');
  });

  it('turns a session cut short into a provider failure with the words kept', async () => {
    const live = await openSocket('ws://x.test', {
      context,
      signal: AbortSignal.timeout(1_000),
      openSocket: () =>
        Promise.resolve(
          session(
            (async function* () {
              await Promise.resolve();
              yield 'one';
              throw new Error('closed with 1011');
            })(),
          ),
        ),
    });

    const seen: string[] = [];
    const error = await (async () => {
      for await (const message of live.messages) seen.push(message);
    })().catch((caught: unknown) => caught);

    expect(seen).toEqual(['one']);
    expect(isAiError(error) && error.kind).toBe('provider_unavailable');
    expect((error as Error).message).toBe('acme live session failed: closed with 1011');
  });
});
