import { z } from 'zod';

import { AiError } from '../../errors.js';
import type {
  AudioChunk,
  ProviderStreamRequest,
  SttProvider,
  SttProviderFactory,
  SttStreamEvent,
} from '../types.js';
import { parseProviderResponse } from './http.js';
import { openSocket, pumpAudio } from './socket.js';

/**
 * A self-hosted sherpa-onnx streaming server (`sherpa-onnx-online-websocket-server`).
 *
 * Live only: the streaming server has no request for a whole recording. The
 * model is whatever the server was started with, so the catalog's model id and
 * the requested language are not sent anywhere. There is no authentication
 * either; a deployment that needs it puts the server behind a proxy.
 *
 * The wire format is the server's own: float32 samples at the server's input
 * rate in binary frames, the text `Done` once the audio ends, and a JSON result
 * after every decoding step. The text of a result is everything recognised in
 * the current segment so far; `is_final` closes the segment, and the next one
 * starts empty. The server answers the end of the audio with the text `Done!`
 * and never closes the socket itself.
 */

const DEFAULT_BASE_URL = 'ws://localhost:6006';
/** The server's `--input-sample-rate` default, which few deployments change. */
const SERVER_SAMPLE_RATE = 16_000;
const END_OF_AUDIO = 'Done';
const END_OF_RESULTS = 'Done!';
const CONTEXT = { provider: 'sherpa-onnx' };

const toMs = (seconds: number): number => Math.round(seconds * 1000);

const resultSchema = z.object({
  text: z.string(),
  segment: z.number().int().nonnegative().optional(),
  start_time: z.number().finite().nonnegative().optional(),
  timestamps: z.array(z.number().finite()).optional(),
  is_final: z.boolean().optional(),
});

type Result = z.infer<typeof resultSchema>;

/**
 * PCM16 at the capture's rate into float32 at the server's, linearly
 * interpolated. The read position carries over from chunk to chunk, so the
 * stream is resampled as one signal rather than chunk by chunk.
 */
export function createPcm16ToFloat32(
  inputRate: number,
  outputRate: number,
): (pcm: Uint8Array) => Uint8Array {
  if (!Number.isFinite(inputRate) || inputRate <= 0) {
    throw new AiError('invalid_request', `Invalid sample rate ${String(inputRate)}`, CONTEXT);
  }
  const step = inputRate / outputRate;
  let previous = 0;
  // Position of the next output sample, with `previous` at -1.
  let position = 0;

  return pcm => {
    if (pcm.byteLength % 2 !== 0) {
      throw new AiError('invalid_request', 'PCM16 audio has an odd number of bytes', CONTEXT);
    }
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const count = pcm.byteLength / 2;
    const sample = (index: number): number =>
      index < 0 ? previous : view.getInt16(index * 2, true) / 32_768;

    const output: number[] = [];
    if (step === 1) {
      for (let index = 0; index < count; index += 1) output.push(sample(index));
    } else {
      while (position <= count - 1) {
        const left = Math.floor(position);
        const fraction = position - left;
        const from = sample(left);
        const to = fraction === 0 ? from : sample(left + 1);
        output.push(from + (to - from) * fraction);
        position += step;
      }
      position -= count;
    }
    if (count > 0) previous = sample(count - 1);

    const bytes = new Uint8Array(output.length * 4);
    const out = new DataView(bytes.buffer);
    output.forEach((value, index) => out.setFloat32(index * 4, value, true));
    return bytes;
  };
}

async function* asFloat32(
  audio: AsyncIterable<AudioChunk>,
  sampleRate: number,
): AsyncIterable<AudioChunk> {
  const convert = createPcm16ToFloat32(sampleRate, SERVER_SAMPLE_RATE);
  for await (const chunk of audio) {
    const data = convert(chunk.data);
    if (data.byteLength > 0) yield { data };
  }
}

export const sherpaOnnxSttProvider: SttProviderFactory = ({
  baseUrl,
  openSocket: socketOpener,
}) => {
  const url = baseUrl ?? DEFAULT_BASE_URL;

  return {
    transcribe(): Promise<never> {
      return Promise.reject(
        new AiError(
          'invalid_request',
          'The sherpa-onnx streaming server transcribes live audio only',
          CONTEXT,
        ),
      );
    },

    async transcribeStream(request: ProviderStreamRequest): Promise<AsyncIterable<SttStreamEvent>> {
      const context = { ...CONTEXT, model: request.modelId };
      const audio = asFloat32(request.audio, request.sampleRate);

      const session = await openSocket(url, {
        signal: request.connectSignal ?? request.signal,
        lifetimeSignal: request.signal,
        context,
        openSocket: socketOpener,
      });

      let pumpError: unknown;
      const pump = pumpAudio(audio, session, END_OF_AUDIO);
      const onAbort = (): void => {
        pump.stop();
        session.close();
      };
      request.signal.addEventListener('abort', onAbort, { once: true });
      if (request.signal.aborted) onAbort();
      const pumpDone = pump.done.catch(error => {
        pumpError = error;
        session.close();
      });

      return (async function* events(): AsyncIterable<SttStreamEvent> {
        // The server repeats the same result after every decoding step.
        let draft = '';
        try {
          for await (const message of session.messages) {
            if (message === END_OF_RESULTS) break;

            const result: Result = parseProviderResponse(
              resultSchema,
              JSON.parse(message) as unknown,
              context,
            );
            const text = result.text.trim();
            const startMs = toMs(result.start_time ?? 0);

            if (result.is_final === true) {
              if (text.length > 0) {
                const lastToken = result.timestamps?.at(-1) ?? 0;
                yield {
                  type: 'final',
                  segment: { startMs, endMs: startMs + toMs(lastToken), text },
                };
              } else if (draft.length > 0) {
                // A draft the segment did not keep must not stay on screen.
                yield { type: 'partial', text: '', startMs };
              }
              draft = '';
              continue;
            }

            if (text === draft) continue;
            draft = text;
            yield { type: 'partial', text, startMs };
          }
        } finally {
          request.signal.removeEventListener('abort', onAbort);
          pump.stop();
          session.close();
          await pumpDone;
        }
        if (pumpError !== undefined) throw pumpError;
      })();
    },
  } satisfies SttProvider;
};
