import { generateObject, generateText, streamText, type ModelMessage } from 'ai';
import type { z } from 'zod';

import type { Catalog } from '../catalog/catalog.js';
import { calculateCost, estimateTokens } from '../catalog/pricing.js';
import { AiError, StreamInterruptedError } from '../errors.js';
import { selectCandidates, type ModelCandidate, type PolicyInput } from '../policy/policy.js';
import type { RoutedBy, TokenUsage, UsageSink } from '../ports.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { StreamPart } from '../stream/stream-parts.js';
import { attemptCandidates, type AttemptDeps, type AttemptRequest } from './attempt.js';
import { classifyError } from './classify.js';

export { DEFAULT_RETRY_POLICY } from './attempt.js';
export type { RetryPolicy } from './attempt.js';

/**
 * The call itself: pick a candidate, try it, fall back, price the result.
 *
 * Two rules shape everything here. The time budget belongs to the whole call
 * rather than to an attempt, because three sixty-second retries are three
 * minutes of somebody staring at a spinner. And nothing is retried once output
 * has reached the reader — a second answer overwriting a half-read first is
 * worse than an interrupted one.
 */

export interface ExecutionDeps extends AttemptDeps {
  catalog: Catalog;
  registry: ProviderRegistry;
  usage: UsageSink;
}

interface CommonRequest extends AttemptRequest {
  policy: PolicyInput;
  /** Instructions. Untrusted material belongs in `messages`, wrapped. */
  system?: string;
  messages: ModelMessage[];
  temperature?: number;
  maxOutputTokens?: number;
}

export interface GenerateRequest<T = never> extends CommonRequest {
  /** Present means structured output through `generateObject`. */
  schema?: z.ZodType<T>;
  schemaName?: string;
  schemaDescription?: string;
}

export interface CallAccounting {
  provider: string;
  model: string;
  /** The consumer's own id for the route that answered, when it gave one. */
  routeId?: string;
  routedBy: RoutedBy;
  usage: TokenUsage;
  costMicros: number;
  priceVersion: string;
  /** Provider requests made, retries and fallbacks included. */
  attempts: number;
  latencyMs: number;
}

export interface GenerateResult<T = never> extends CallAccounting {
  text: string;
  /** Set only when the request carried a schema. */
  object: T | undefined;
  finishReason: string;
}

export type StreamRequest = CommonRequest;

/**
 * Parts whose arrival means the answer has begun.
 *
 * Everything before one of these is invisible to the reader, which is exactly
 * the window in which another model may still be tried.
 */
const VISIBLE_PARTS: ReadonlySet<string> = new Set([
  'text-delta',
  'reasoning-delta',
  'tool-call',
  'tool-result',
  'tool-error',
  'source',
  'file',
]);

const EMPTY_USAGE: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
};

/** The SDK's usage shape, flattened to the four numbers that get billed. */
function normalizeUsage(raw: unknown): TokenUsage {
  const usage = (raw ?? {}) as {
    inputTokens?: number;
    outputTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number };
    outputTokenDetails?: { reasoningTokens?: number };
  };
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cachedInputTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? 0,
  };
}

function accounting(
  candidate: ModelCandidate,
  usage: TokenUsage,
  attempts: number,
  latencyMs: number,
): CallAccounting {
  // Priced off the route that answered, not the model that was asked for: on a
  // fallback the two are the same model at different money, and charging the
  // first choice's price for the second one's work is a discrepancy that only
  // shows up when somebody reconciles an invoice.
  const cost = calculateCost(
    {
      name: candidate.model.name,
      provider: candidate.route.provider,
      ...(candidate.route.pricing === undefined ? {} : { pricing: candidate.route.pricing }),
    },
    usage,
  );
  return {
    provider: candidate.route.provider,
    model: candidate.model.name,
    ...(candidate.route.id === undefined ? {} : { routeId: candidate.route.id }),
    routedBy: candidate.routedBy,
    usage,
    costMicros: cost.totalMicros,
    priceVersion: cost.priceVersion,
    attempts,
    latencyMs,
  };
}

async function recordUsage(
  deps: ExecutionDeps,
  request: CommonRequest,
  data: CallAccounting,
  status: 'ok' | 'error' | 'aborted' | 'filtered',
): Promise<void> {
  deps.trace.generation({
    traceId: request.traceId,
    name: request.name ?? 'generate',
    provider: data.provider,
    model: data.model,
    startedAt: deps.clock.now() - data.latencyMs,
    endedAt: deps.clock.now(),
    usage: data.usage,
    costMicros: data.costMicros,
    status,
  });

  await deps.usage.record({
    provider: data.provider,
    model: data.model,
    ...(data.routeId === undefined ? {} : { routeId: data.routeId }),
    routedBy: data.routedBy,
    usage: data.usage,
    costMicros: data.costMicros,
    priceVersion: data.priceVersion,
    status,
    latencyMs: data.latencyMs,
    attempts: data.attempts,
    traceId: request.traceId,
    audioSeconds: 0,
    characters: 0,
  });
}

/** One answer, optionally validated against a schema. */
export async function runGenerate<T = never>(
  deps: ExecutionDeps,
  request: GenerateRequest<T>,
): Promise<GenerateResult<T>> {
  const candidates = selectCandidates(
    {
      ...request.policy,
      signals: {
        ...request.policy.signals,
        needsStructuredOutput:
          request.policy.signals.needsStructuredOutput ?? Boolean(request.schema),
        maxOutputTokens: request.policy.signals.maxOutputTokens ?? request.maxOutputTokens,
      },
    },
    deps.catalog,
  );

  const startedAt = deps.clock.now();

  const outcome = await attemptCandidates(deps, candidates, request, {
    prepare: candidate => deps.registry.languageModel(candidate.model, candidate.route),
    run: async ({ client: model, signal }) => {
      const common = {
        model,
        system: request.system,
        messages: request.messages,
        temperature: request.temperature,
        maxOutputTokens: request.maxOutputTokens,
        abortSignal: signal,
        // The SDK retries too, and two retry loops multiply: the time budget
        // stops meaning anything and `attempts` stops matching reality. The
        // rules of 7.4 live here, so the one underneath is turned off.
        maxRetries: 0,
      };

      if (request.schema) {
        const result = await generateObject({
          ...common,
          schema: request.schema,
          schemaName: request.schemaName,
          schemaDescription: request.schemaDescription,
        });
        return {
          text: JSON.stringify(result.object),
          object: result.object as T,
          finishReason: String(result.finishReason),
          usage: normalizeUsage(result.usage),
        };
      }

      const result = await generateText(common);
      return {
        text: result.text,
        object: undefined,
        finishReason: String(result.finishReason),
        usage: normalizeUsage(result.totalUsage),
      };
    },
  });

  const data = accounting(
    outcome.candidate,
    outcome.value.usage,
    outcome.attempts,
    deps.clock.now() - startedAt,
  );
  await recordUsage(deps, request, data, 'ok');

  return {
    ...data,
    text: outcome.value.text,
    object: outcome.value.object,
    finishReason: outcome.value.finishReason,
  };
}

/**
 * The same call, streamed.
 *
 * The generator yields `model` before any text so the interface can say who is
 * answering, and `usage` at the end so the caller can bill. A failure after the
 * first delta arrives as an `error` part rather than a thrown value: by then
 * the caller has already written half an answer somewhere and needs to finish
 * handling it, not to unwind.
 */
export async function* runStream(
  deps: ExecutionDeps,
  request: StreamRequest,
): AsyncGenerator<StreamPart, void, undefined> {
  const candidates = selectCandidates(
    {
      ...request.policy,
      signals: {
        ...request.policy.signals,
        needsStreaming: true,
        maxOutputTokens: request.policy.signals.maxOutputTokens ?? request.maxOutputTokens,
      },
    },
    deps.catalog,
  );

  const startedAt = deps.clock.now();
  let emitted = false;
  let text = '';

  // Retry and fallback happen inside here, and only up to the first part the
  // reader would see. Past that the answer is committed to whichever model
  // produced it.
  const outcome = await attemptCandidates(deps, candidates, request, {
    prepare: candidate => deps.registry.languageModel(candidate.model, candidate.route),
    run: async ({ client: model, candidate, signal }) => {
      const result = streamText({
        model,
        system: request.system,
        messages: request.messages,
        temperature: request.temperature,
        maxOutputTokens: request.maxOutputTokens,
        abortSignal: signal,
        maxRetries: 0,
        // The SDK's default handler writes to the console, and this package
        // does not log. Failures leave through the stream, where they belong.
        onError: () => undefined,
      });

      // The SDK opens every stream with bookkeeping parts — `start`,
      // `start-step`, `text-start` — and only then contacts the provider, so a
      // failure shows up several parts in. Draining up to the first visible
      // output is what makes "before the first token" a boundary the retry loop
      // can act on; anything drained is replayed below, not lost.
      const iterator = result.fullStream[Symbol.asyncIterator]();
      const prelude: Array<Awaited<ReturnType<typeof iterator.next>>['value']> = [];

      for (;;) {
        const step = await iterator.next();
        if (step.done) break;
        if (step.value.type === 'error') {
          throw classifyError(step.value.error, {
            provider: candidate.route.provider,
            model: candidate.model.name,
            callerAborted: request.abortSignal?.aborted,
          });
        }
        prelude.push(step.value);
        if (VISIBLE_PARTS.has(step.value.type)) break;
      }

      return { iterator, prelude };
    },
  });

  const candidate = outcome.candidate;
  yield {
    type: 'model',
    provider: candidate.route.provider,
    model: candidate.model.name,
    ...(candidate.route.id === undefined ? {} : { routeId: candidate.route.id }),
    routedBy: candidate.routedBy,
  };

  let usage: TokenUsage = EMPTY_USAGE;
  let finishReason = 'stop';
  let status: 'ok' | 'error' | 'aborted' | 'filtered' = 'ok';
  let failure: AiError | undefined;

  try {
    const iterator = outcome.value.iterator;
    const replay = [...outcome.value.prelude];
    let step: IteratorResult<(typeof replay)[number]> =
      replay.length > 0 ? { done: false, value: replay.shift() } : await iterator.next();

    while (!step.done) {
      const part = step.value;

      switch (part.type) {
        case 'text-delta':
          emitted = true;
          text += part.text;
          yield { type: 'text-delta', text: part.text };
          break;
        case 'reasoning-delta':
          yield { type: 'reasoning-delta', text: part.text };
          break;
        case 'tool-call':
          yield {
            type: 'tool-call',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            args: part.input,
          };
          break;
        case 'tool-result':
          yield {
            type: 'tool-result',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            result: part.output,
          };
          break;
        case 'tool-error':
          yield {
            type: 'tool-result',
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            result: part.error,
            isError: true,
          };
          break;
        case 'source':
          yield {
            type: 'sources',
            sources: [
              part.sourceType === 'url'
                ? { url: part.url, title: part.title }
                : { url: '', title: part.title },
            ],
          };
          break;
        case 'finish-step':
          // Kept because a stream that fails mid-answer never reaches the
          // final `finish`, and the tokens it burned are still owed.
          usage = normalizeUsage(part.usage);
          if (part.finishReason) finishReason = String(part.finishReason);
          break;
        case 'finish':
          if (part.finishReason) finishReason = String(part.finishReason);
          usage = normalizeUsage(part.totalUsage);
          break;
        case 'abort':
          status = 'aborted';
          failure = new AiError('aborted', 'The stream was aborted');
          break;
        case 'error':
          // Not a break: the accounting parts arrive after the error, and a
          // stream that produced tokens is billed whether or not it finished.
          failure ??= classifyError(part.error, {
            provider: candidate.route.provider,
            model: candidate.model.name,
            callerAborted: request.abortSignal?.aborted,
          });
          break;
        default:
          break;
      }

      if (failure?.kind === 'aborted') break;
      step = replay.length > 0 ? { done: false, value: replay.shift() } : await iterator.next();
    }
  } catch (error) {
    failure = classifyError(error, {
      provider: candidate.route.provider,
      model: candidate.model.name,
      callerAborted: request.abortSignal?.aborted,
    });
  }

  if (failure && failure.kind !== 'aborted') {
    // Output already delivered means the failure is an interruption, not a
    // reason to pretend the call never happened.
    status = failure.kind === 'content_filter' ? 'filtered' : 'error';
    if (emitted) failure = new StreamInterruptedError(text, { cause: failure });
  }
  if (failure?.kind === 'aborted') status = 'aborted';

  // Providers commonly omit final usage when a stream is cancelled. Billing
  // zero after visible output would make "generate and cancel" free, so use a
  // conservative text estimate when no provider accounting arrived.
  if (emitted && usage.outputTokens === 0) {
    const input = [request.system ?? '', JSON.stringify(request.messages)].join('\n');
    usage = {
      ...usage,
      inputTokens: usage.inputTokens || estimateTokens(input),
      outputTokens: estimateTokens(text),
    };
  }

  const data = accounting(candidate, usage, outcome.attempts, deps.clock.now() - startedAt);
  // Anything that produced output is paid for, including a stream somebody
  // stopped. Otherwise "generate and cancel" is a free tier nobody designed.
  await recordUsage(deps, request, data, status);

  yield {
    type: 'usage',
    usage: data.usage,
    costMicros: data.costMicros,
    priceVersion: data.priceVersion,
  };

  if (failure) {
    yield {
      type: 'error',
      kind: failure.kind,
      message: failure.message,
      recoverable: failure.retryable || failure.kind === 'stream_interrupted',
    };
    return;
  }

  yield { type: 'finish', finishReason };
}
