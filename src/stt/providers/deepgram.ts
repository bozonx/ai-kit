import type {
  ProviderStreamRequest,
  ProviderTranscribeRequest,
  SttProvider,
  SttProviderFactory,
  SttStreamEvent,
  TranscriptSegment,
  TranscriptionOptions,
  TranscriptionResult,
  WordTiming,
} from '../types.js';
import { requestJson, segmentsFromWords } from './http.js';
import { openSocket } from './socket.js';

/**
 * Deepgram: the second paid provider, batch and live.
 *
 * Second on purpose and early: multi-provider with one implementation is an
 * abstraction nobody has tested. The differences show up immediately — this one
 * answers a batch request in the same HTTP call and counts time in seconds
 * rather than milliseconds.
 */

const DEFAULT_BASE_URL = 'https://api.deepgram.com';
const DEFAULT_STREAMING_URL = 'wss://api.deepgram.com';
const CONTEXT = { provider: 'deepgram' };

interface Word {
  word: string;
  punctuated_word?: string;
  start: number;
  end: number;
  confidence?: number;
  speaker?: number;
}

interface ListenResponse {
  metadata?: { duration?: number; request_id?: string };
  results?: {
    channels?: Array<{
      detected_language?: string;
      alternatives?: Array<{ transcript?: string; confidence?: number; words?: Word[] }>;
    }>;
    utterances?: Array<{
      start: number;
      end: number;
      transcript: string;
      confidence?: number;
      speaker?: number;
    }>;
  };
}

interface LiveMessage {
  type?: string;
  is_final?: boolean;
  start?: number;
  duration?: number;
  channel?: { alternatives?: Array<{ transcript?: string }> };
}

const toMs = (seconds: number): number => Math.round(seconds * 1000);

function queryFor(
  modelId: string,
  options: TranscriptionOptions,
  extra: Record<string, string> = {},
): URLSearchParams {
  const query = new URLSearchParams({ model: modelId, ...extra });
  query.set('punctuate', String(options.punctuation !== false));
  query.set('smart_format', String(options.punctuation !== false));
  if (options.language) query.set('language', options.language);
  else query.set('detect_language', 'true');
  if (options.diarization) query.set('diarize', 'true');
  for (const term of options.keyterms ?? []) query.append('keyterm', term);
  return query;
}

export const deepgramSttProvider: SttProviderFactory = ({ apiKey, baseUrl }) => {
  const base = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const authorization = { authorization: `Token ${apiKey}` };

  return {
    async transcribe(request: ProviderTranscribeRequest): Promise<TranscriptionResult> {
      const context = { ...CONTEXT, model: request.modelId };
      const { options } = request;
      const query = queryFor(request.modelId, options, { utterances: 'true' });

      const body: RequestInit =
        'url' in request.source
          ? {
              headers: { ...authorization, 'content-type': 'application/json' },
              body: JSON.stringify({ url: request.source.url }),
            }
          : {
              headers: { ...authorization, 'content-type': request.source.mimeType },
              body: request.source.data as RequestInit['body'],
              duplex: 'half',
            };

      const response = await requestJson<ListenResponse>(
        `${base}/v1/listen?${query.toString()}`,
        { method: 'POST', signal: request.signal, ...body } as RequestInit,
        context,
      );

      const channel = response.results?.channels?.[0];
      const alternative = channel?.alternatives?.[0];
      const words: WordTiming[] = (alternative?.words ?? []).map(word => ({
        startMs: toMs(word.start),
        endMs: toMs(word.end),
        text: word.punctuated_word ?? word.word,
        confidence: word.confidence,
      }));

      const utterances = response.results?.utterances ?? [];
      const segments: TranscriptSegment[] =
        utterances.length > 0
          ? utterances.map((utterance, index) => ({
              index,
              startMs: toMs(utterance.start),
              endMs: toMs(utterance.end),
              text: utterance.transcript,
              speaker: utterance.speaker === undefined ? undefined : String(utterance.speaker),
              confidence: utterance.confidence,
            }))
          : segmentsFromWords(words);

      return {
        text: alternative?.transcript ?? '',
        segments,
        words: options.wordTimings ? words : undefined,
        language: channel?.detected_language ?? options.language,
        audioSeconds: response.metadata?.duration ?? 0,
        confidence: alternative?.confidence,
        providerRequestId: response.metadata?.request_id,
      };
    },

    async transcribeStream(request: ProviderStreamRequest): Promise<AsyncIterable<SttStreamEvent>> {
      const context = { ...CONTEXT, model: request.modelId };
      const query = queryFor(request.modelId, request.options, {
        encoding: 'linear16',
        sample_rate: String(request.sampleRate),
        channels: '1',
        interim_results: 'true',
      });

      const session = await openSocket(
        `${(baseUrl ?? DEFAULT_STREAMING_URL).replace(/\/$/, '')}/v1/listen?${query.toString()}`,
        { headers: authorization, signal: request.signal, context },
      );

      const pump = (async () => {
        try {
          for await (const chunk of request.audio) session.send(chunk.data);
          session.close(JSON.stringify({ type: 'CloseStream' }));
        } catch {
          session.close();
        }
      })();

      return (async function* events(): AsyncIterable<SttStreamEvent> {
        try {
          for await (const message of session.messages) {
            const event = JSON.parse(message) as LiveMessage;
            if (event.type !== 'Results') continue;

            const text = event.channel?.alternatives?.[0]?.transcript ?? '';
            if (text.length === 0) continue;

            const startMs = toMs(event.start ?? 0);
            const endMs = startMs + toMs(event.duration ?? 0);

            if (event.is_final === true) {
              yield { type: 'final', segment: { startMs, endMs, text } };
            } else {
              yield { type: 'partial', text, startMs };
            }
          }
        } finally {
          session.close();
          await pump;
        }
      })();
    },
  } satisfies SttProvider;
};
