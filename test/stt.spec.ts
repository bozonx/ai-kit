import { describe, it, expect } from '@jest/globals';

import { Catalog } from '../src/catalog/catalog.js';
import { pcm16ToWav } from '../src/stt/audio.js';
import { calculateSttCost, estimateSttCost } from '../src/catalog/pricing.js';
import { CatalogError, AiError, isAiError } from '../src/errors.js';
import { createAiKit } from '../src/kit.js';
import { selectCandidates } from '../src/policy/policy.js';
import type { UsageEvent } from '../src/ports.js';
import { assertSttCapabilities } from '../src/stt/policy.js';
import type {
  AudioChunk,
  SttProvider,
  SttProviderFactory,
  SttStreamEvent,
  TranscriptPart,
} from '../src/stt/types.js';

/**
 * Speech, checked where it differs from text.
 *
 * The two facts worth a test of their own are the ones that cost money when
 * they are wrong: a second of audio is billed as a whole second, and a live
 * session is billed for the time it was open rather than for the words that
 * came out of it.
 */

const yaml = `
models:
  - name: cheap
    kind: stt
    provider: fake
    model: cheap-id
    tier: standard
    sttCapabilities:
      wordTimings: true
      punctuation: true
      languageDetection: true
    sttPricing:
      version: 'test'
      perAudioHourMicros: 36000
    languages: [en, ru]
  - name: backup
    kind: stt
    provider: fake
    model: backup-id
    tier: standard
    sttCapabilities:
      realtime: true
      wordTimings: true
      diarization: true
      punctuation: true
      languageDetection: true
    sttPricing:
      version: 'test'
      perAudioHourMicros: 72000
      perAudioHourRealtimeMicros: 360000
      diarizationPerAudioHourMicros: 36000
  - name: writer
    provider: fake
    model: writer-id
    tier: standard
    contextSize: 100000
    maxOutputTokens: 4096
    pricing:
      version: 'test'
      inputPerMTok: 1000000
      outputPerMTok: 2000000
taskClasses:
  transcription: [cheap, backup]
  dictation: [backup]
  chat_simple: [writer]
`;

const catalog = Catalog.fromYaml(yaml);
const cheap = catalog.require('cheap');
const realtime = catalog.require('backup');

describe('the speech catalog', () => {
  it('refuses a task class that mixes speech and language models', () => {
    expect(() =>
      Catalog.fromYaml(
        yaml.replace('transcription: [cheap, backup]', 'transcription: [cheap, writer]'),
      ),
    ).toThrow(/mixes models of kind "stt" and "llm"/);
  });

  it('reads the kind of a task class off the models nominated for it', () => {
    expect(catalog.kindOf('transcription')).toBe('stt');
    expect(catalog.kindOf('chat_simple')).toBe('llm');
    expect(catalog.kindOf('nothing-like-this')).toBeUndefined();
  });

  it('refuses a speech model priced per token', () => {
    const model = {
      name: 'wrong',
      kind: 'stt',
      provider: 'fake',
      model: 'wrong-id',
      tier: 'standard',
      pricing: { version: 'test', inputPerMTok: 1, outputPerMTok: 1 },
      sttPricing: { version: 'test', perAudioHourMicros: 1 },
    };

    expect(() =>
      Catalog.fromObject({ models: [model], taskClasses: { transcription: ['wrong'] } }),
    ).toThrow(CatalogError);
  });

  it('refuses a realtime model with no realtime price', () => {
    expect(() =>
      Catalog.fromYaml(yaml.replace('      perAudioHourRealtimeMicros: 360000\n', '')),
    ).toThrow(/perAudioHourRealtimeMicros/);
  });

  it('refuses a language model with no context size', () => {
    expect(() => Catalog.fromYaml(yaml.replace('    contextSize: 100000\n', ''))).toThrow(
      /contextSize/,
    );
  });
});

describe('pricing a transcription', () => {
  it('bills a part-second as a whole one, the way providers do', () => {
    // 36000 micro-units an hour is exactly 10 per second.
    expect(calculateSttCost(cheap, { audioSeconds: 10.2 })).toMatchObject({
      billedSeconds: 11,
      totalMicros: 110,
    });
  });

  it('charges the realtime price for a live session', () => {
    expect(calculateSttCost(realtime, { audioSeconds: 60, realtime: true }).totalMicros).toBe(
      6_000,
    );
    expect(calculateSttCost(realtime, { audioSeconds: 60 }).totalMicros).toBe(1_200);
  });

  it('adds the diarization surcharge to the base rather than replacing it', () => {
    expect(calculateSttCost(realtime, { audioSeconds: 3_600, diarization: true }).totalMicros).toBe(
      72_000 + 36_000,
    );
  });

  it('estimates exactly, because the duration is known before the call', () => {
    expect(estimateSttCost(cheap, { audioSeconds: 3_600 })).toBe(36_000);
  });

  it('refuses to price a speech model as if it had token prices', () => {
    expect(() => calculateSttCost(catalog.require('writer'), { audioSeconds: 1 })).toThrow(
      CatalogError,
    );
  });
});

describe('choosing a speech model', () => {
  const pick = (
    taskClass: 'transcription' | 'dictation',
    signals: Record<string, unknown> = {},
  ): string[] =>
    selectCandidates(
      { mode: 'auto', taskClass, signals: { estimatedInputTokens: 0, ...signals } },
      catalog,
    ).map(candidate => candidate.model.name);

  it('drops a model that does not claim the language', () => {
    expect(pick('transcription', { language: 'es' })).toEqual(['backup']);
    expect(pick('transcription', { language: 'en' })).toEqual(['cheap', 'backup']);
  });

  it('treats a region as the language it belongs to', () => {
    expect(pick('transcription', { language: 'ru-BY' })).toEqual(['cheap', 'backup']);
  });

  it('drops a model that cannot diarize when speakers were asked for', () => {
    expect(pick('transcription', { needsDiarization: true })).toEqual(['backup']);
  });

  it('will not honour a language model pinned to a speech task', () => {
    expect(() =>
      selectCandidates(
        {
          mode: 'manual',
          taskClass: 'transcription',
          requestedModel: 'writer',
          signals: { estimatedInputTokens: 0 },
        },
        catalog,
      ),
    ).toThrow(/writer/);
  });
});

describe('capabilities the model does not have', () => {
  it('refuses the option instead of quietly dropping it', () => {
    expect(() => assertSttCapabilities(cheap, { language: 'en', diarization: true })).toThrow(
      /diarization/,
    );
  });

  it('says nothing about keyterms, which are an improvement and not a promise', () => {
    expect(() =>
      assertSttCapabilities(cheap, { language: 'en', keyterms: ['bloggerdog'] }),
    ).not.toThrow();
  });
});

/** A provider that answers from a script, so the tests never touch a network. */
function fakeProvider(script: {
  transcribe?: () => Promise<unknown>;
  events?: SttStreamEvent[];
}): SttProviderFactory {
  return () =>
    ({
      transcribe: async () =>
        (await (script.transcribe?.() ??
          Promise.resolve({
            text: 'hello there',
            segments: [{ index: 0, startMs: 0, endMs: 900, text: 'hello there' }],
            audioSeconds: 90,
            language: 'en',
          }))) as never,
      transcribeStream: () =>
        Promise.resolve(
          (async function* (): AsyncGenerator<SttStreamEvent> {
            await Promise.resolve();
            for (const event of script.events ?? []) yield event;
          })(),
        ),
    }) satisfies SttProvider;
}

function kitWith(factory: SttProviderFactory, events: UsageEvent[]) {
  return createAiKit({
    catalog,
    keys: { get: () => Promise.resolve('key') },
    usage: {
      record: event => {
        events.push(event);
        return Promise.resolve();
      },
    },
    sttProviders: { fake: factory },
  });
}

describe('running a transcription', () => {
  it('records the seconds and the cost of what the provider returned', async () => {
    const events: UsageEvent[] = [];
    const kit = kitWith(fakeProvider({}), events);

    const result = await kit.transcribe({
      policy: { mode: 'auto', taskClass: 'transcription' },
      options: { language: 'en' },
      source: { url: 'https://storage.test/audio.opus' },
    });

    expect(result.text).toBe('hello there');
    expect(result.model).toBe('cheap');
    expect(result.audioSeconds).toBe(90);
    expect(result.costMicros).toBe(900);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ audioSeconds: 90, costMicros: 900, status: 'ok' });
    expect(events[0]?.usage).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  it('falls back to the next candidate when the first provider is down', async () => {
    const events: UsageEvent[] = [];
    let calls = 0;
    const kit = kitWith(
      fakeProvider({
        transcribe: () => {
          calls += 1;
          if (calls <= 3) return Promise.reject(new AiError('provider_unavailable', 'nope'));
          return Promise.resolve({
            text: 'second try',
            segments: [],
            audioSeconds: 30,
          });
        },
      }),
      events,
    );

    const result = await kit.transcribe({
      policy: { mode: 'auto', taskClass: 'transcription' },
      options: { language: 'en' },
      source: { url: 'https://storage.test/audio.opus' },
    });

    expect(result.model).toBe('backup');
    expect(result.text).toBe('second try');
  });

  it('measures WAV audio when the provider omits its duration', async () => {
    const kit = kitWith(
      fakeProvider({
        transcribe: () => Promise.resolve({ text: 'hello', segments: [], audioSeconds: 0 }),
      }),
      [],
    );

    const result = await kit.transcribe({
      policy: { mode: 'auto', taskClass: 'transcription' },
      options: { language: 'en' },
      source: { data: pcm16ToWav(new Uint8Array(96_000), 48_000), mimeType: 'audio/wav' },
    });

    expect(result.audioSeconds).toBe(1);
    expect(result.costMicros).toBe(10);
  });

  it('rejects unmeasured compressed audio instead of billing a size guess', async () => {
    const kit = kitWith(
      fakeProvider({
        transcribe: () => Promise.resolve({ text: 'hello', segments: [], audioSeconds: 0 }),
      }),
      [],
    );
    await expect(
      kit.transcribe({
        policy: { mode: 'manual', taskClass: 'transcription', requestedModel: 'cheap' },
        options: { language: 'en' },
        source: { data: new Uint8Array(4_000), mimeType: 'audio/ogg' },
      }),
    ).rejects.toThrow();
  });

  it('replays a one-shot audio stream after a retryable provider failure', async () => {
    let calls = 0;
    const retryCatalog = Catalog.fromObject({
      requirePricing: false,
      models: [
        {
          name: 'groq-speech',
          kind: 'stt',
          provider: 'groq',
          model: 'whisper-large-v3',
          tier: 'standard',
          sttCapabilities: { languageDetection: true, punctuation: true },
        },
      ],
      taskClasses: { transcription: ['groq-speech'] },
    });
    const kit = createAiKit({
      catalog: retryCatalog,
      keys: { get: () => Promise.resolve('key') },
      retry: { initialDelayMs: 0, maxDelayMs: 0 },
      transport: {
        fetch: () => {
          calls += 1;
          return Promise.resolve(
            calls === 1
              ? new Response('{}', { status: 503 })
              : Response.json({ text: 'hello', duration: 1 }),
          );
        },
      },
    });
    const bytes = pcm16ToWav(new Uint8Array(32_000), 16_000);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const result = await kit.transcribe({
      policy: { mode: 'manual', taskClass: 'transcription', requestedModel: 'groq-speech' },
      source: { data: stream, mimeType: 'audio/wav' },
    });
    expect(result.text).toBe('hello');
    expect(calls).toBe(2);
  });

  it('rejects an unmeasured URL instead of recording a free success', async () => {
    const kit = kitWith(
      fakeProvider({
        transcribe: () => Promise.resolve({ text: 'hello', segments: [], audioSeconds: 0 }),
      }),
      [],
    );

    const error = await kit
      .transcribe({
        policy: { mode: 'manual', taskClass: 'transcription', requestedModel: 'cheap' },
        options: { language: 'en' },
        source: { url: 'https://storage.test/audio.opus' },
      })
      .catch((caught: unknown) => caught);

    expect(isAiError(error) && error.kind).toBe('no_candidates');
  });

  it('refuses a task class that is not about speech', async () => {
    const kit = kitWith(fakeProvider({}), []);

    await expect(
      kit.transcribe({
        policy: { mode: 'auto', taskClass: 'chat_simple' },
        source: { url: 'https://storage.test/audio.opus' },
      }),
    ).rejects.toThrow(/not a speech task/);
  });
});

describe('running a live session', () => {
  const audio: AsyncIterable<AudioChunk> = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async *[Symbol.asyncIterator]() {
      yield { data: new Uint8Array([0, 0]) };
    },
  };

  it('numbers finals in order and never renumbers a partial', async () => {
    const events: UsageEvent[] = [];
    const kit = kitWith(
      fakeProvider({
        events: [
          { type: 'partial', text: 'hel', startMs: 0 },
          { type: 'final', segment: { startMs: 0, endMs: 500, text: 'Hello.' } },
          { type: 'partial', text: 'the', startMs: 500 },
          { type: 'final', segment: { startMs: 500, endMs: 900, text: 'There.' } },
        ],
      }),
      events,
    );

    const parts: TranscriptPart[] = [];
    for await (const part of kit.transcribeStream({
      policy: { mode: 'auto', taskClass: 'dictation' },
      options: { language: 'en' },
      audio,
    })) {
      parts.push(part);
    }

    expect(parts.map(part => part.type)).toEqual([
      'model',
      'partial',
      'final',
      'partial',
      'final',
      'usage',
      'finish',
    ]);
    const finals = parts.filter(part => part.type === 'final');
    expect(finals.map(part => part.segment.index)).toEqual([0, 1]);
    expect(events[0]).toMatchObject({ status: 'ok' });
  });

  it('records an aborted session when the reader stops after a final', async () => {
    const events: UsageEvent[] = [];
    const kit = kitWith(
      fakeProvider({
        events: [{ type: 'final', segment: { startMs: 0, endMs: 500, text: 'Hello' } }],
      }),
      events,
    );
    for await (const part of kit.transcribeStream({
      policy: { mode: 'auto', taskClass: 'dictation' },
      options: { language: 'en' },
      audio,
    })) {
      if (part.type === 'final') break;
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'aborted' });
  });

  it('uses the request deadline only while opening the live session', async () => {
    let connectionSignal: AbortSignal | undefined;
    let lifetimeSignal: AbortSignal | undefined;
    const kit = kitWith(
      () => ({
        transcribe: () => Promise.reject(new AiError('invalid_request', 'batch only')),
        transcribeStream: request => {
          connectionSignal = request.connectSignal;
          lifetimeSignal = request.signal;
          return Promise.resolve(
            (async function* (): AsyncGenerator<SttStreamEvent> {
              await new Promise(resolve => setTimeout(resolve, 20));
              yield { type: 'final', segment: { startMs: 0, endMs: 10, text: 'Still open' } };
            })(),
          );
        },
      }),
      [],
    );

    const parts: TranscriptPart[] = [];
    for await (const part of kit.transcribeStream({
      policy: { mode: 'auto', taskClass: 'dictation' },
      options: { language: 'en' },
      totalTimeoutMs: 5,
      audio,
    })) {
      parts.push(part);
    }

    expect(connectionSignal?.aborted).toBe(true);
    expect(lifetimeSignal?.aborted).toBe(false);
    expect(parts.some(part => part.type === 'final')).toBe(true);
  });

  it('bills and reports a session the provider dropped mid-sentence', async () => {
    const events: UsageEvent[] = [];
    const kit = kitWith(
      () =>
        ({
          transcribe: () => Promise.reject(new AiError('invalid_request', 'batch only')),
          transcribeStream: () =>
            Promise.resolve(
              (async function* (): AsyncGenerator<SttStreamEvent> {
                await Promise.resolve();
                yield { type: 'final', segment: { startMs: 0, endMs: 10, text: 'Half a' } };
                throw new AiError('provider_unavailable', 'socket closed');
              })(),
            ),
        }) satisfies SttProvider,
      events,
    );

    const parts: TranscriptPart[] = [];
    for await (const part of kit.transcribeStream({
      policy: { mode: 'auto', taskClass: 'dictation' },
      options: { language: 'en' },
      audio,
    })) {
      parts.push(part);
    }

    expect(parts.map(part => part.type)).toEqual(['model', 'final', 'usage', 'error']);
    expect(parts.at(-1)).toMatchObject({ kind: 'provider_unavailable', recoverable: true });
    // The words already shown were paid for, so the session is still recorded.
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'error' });
  });
});
