import { AiError } from '../../errors.js';
import type {
  ProviderStreamRequest,
  ProviderTranscribeRequest,
  SttProvider,
  SttProviderFactory,
  SttStreamEvent,
  TranscriptSegment,
  TranscriptionResult,
  WordTiming,
} from '../types.js';
import { requestJson, segmentsFromWords, sleep } from './http.js';
import { openSocket } from './socket.js';

/**
 * AssemblyAI: the main paid provider, batch and live.
 *
 * Batch is submit-and-poll rather than a single blocking request, because an
 * hour of audio takes minutes and no HTTP timeout worth having survives that.
 */

const DEFAULT_BASE_URL = 'https://api.assemblyai.com';
const DEFAULT_STREAMING_URL = 'wss://streaming.assemblyai.com/v3/ws';

const POLL_INTERVAL_MS = 3_000;
const CONTEXT = { provider: 'assemblyai' };

interface CreateResponse {
  id: string;
}

interface TranscriptResponse {
  id: string;
  status: 'queued' | 'processing' | 'completed' | 'error';
  text?: string;
  error?: string;
  audio_duration?: number;
  language_code?: string;
  confidence?: number;
  words?: Array<{
    start: number;
    end: number;
    text: string;
    confidence?: number;
    speaker?: string;
  }>;
  utterances?: Array<{
    start: number;
    end: number;
    text: string;
    speaker?: string;
    confidence?: number;
  }> | null;
}

interface TurnMessage {
  type?: string;
  transcript?: string;
  end_of_turn?: boolean;
  turn_is_formatted?: boolean;
  words?: Array<{ start: number; end: number; text: string; confidence?: number }>;
}

export const assemblyAiSttProvider: SttProviderFactory = ({ apiKey, baseUrl }) => {
  const base = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const authorization = { authorization: apiKey };

  /** Bytes go up first: the API transcribes a URL, never a request body. */
  async function upload(request: ProviderTranscribeRequest): Promise<string> {
    if ('url' in request.source) return request.source.url;
    const result = await requestJson<{ upload_url: string }>(
      `${base}/v2/upload`,
      {
        method: 'POST',
        headers: { ...authorization, 'content-type': 'application/octet-stream' },
        body: request.source.data as RequestInit['body'],
        // Node needs telling that a stream body is not going to be buffered.
        duplex: 'half',
        signal: request.signal,
      } as RequestInit,
      { ...CONTEXT, model: request.modelId },
    );
    return result.upload_url;
  }

  return {
    async transcribe(request: ProviderTranscribeRequest): Promise<TranscriptionResult> {
      const context = { ...CONTEXT, model: request.modelId };
      const audioUrl = await upload(request);
      const { options } = request;

      const payload: Record<string, unknown> = {
        audio_url: audioUrl,
        speech_model: request.modelId,
        punctuate: options.punctuation !== false,
        format_text: options.punctuation !== false,
      };
      if (options.language) {
        payload.language_code = options.language;
      } else {
        payload.language_detection = true;
      }
      if (options.diarization) payload.speaker_labels = true;
      if (options.keyterms?.length) payload.word_boost = options.keyterms;

      const created = await requestJson<CreateResponse>(
        `${base}/v2/transcript`,
        {
          method: 'POST',
          headers: { ...authorization, 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: request.signal,
        },
        context,
      );

      for (;;) {
        await sleep(POLL_INTERVAL_MS, request.signal);
        const body = await requestJson<TranscriptResponse>(
          `${base}/v2/transcript/${created.id}`,
          { method: 'GET', headers: authorization, signal: request.signal },
          context,
        );

        if (body.status === 'error') {
          throw new AiError(
            'provider_unavailable',
            `Transcription failed: ${body.error ?? 'unknown reason'}`,
            context,
          );
        }
        if (body.status !== 'completed') continue;

        const words: WordTiming[] = (body.words ?? []).map(word => ({
          startMs: word.start,
          endMs: word.end,
          text: word.text,
          confidence: word.confidence,
        }));

        // Utterances are the provider's own sentence boundaries and carry the
        // speaker label; they are better than anything reconstructed from
        // words, so they win whenever they are there.
        const segments: TranscriptSegment[] =
          body.utterances && body.utterances.length > 0
            ? body.utterances.map((utterance, index) => ({
                index,
                startMs: utterance.start,
                endMs: utterance.end,
                text: utterance.text,
                speaker: utterance.speaker,
                confidence: utterance.confidence,
              }))
            : segmentsFromWords(words);

        return {
          text: body.text ?? '',
          segments,
          words: options.wordTimings ? words : undefined,
          language: body.language_code ?? options.language,
          audioSeconds: body.audio_duration ?? 0,
          confidence: body.confidence,
          providerRequestId: body.id,
        };
      }
    },

    async transcribeStream(request: ProviderStreamRequest): Promise<AsyncIterable<SttStreamEvent>> {
      const context = { ...CONTEXT, model: request.modelId };
      const url = new URL(baseUrl ?? DEFAULT_STREAMING_URL);
      url.searchParams.set('sample_rate', String(request.sampleRate));
      url.searchParams.set('encoding', 'pcm_s16le');
      url.searchParams.set('format_turns', 'true');
      if (request.options.keyterms?.length) {
        url.searchParams.set('keyterms_prompt', JSON.stringify(request.options.keyterms));
      }

      const session = await openSocket(url.toString(), {
        headers: authorization,
        signal: request.signal,
        context,
      });

      // Pumping audio is a separate task from reading results: a session that
      // stopped sending is still receiving the tail of what was already said.
      const pump = (async () => {
        try {
          for await (const chunk of request.audio) session.send(chunk.data);
          session.close(JSON.stringify({ type: 'Terminate' }));
        } catch {
          session.close();
        }
      })();

      return (async function* events(): AsyncIterable<SttStreamEvent> {
        try {
          let emittedMs = 0;
          for await (const message of session.messages) {
            const turn = JSON.parse(message) as TurnMessage;
            if (turn.type !== 'Turn' || turn.transcript === undefined) continue;

            const startMs = turn.words?.[0]?.start ?? emittedMs;
            const endMs = turn.words?.[turn.words.length - 1]?.end ?? startMs;

            if (turn.end_of_turn === true) {
              emittedMs = endMs;
              yield { type: 'final', segment: { startMs, endMs, text: turn.transcript } };
            } else {
              yield { type: 'partial', text: turn.transcript, startMs };
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
