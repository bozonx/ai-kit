import type { Catalog } from '../catalog/catalog.js';
import { calculateSttCost, UNPRICED } from '../catalog/pricing.js';
import { AiError, callStatusFor } from '../errors.js';
import { attemptCandidates, type AttemptDeps, type AttemptRequest } from '../execute/attempt.js';
import { classifyError } from '../execute/classify.js';
import { NO_TOKENS, recordCall } from '../execute/record.js';
import {
  candidatePolicyOf,
  selectCandidates,
  type CandidatePolicy,
  type ModelCandidate,
} from '../policy/policy.js';
import { isPriced, quoteCandidate, type CandidatePlan } from '../policy/quote.js';
import type { CallStatus, UsageSink } from '../ports.js';
import { assertSttCapabilities } from './policy.js';
import { estimateAudioSeconds } from './audio.js';
import type { SttProviderRegistry } from './registry.js';
import type {
  AudioChunk,
  AudioSource,
  SttAccounting,
  TranscriptPart,
  TranscriptSegment,
  TranscriptionOptions,
  TranscriptionResult,
} from './types.js';

/**
 * Transcribing: pick a model, try it, fall back, price the seconds.
 *
 * The retry loop is the one the text side uses; what differs is the unit. Audio
 * is billed by the second, the duration is known before the call rather than
 * after it, and in a live session the clock that counts is the connection's —
 * silence is paid for, which is why a dictation session that nobody is talking
 * into has to be closed rather than left open.
 */

export interface SttExecutionDeps extends AttemptDeps {
  catalog: Catalog;
  registry: SttProviderRegistry;
  usage: UsageSink;
}

/** Which model, in the same terms the text side uses. */
export type SttPolicyInput = CandidatePolicy;

interface CommonSttRequest extends AttemptRequest {
  policy: SttPolicyInput;
  options?: TranscriptionOptions;
  /**
   * A plan from `AiKit.planTranscription` for this same request, so the call
   * tries exactly the models the caller quoted and reserved for.
   */
  plan?: CandidatePlan;
}

export interface TranscribeRequest extends CommonSttRequest {
  source: AudioSource;
}

export interface StreamTranscribeRequest extends CommonSttRequest {
  /** PCM16 mono frames, in the order they were captured. */
  audio: AsyncIterable<AudioChunk>;
  /** Sample rate of that PCM, in hertz. 16 kHz is what every provider wants. */
  sampleRate?: number;
}

export type { SttAccounting } from './types.js';

export interface TranscribeResult extends SttAccounting, TranscriptionResult {}

const DEFAULT_SAMPLE_RATE = 16_000;

/** What a transcription is expected to take, for its quotes. */
export interface SttPlanUsage {
  /** Seconds of audio: the file's length, or how long a live session may run. */
  audioSeconds: number;
  /** A live session, which is priced and filtered as one. Default false. */
  realtime?: boolean;
}

/**
 * The models a transcription would try and what each could cost.
 *
 * @throws AiError('invalid_request') when the task class is not served by
 *   speech models, and NoSuitableModelError when none fits.
 */
export function planTranscribe(
  catalog: Catalog,
  request: Pick<CommonSttRequest, 'policy' | 'options'>,
  usage: SttPlanUsage,
): CandidatePlan {
  const policy = request.policy;
  // An unknown or text-shaped task class is refused rather than defaulted:
  // guessing here would route somebody's audio to whichever model happened to
  // be first in a list written for something else.
  if (catalog.kindOf(policy.taskClass) !== 'stt') {
    throw new AiError('invalid_request', `Task class "${policy.taskClass}" is not a speech task`);
  }

  const options = request.options ?? {};
  const realtime = usage.realtime ?? false;
  const input = {
    ...candidatePolicyOf(policy),
    signals: {
      estimatedInputTokens: 0,
      language: options.language,
      needsRealtime: realtime,
      needsWordTimings: options.wordTimings,
      needsDiarization: options.diarization,
    },
  };
  const candidates = selectCandidates(input, catalog);
  return {
    candidates,
    quotes: candidates.map(candidate => ({
      candidate,
      priced: isPriced(candidate),
      costMicros: quoteCandidate(candidate, input, {
        audioSeconds: usage.audioSeconds,
        realtime,
        ...(options.diarization === undefined ? {} : { diarization: options.diarization }),
      }),
    })),
  };
}

function pickCandidates(
  deps: SttExecutionDeps,
  request: CommonSttRequest,
  realtime: boolean,
): ModelCandidate[] {
  return (
    request.plan?.candidates ??
    planTranscribe(deps.catalog, request, { audioSeconds: 0, realtime }).candidates
  );
}

function record(
  deps: SttExecutionDeps,
  request: CommonSttRequest,
  data: SttAccounting,
  status: CallStatus,
): Promise<void> {
  return recordCall(deps, {
    name: request.name ?? 'transcribe',
    event: {
      provider: data.provider,
      model: data.model,
      ...(data.routeId === undefined ? {} : { routeId: data.routeId }),
      routedBy: data.routedBy,
      usage: NO_TOKENS,
      audioSeconds: data.audioSeconds,
      characters: 0,
      costMicros: data.costMicros,
      priceVersion: data.priceVersion,
      priced: data.priced,
      status,
      latencyMs: data.latencyMs,
      attempts: data.attempts,
      ...(request.traceId === undefined ? {} : { traceId: request.traceId }),
    },
    trace: { metadata: { audioSeconds: data.audioSeconds } },
  });
}

function priceIt(
  candidate: ModelCandidate,
  audioSeconds: number,
  options: TranscriptionOptions,
  realtime: boolean,
  attempts: number,
  latencyMs: number,
): SttAccounting {
  const sttPricing = candidate.route.sttPricing;
  const cost = sttPricing
    ? calculateSttCost(
        { name: candidate.model.name, provider: candidate.route.provider, sttPricing },
        { audioSeconds, realtime, diarization: options.diarization },
      )
    : undefined;
  return {
    provider: candidate.route.provider,
    model: candidate.model.name,
    ...(candidate.route.id === undefined ? {} : { routeId: candidate.route.id }),
    routedBy: candidate.routedBy,
    audioSeconds: cost?.billedSeconds ?? audioSeconds,
    costMicros: cost?.totalMicros ?? 0,
    priceVersion: cost?.priceVersion ?? UNPRICED,
    priced: cost !== undefined,
    attempts,
    latencyMs,
  };
}

/** One file, one transcript. */
export async function runTranscribe(
  deps: SttExecutionDeps,
  request: TranscribeRequest,
): Promise<TranscribeResult> {
  const options = request.options ?? {};
  const candidates = pickCandidates(deps, request, false);
  const startedAt = deps.clock.now();

  const outcome = await attemptCandidates(deps, candidates, request, {
    operation: 'transcribe',
    prepare: candidate => deps.registry.provider(candidate.model, candidate.route, request.keys),
    run: async ({ client, candidate, signal }) => {
      // Checked per candidate rather than once: a fallback is a different
      // model, and the option the caller asked for is not automatically one it
      // has. A pinned model that cannot do the job fails here, loudly.
      assertSttCapabilities(candidate.model, options, false);
      const result = await client.transcribe({
        modelId: candidate.route.model,
        source: request.source,
        options,
        signal,
      });
      const estimatedAudioSeconds =
        'data' in request.source && request.source.data instanceof Uint8Array
          ? estimateAudioSeconds(request.source.data.byteLength, request.source.mimeType)
          : undefined;
      const audioSeconds =
        Number.isFinite(result.audioSeconds) && result.audioSeconds > 0
          ? result.audioSeconds
          : estimatedAudioSeconds;
      if (audioSeconds === undefined || !Number.isFinite(audioSeconds) || audioSeconds <= 0) {
        throw new AiError(
          'provider_unavailable',
          `Provider "${candidate.route.provider}" did not report a valid audio duration`,
          { provider: candidate.route.provider, model: candidate.model.name },
        );
      }
      return { ...result, audioSeconds };
    },
  });

  const data = priceIt(
    outcome.candidate,
    outcome.value.audioSeconds,
    options,
    false,
    outcome.attempts,
    deps.clock.now() - startedAt,
  );
  await record(deps, request, data, 'ok');

  return { ...outcome.value, ...data };
}

/**
 * Live dictation, part by part.
 *
 * `partial` may be replaced in full; `final` never changes. Everything already
 * emitted as final is in the caller's document by the time a session breaks,
 * which is the whole reason the two are different parts and not one field.
 */
export async function* runTranscribeStream(
  deps: SttExecutionDeps,
  request: StreamTranscribeRequest,
): AsyncGenerator<TranscriptPart, void, undefined> {
  const options = request.options ?? {};
  const candidates = pickCandidates(deps, request, true);
  const sampleRate = request.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const startedAt = deps.clock.now();

  // Only the connection is retried. Past the first word the session belongs to
  // whoever answered: reconnecting to a second provider mid-sentence would
  // rewrite text somebody is already reading.
  const outcome = await attemptCandidates(deps, candidates, request, {
    operation: 'transcribe',
    prepare: candidate => deps.registry.provider(candidate.model, candidate.route, request.keys),
    run: async ({ client, candidate, signal }) => {
      assertSttCapabilities(candidate.model, options, true);
      if (!client.transcribeStream) {
        throw new AiError(
          'invalid_request',
          `Provider "${candidate.route.provider}" has no live transcription`,
          { provider: candidate.route.provider, model: candidate.model.name },
        );
      }
      return client.transcribeStream({
        modelId: candidate.route.model,
        options,
        sampleRate,
        audio: request.audio,
        connectSignal: signal,
        signal: request.abortSignal ?? new AbortController().signal,
      });
    },
  });

  const candidate = outcome.candidate;
  const connectedAt = deps.clock.now();

  yield {
    type: 'model',
    provider: candidate.route.provider,
    model: candidate.model.name,
    ...(candidate.route.id === undefined ? {} : { routeId: candidate.route.id }),
    routedBy: candidate.routedBy,
  };

  let index = 0;
  let language = options.language;
  let status: CallStatus = 'ok';
  let failure: AiError | undefined;

  try {
    for await (const event of outcome.value) {
      switch (event.type) {
        case 'partial':
          yield { type: 'partial', text: event.text, startMs: event.startMs };
          break;
        case 'final': {
          const segment: TranscriptSegment = { ...event.segment, index };
          index += 1;
          yield { type: 'final', segment };
          break;
        }
        case 'language':
          language = event.language;
          break;
      }
    }
  } catch (error) {
    failure = classifyError(error, {
      provider: candidate.route.provider,
      model: candidate.model.name,
      callerAborted: request.abortSignal?.aborted,
    });
    status = callStatusFor(failure.kind);
  }

  // Billed on the time the session was open, not on the words that came out of
  // it: that is how the providers charge, and a session dropped after four
  // minutes of speech has already cost us four minutes.
  const openSeconds = (deps.clock.now() - connectedAt) / 1000;
  const data = priceIt(
    candidate,
    openSeconds,
    options,
    true,
    outcome.attempts,
    deps.clock.now() - startedAt,
  );
  await record(deps, request, data, status);

  yield { type: 'usage', ...data };

  if (failure) {
    yield {
      type: 'error',
      kind: failure.kind,
      message: failure.message,
      recoverable: failure.retryable,
    };
    return;
  }

  yield { type: 'finish', language };
}
