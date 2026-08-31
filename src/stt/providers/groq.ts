import { AiError } from '../../errors.js';
import type {
  ProviderTranscribeRequest,
  SttProvider,
  SttProviderFactory,
  TranscriptSegment,
  TranscriptionResult,
  WordTiming,
} from '../types.js';
import { requestJson } from './http.js';

/**
 * Groq: whisper at a price that makes the free tier cost nothing worth counting.
 *
 * Batch only, and no speaker labels — which is why it is nominated for
 * `transcription` and never for `subtitles`. The catalog says so; this file
 * only has to be honest about what it can do.
 */

const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
const CONTEXT = { provider: 'groq' };

interface VerboseResponse {
  text?: string;
  language?: string;
  duration?: number;
  segments?: Array<{ start: number; end: number; text: string; avg_logprob?: number }>;
  words?: Array<{ word: string; start: number; end: number }>;
  x_groq?: { id?: string };
}

const toMs = (seconds: number): number => Math.round(seconds * 1000);

async function collect(data: Uint8Array | ReadableStream<Uint8Array>): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;

  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = data.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.length;
  }

  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

export const groqSttProvider: SttProviderFactory = ({ apiKey, baseUrl }) => {
  const base = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');

  return {
    async transcribe(request: ProviderTranscribeRequest): Promise<TranscriptionResult> {
      const context = { ...CONTEXT, model: request.modelId };
      const { options } = request;

      if (options.diarization) {
        throw new AiError('invalid_request', 'Groq does not label speakers', context);
      }

      const form = new FormData();
      form.set('model', request.modelId);
      form.set('response_format', 'verbose_json');
      if (options.language) form.set('language', options.language);
      // Word timings cost nothing extra here, so they are asked for whenever
      // the caller wants them and simply left out of the result otherwise.
      form.append('timestamp_granularities[]', 'segment');
      if (options.wordTimings) form.append('timestamp_granularities[]', 'word');
      if (options.keyterms?.length) form.set('prompt', options.keyterms.join(', '));

      if ('url' in request.source) {
        form.set('url', request.source.url);
      } else {
        const bytes = await collect(request.source.data);
        // Copied once because `Blob` will not take a view onto a possibly
        // shared buffer, and because the multipart encoder would copy anyway.
        const part = new Uint8Array(bytes);
        form.set('file', new Blob([part], { type: request.source.mimeType }), 'audio');
      }

      const response = await requestJson<VerboseResponse>(
        `${base}/audio/transcriptions`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}` },
          body: form,
          signal: request.signal,
        },
        context,
      );

      const segments: TranscriptSegment[] = (response.segments ?? []).map((segment, index) => ({
        index,
        startMs: toMs(segment.start),
        endMs: toMs(segment.end),
        text: segment.text.trim(),
      }));

      const words: WordTiming[] | undefined = options.wordTimings
        ? (response.words ?? []).map(word => ({
            startMs: toMs(word.start),
            endMs: toMs(word.end),
            text: word.word,
          }))
        : undefined;

      return {
        text: response.text?.trim() ?? '',
        segments,
        words,
        language: response.language ?? options.language,
        audioSeconds: response.duration ?? 0,
        providerRequestId: response.x_groq?.id,
      };
    },
  } satisfies SttProvider;
};
