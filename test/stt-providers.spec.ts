import { describe, it, expect, afterEach, jest } from '@jest/globals';

import { isAiError } from '../src/errors.js';
import { assemblyAiSttProvider } from '../src/stt/providers/assemblyai.js';
import { deepgramSttProvider } from '../src/stt/providers/deepgram.js';
import { groqSttProvider } from '../src/stt/providers/groq.js';
import { segmentsFromWords } from '../src/stt/providers/http.js';
import type { ProviderTranscribeRequest } from '../src/stt/types.js';

/**
 * The adapters, against recorded provider answers.
 *
 * These are the files a second product trips over first: everything above them
 * is shared, and everything in them is somebody else's wire format. A test
 * here is not about our logic being right, it is about noticing the day a
 * provider renames a field.
 */

interface Call {
  url: string;
  init: RequestInit;
}

const original = globalThis.fetch;

/** Answers a scripted sequence of responses and records what was asked. */
function mockFetch(script: Array<{ status?: number; body: unknown }>): Call[] {
  const calls: Call[] = [];
  let index = 0;
  globalThis.fetch = ((url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const step = script[Math.min(index, script.length - 1)];
    index += 1;
    return Promise.resolve(
      new Response(typeof step?.body === 'string' ? step.body : JSON.stringify(step?.body ?? {}), {
        status: step?.status ?? 200,
      }),
    );
  }) as unknown as typeof globalThis.fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = original;
  jest.useRealTimers();
});

const request = (
  overrides: Partial<ProviderTranscribeRequest> = {},
): ProviderTranscribeRequest => ({
  modelId: 'model-id',
  source: { url: 'https://storage.test/audio.opus' },
  options: { language: 'en' },
  signal: AbortSignal.timeout(30_000),
  ...overrides,
});

describe('the Groq adapter', () => {
  it('turns a verbose transcript into segments in milliseconds', async () => {
    mockFetch([
      {
        body: {
          text: '  Hello there.  ',
          language: 'en',
          duration: 12.5,
          segments: [{ start: 0, end: 1.25, text: ' Hello there. ' }],
          words: [{ word: 'Hello', start: 0, end: 0.5 }],
          x_groq: { id: 'req-1' },
        },
      },
    ]);

    const result = await groqSttProvider({ apiKey: 'k' }).transcribe(
      request({ options: { language: 'en', wordTimings: true } }),
    );

    expect(result.text).toBe('Hello there.');
    expect(result.segments).toEqual([{ index: 0, startMs: 0, endMs: 1_250, text: 'Hello there.' }]);
    expect(result.words).toEqual([{ startMs: 0, endMs: 500, text: 'Hello' }]);
    expect(result.audioSeconds).toBe(12.5);
    expect(result.providerRequestId).toBe('req-1');
  });

  it('leaves word timings out when the caller did not ask for them', async () => {
    mockFetch([{ body: { text: 'x', words: [{ word: 'x', start: 0, end: 1 }] } }]);

    const result = await groqSttProvider({ apiKey: 'k' }).transcribe(request());

    expect(result.words).toBeUndefined();
  });

  it('refuses diarization rather than returning a transcript without speakers', async () => {
    mockFetch([{ body: {} }]);

    await expect(
      groqSttProvider({ apiKey: 'k' }).transcribe(
        request({ options: { language: 'en', diarization: true } }),
      ),
    ).rejects.toThrow(/does not label speakers/);
  });

  it('sends a URL as a field rather than downloading the audio itself', async () => {
    const calls = mockFetch([{ body: { text: 'x' } }]);

    await groqSttProvider({ apiKey: 'k' }).transcribe(request());

    const form = calls[0]?.init.body as FormData;
    expect(form.get('url')).toBe('https://storage.test/audio.opus');
    expect(form.get('file')).toBeNull();
  });

  it('uploads bytes when the audio exists nowhere yet', async () => {
    const calls = mockFetch([{ body: { text: 'x' } }]);

    await groqSttProvider({ apiKey: 'k' }).transcribe(
      request({ source: { data: new Uint8Array([1, 2, 3]), mimeType: 'audio/webm' } }),
    );

    const form = calls[0]?.init.body as FormData;
    expect(form.get('file')).toBeInstanceOf(Blob);
  });

  it('reads a stream of bytes to the end before sending it', async () => {
    const calls = mockFetch([{ body: { text: 'x' } }]);
    const data = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3]));
        controller.close();
      },
    });

    await groqSttProvider({ apiKey: 'k' }).transcribe(
      request({ source: { data, mimeType: 'audio/webm' } }),
    );

    const form = calls[0]?.init.body as FormData;
    expect((form.get('file') as Blob).size).toBe(3);
  });

  it('classifies a rate limit as retryable and keeps the body out of the message', async () => {
    mockFetch([{ status: 429, body: { error: 'slow down' } }]);

    const error = await groqSttProvider({ apiKey: 'k' })
      .transcribe(request())
      .catch((caught: unknown) => caught);

    expect(isAiError(error) && error.kind).toBe('rate_limit');
    expect(isAiError(error) && error.retryable).toBe(true);
  });
});

describe('the Deepgram adapter', () => {
  const listen = {
    metadata: { duration: 30.5, request_id: 'dg-1' },
    results: {
      channels: [
        {
          detected_language: 'ru',
          alternatives: [
            {
              transcript: 'привет мир',
              confidence: 0.99,
              words: [
                { word: 'привет', punctuated_word: 'Привет,', start: 0, end: 0.4 },
                { word: 'мир', start: 0.5, end: 0.9 },
              ],
            },
          ],
        },
      ],
      utterances: [{ start: 0, end: 0.9, transcript: 'Привет, мир', speaker: 1, confidence: 0.98 }],
    },
  };

  it('prefers the utterances the provider itself returned, speaker and all', async () => {
    mockFetch([{ body: listen }]);

    const result = await deepgramSttProvider({ apiKey: 'k' }).transcribe(
      request({ options: { language: 'ru', diarization: true, wordTimings: true } }),
    );

    expect(result.segments).toEqual([
      { index: 0, startMs: 0, endMs: 900, text: 'Привет, мир', speaker: '1', confidence: 0.98 },
    ]);
    expect(result.words?.[0]).toMatchObject({ text: 'Привет,', startMs: 0, endMs: 400 });
    expect(result.language).toBe('ru');
    expect(result.audioSeconds).toBe(30.5);
    expect(result.providerRequestId).toBe('dg-1');
  });

  it('builds segments out of words when the provider sent no utterances', async () => {
    mockFetch([{ body: { ...listen, results: { ...listen.results, utterances: [] } } }]);

    const result = await deepgramSttProvider({ apiKey: 'k' }).transcribe(request());

    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.text).toBe('Привет, мир');
  });

  it('asks for language detection only when it was not told the language', async () => {
    const calls = mockFetch([{ body: listen }, { body: listen }]);
    const provider = deepgramSttProvider({ apiKey: 'k' });

    await provider.transcribe(request({ options: {} }));
    await provider.transcribe(request({ options: { language: 'en' } }));

    expect(calls[0]?.url).toContain('detect_language=true');
    expect(calls[1]?.url).toContain('language=en');
    expect(calls[1]?.url).not.toContain('detect_language');
  });

  it('passes key terms one by one, because the endpoint repeats the parameter', async () => {
    const calls = mockFetch([{ body: listen }]);

    await deepgramSttProvider({ apiKey: 'k' }).transcribe(
      request({ options: { language: 'en', keyterms: ['Imagon', 'bloggerdog'] } }),
    );

    expect(calls[0]?.url).toContain('keyterm=Imagon');
    expect(calls[0]?.url).toContain('keyterm=bloggerdog');
  });
});

describe('the AssemblyAI adapter', () => {
  it('uploads bytes, submits the job and polls until it is done', async () => {
    jest.useFakeTimers();
    const calls = mockFetch([
      { body: { upload_url: 'https://cdn.test/upload-1' } },
      { body: { id: 'job-1' } },
      { body: { id: 'job-1', status: 'processing' } },
      {
        body: {
          id: 'job-1',
          status: 'completed',
          text: 'Hello there',
          audio_duration: 61,
          language_code: 'en',
          confidence: 0.9,
          words: [{ start: 0, end: 500, text: 'Hello' }],
          utterances: [{ start: 0, end: 500, text: 'Hello there', speaker: 'A' }],
        },
      },
    ]);

    const pending = assemblyAiSttProvider({ apiKey: 'k' }).transcribe(
      request({ source: { data: new Uint8Array([1]), mimeType: 'audio/webm' } }),
    );
    // Two polls, each behind the interval the adapter waits out.
    await jest.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(calls.map(call => call.url)).toEqual([
      'https://api.assemblyai.com/v2/upload',
      'https://api.assemblyai.com/v2/transcript',
      'https://api.assemblyai.com/v2/transcript/job-1',
      'https://api.assemblyai.com/v2/transcript/job-1',
    ]);
    expect(result.text).toBe('Hello there');
    expect(result.segments[0]).toMatchObject({ speaker: 'A' });
    expect(result.audioSeconds).toBe(61);
  });

  it('turns a failed job into an error rather than an empty transcript', async () => {
    jest.useFakeTimers();
    mockFetch([
      { body: { id: 'job-2' } },
      { body: { id: 'job-2', status: 'error', error: 'audio is silent' } },
    ]);

    const pending = assemblyAiSttProvider({ apiKey: 'k' })
      .transcribe(request())
      .catch((caught: unknown) => caught);
    await jest.advanceTimersByTimeAsync(10_000);
    const error = await pending;

    expect(isAiError(error) && error.kind).toBe('provider_unavailable');
    expect(String(error)).toContain('audio is silent');
  });

  it('never uploads audio that is already at a URL', async () => {
    jest.useFakeTimers();
    const calls = mockFetch([
      { body: { id: 'job-3' } },
      { body: { id: 'job-3', status: 'completed', text: 'x', audio_duration: 1 } },
    ]);

    const pending = assemblyAiSttProvider({ apiKey: 'k' }).transcribe(request());
    await jest.advanceTimersByTimeAsync(10_000);
    await pending;

    expect(calls.map(call => call.url)).not.toContain('https://api.assemblyai.com/v2/upload');
  });
});

describe('segments reconstructed from words', () => {
  it('breaks on a sentence ending and on a pause long enough to be one', () => {
    const segments = segmentsFromWords([
      { startMs: 0, endMs: 300, text: 'Hello' },
      { startMs: 300, endMs: 600, text: 'there.' },
      { startMs: 620, endMs: 900, text: 'How' },
      { startMs: 2_000, endMs: 2_300, text: 'are' },
      { startMs: 2_300, endMs: 2_600, text: 'you' },
    ]);

    expect(segments.map(segment => segment.text)).toEqual(['Hello there.', 'How', 'are you']);
    expect(segments.map(segment => segment.index)).toEqual([0, 1, 2]);
  });

  it('keeps punctuation attached to the word before it', () => {
    expect(
      segmentsFromWords([
        { startMs: 0, endMs: 1, text: 'Hi' },
        { startMs: 1, endMs: 2, text: ',' },
      ])[0]?.text,
    ).toBe('Hi,');
  });
});
