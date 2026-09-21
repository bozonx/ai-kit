import type { Catalog } from '../catalog/catalog.js';
import { calculateSttCost } from '../catalog/pricing.js';
import type { TaskClass } from '../catalog/schema.js';
import { AiError } from '../errors.js';
import { attemptCandidates, type AttemptDeps, type AttemptRequest } from '../execute/attempt.js';
import { classifyError } from '../execute/classify.js';
import { selectCandidates, type ModelCandidate } from '../policy/policy.js';
import type { CallStatus, RoutedBy, TokenUsage, UsageSink } from '../ports.js';
import { assertSttCapabilities } from './policy.js';
import type { SttProviderRegistry } from './registry.js';
import type {
  AudioChunk,
  AudioSource,
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

const NO_TOKENS: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
};

export interface SttExecutionDeps extends AttemptDeps {
  catalog: Catalog;
  registry: SttProviderRegistry;
  usage: UsageSink;
}

/** Which model, in the same two modes the text side has. */
export interface SttPolicyInput {
  /** `manual` honours `requestedModel`; `auto` follows the catalog's order. */
  mode: 'auto' | 'manual';
  /** One of `dictation`, `transcription`, `subtitles`. */
  taskClass: TaskClass;
  requestedModel?: string | string[];
}

interface CommonSttRequest extends AttemptRequest {
  policy: SttPolicyInput;
  options?: TranscriptionOptions;
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

/** What a finished transcription cost and who produced it. */
export interface SttAccounting {
  provider: string;
  model: string;
  /** The consumer's own id for the route that answered, when it gave one. */
  routeId?: string;
  routedBy: RoutedBy;
  audioSeconds: number;
  costMicros: number;
  priceVersion: string;
  attempts: number;
  latencyMs: number;
}

export interface TranscribeResult extends SttAccounting, TranscriptionResult {}

const DEFAULT_SAMPLE_RATE = 16_000;

function pickCandidates(
  deps: SttExecutionDeps,
  policy: SttPolicyInput,
  options: TranscriptionOptions,
  realtime: boolean,
): ModelCandidate[] {
  // An unknown or text-shaped task class is refused rather than defaulted:
  // guessing here would route somebody's audio to whichever model happened to
  // be first in a list written for something else.
  if (deps.catalog.kindOf(policy.taskClass) !== 'stt') {
    throw new AiError('invalid_request', `Task class "${policy.taskClass}" is not a speech task`);
  }

  return selectCandidates(
    {
      mode: policy.mode,
      taskClass: policy.taskClass,
      requestedModel: policy.requestedModel,
      signals: {
        estimatedInputTokens: 0,
        language: options.language,
        needsRealtime: realtime,
        needsWordTimings: options.wordTimings,
        needsDiarization: options.diarization,
      },
    },
    deps.catalog,
  );
}

async function record(
  deps: SttExecutionDeps,
  request: CommonSttRequest,
  data: SttAccounting,
  status: CallStatus,
): Promise<void> {
  deps.trace.generation({
    traceId: request.traceId,
    name: request.name ?? 'transcribe',
    provider: data.provider,
    model: data.model,
    startedAt: deps.clock.now() - data.latencyMs,
    endedAt: deps.clock.now(),
    costMicros: data.costMicros,
    status,
    metadata: { audioSeconds: data.audioSeconds },
  });

  await deps.usage.record({
    provider: data.provider,
    model: data.model,
    ...(data.routeId === undefined ? {} : { routeId: data.routeId }),
    routedBy: data.routedBy,
    usage: NO_TOKENS,
    audioSeconds: data.audioSeconds,
    characters: 0,
    costMicros: data.costMicros,
    priceVersion: data.priceVersion,
    status,
    latencyMs: data.latencyMs,
    attempts: data.attempts,
    traceId: request.traceId,
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
  const cost = calculateSttCost(
    {
      name: candidate.model.name,
      provider: candidate.route.provider,
      ...(candidate.route.sttPricing === undefined
        ? {}
        : { sttPricing: candidate.route.sttPricing }),
    },
    {
      audioSeconds,
      realtime,
      diarization: options.diarization,
    },
  );
  return {
    provider: candidate.route.provider,
    model: candidate.model.name,
    ...(candidate.route.id === undefined ? {} : { routeId: candidate.route.id }),
    routedBy: candidate.routedBy,
    audioSeconds: cost.billedSeconds,
    costMicros: cost.totalMicros,
    priceVersion: cost.priceVersion,
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
  const candidates = pickCandidates(deps, request.policy, options, false);
  const startedAt = deps.clock.now();

  const outcome = await attemptCandidates(deps, candidates, request, {
    prepare: candidate => deps.registry.provider(candidate.model, candidate.route, request.keys),
    run: async ({ client, candidate, signal }) => {
      // Checked per candidate rather than once: a fallback is a different
      // model, and the option the caller asked for is not automatically one it
      // has. A pinned model that cannot do the job fails here, loudly.
      assertSttCapabilities(candidate.model, options, false);
      return client.transcribe({
        modelId: candidate.route.model,
        source: request.source,
        options,
        signal,
      });
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
  const candidates = pickCandidates(deps, request.policy, options, true);
  const sampleRate = request.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const startedAt = deps.clock.now();

  // Only the connection is retried. Past the first word the session belongs to
  // whoever answered: reconnecting to a second provider mid-sentence would
  // rewrite text somebody is already reading.
  const outcome = await attemptCandidates(deps, candidates, request, {
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
        signal,
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
    status = failure.kind === 'aborted' ? 'aborted' : 'error';
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

  yield {
    type: 'usage',
    audioSeconds: data.audioSeconds,
    costMicros: data.costMicros,
    priceVersion: data.priceVersion,
  };

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
