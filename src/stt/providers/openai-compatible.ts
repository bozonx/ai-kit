import { AiError } from '../../errors.js';
import { z } from 'zod';
import type {
  ProviderTranscribeRequest,
  SttProvider,
  SttProviderFactory,
  TranscriptSegment,
  TranscriptionResult,
  WordTiming,
} from '../types.js';
import { jsonRequester, parseProviderResponse } from './http.js';

/**
 * Any server that speaks OpenAI's `/audio/transcriptions`.
 *
 * OpenAI itself, Groq, a local whisper.cpp or speaches behind a desktop app —
 * the same multipart request and the same `verbose_json` answer. Batch only,
 * no speaker labels, and no audio by URL: the endpoint takes bytes, and a
 * library that quietly downloaded a caller's URL on its behalf would be making
 * a network decision that belongs to the host.
 */

export interface VerboseTranscription {
  text?: string;
  language?: string;
  duration?: number;
  segments?: Array<{ start: number; end: number; text: string; avg_logprob?: number }>;
  words?: Array<{ word: string; start: number; end: number }>;
}

/** What differs between servers that otherwise share the endpoint. */
export interface OpenAiCompatibleSttPreset<R extends VerboseTranscription> {
  /** Named in errors, so that a failure says whose endpoint refused. */
  provider: string;
  /** Used when the catalog sets no `baseUrl`. Without one, the catalog must. */
  defaultBaseUrl?: string;
  /** Whether the server accepts `url` in place of a file. Groq does, OpenAI does not. */
  acceptsUrl?: boolean;
  requestId?: (response: R) => string | undefined;
}

const toMs = (seconds: number): number => Math.round(seconds * 1000);
const finiteSeconds = z.number().finite().nonnegative();
const verboseTranscriptionSchema = z
  .object({
    text: z.string().optional(),
    language: z.string().optional(),
    duration: finiteSeconds.optional(),
    segments: z
      .array(
        z.object({
          start: finiteSeconds,
          end: finiteSeconds,
          text: z.string(),
          avg_logprob: z.number().finite().optional(),
        }),
      )
      .optional(),
    words: z
      .array(z.object({ word: z.string(), start: finiteSeconds, end: finiteSeconds }))
      .optional(),
  })
  .passthrough();

async function collect(
  data: Uint8Array | ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;

  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = data.getReader();
  const onAbort = (): void => {
    void reader.cancel(signal.reason);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      length += value.length;
    }
    if (signal.aborted) throw signal.reason;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }

  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

export function openAiCompatibleSttAdapter<R extends VerboseTranscription>(
  preset: OpenAiCompatibleSttPreset<R>,
): SttProviderFactory {
  return ({ apiKey, baseUrl, fetch }) => {
    const requestJson = jsonRequester(fetch);
    const endpoint = baseUrl ?? preset.defaultBaseUrl;

    return {
      async transcribe(request: ProviderTranscribeRequest): Promise<TranscriptionResult> {
        const context = { provider: preset.provider, model: request.modelId };
        const { options } = request;

        if (endpoint === undefined) {
          throw new AiError(
            'invalid_request',
            `Provider "${preset.provider}" has no default endpoint; set \`baseUrl\` in the catalog`,
            context,
          );
        }
        if (options.diarization) {
          throw new AiError(
            'invalid_request',
            `${preset.provider} does not label speakers`,
            context,
          );
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
          if (!preset.acceptsUrl) {
            throw new AiError(
              'invalid_request',
              `${preset.provider} transcribes uploaded audio only; pass the bytes`,
              context,
            );
          }
          form.set('url', request.source.url);
        } else {
          const bytes = await collect(request.source.data, request.signal);
          // Copied once because `Blob` will not take a view onto a possibly
          // shared buffer, and because the multipart encoder would copy anyway.
          const part = new Uint8Array(bytes);
          form.set('file', new Blob([part], { type: request.source.mimeType }), 'audio');
        }

        const rawResponse = await requestJson<unknown>(
          `${endpoint.replace(/\/$/, '')}/audio/transcriptions`,
          {
            method: 'POST',
            // A local server usually wants no key, and an empty bearer token is
            // a refusal at the ones that check.
            headers: apiKey.length > 0 ? { authorization: `Bearer ${apiKey}` } : {},
            body: form,
            signal: request.signal,
          },
          context,
        );
        const response = parseProviderResponse(
          verboseTranscriptionSchema,
          rawResponse,
          context,
        ) as R;

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
          providerRequestId: preset.requestId?.(response),
        };
      },
    } satisfies SttProvider;
  };
}

/** A server named only by the catalog's `baseUrl`. */
export const openAiCompatibleSttProvider: SttProviderFactory = openAiCompatibleSttAdapter({
  provider: 'openai-compatible',
});
