import {
  generateObject,
  generateText,
  streamText,
  type LanguageModel,
  type ModelMessage,
} from 'ai';
import type { z } from 'zod';

import type { Catalog } from '../catalog/catalog.js';
import { calculateCost, estimateTokens } from '../catalog/pricing.js';
import type { ModelDefinition } from '../catalog/schema.js';
import { AiError, AllCandidatesFailedError, StreamInterruptedError } from '../errors.js';
import { selectCandidates, type ModelCandidate, type PolicyInput } from '../policy/policy.js';
import type { Clock, RoutedBy, TokenUsage, TraceSink, UsageSink } from '../ports.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { StreamPart } from '../stream/stream-parts.js';
import { classifyError } from './classify.js';

/**
 * The call itself: pick a candidate, try it, fall back, price the result.
 *
 * Two rules shape everything here. The time budget belongs to the whole call
 * rather than to an attempt, because three sixty-second retries are three
 * minutes of somebody staring at a spinner. And nothing is retried once output
 * has reached the reader — a second answer overwriting a half-read first is
 * worse than an interrupted one.
 */

/** How hard to try. Defaults are the ones a chat wants; batch work may differ. */
export interface RetryPolicy {
  /** Extra attempts on the same model after the first one fails. */
  maxRetriesPerCandidate: number;
  initialDelayMs: number;
  maxDelayMs: number;
  /** Ceiling for the whole call, retries and fallbacks included. */
  totalTimeoutMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetriesPerCandidate: 2,
  initialDelayMs: 500,
  maxDelayMs: 4_000,
  totalTimeoutMs: 120_000,
};

export interface ExecutionDeps {
  catalog: Catalog;
  registry: ProviderRegistry;
  usage: UsageSink;
  trace: TraceSink;
  clock: Clock;
  retry: RetryPolicy;
}

interface CommonRequest {
  policy: PolicyInput;
  /** Instructions. Untrusted material belongs in `messages`, wrapped. */
  system?: string;
  messages: ModelMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
  /** Overrides `RetryPolicy.totalTimeoutMs` for this call. */
  totalTimeoutMs?: number;
  /** Correlates the call with the consumer's logs and product analytics. */
  traceId?: string;
  /** What to call this call in a trace. Usually the product feature. */
  name?: string;
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AiError('aborted', 'The call was aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AiError('aborted', 'The call was aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Exponential backoff with jitter, so retries from many callers do not line up. */
function backoffMs(attempt: number, retry: RetryPolicy): number {
  const base = Math.min(retry.initialDelayMs * 2 ** attempt, retry.maxDelayMs);
  return Math.round(base / 2 + Math.random() * (base / 2));
}

/**
 * A signal that fires on the caller's abort or when the call's time is up.
 *
 * The remaining budget shrinks with every attempt, which is the point: the
 * deadline is a property of the request, not of the try.
 */
function attemptSignal(deadline: number, clock: Clock, caller?: AbortSignal): AbortSignal {
  const remaining = Math.max(1, deadline - clock.now());
  const timeout = AbortSignal.timeout(remaining);
  return caller ? AbortSignal.any([caller, timeout]) : timeout;
}

function accounting(
  candidate: ModelCandidate,
  usage: TokenUsage,
  attempts: number,
  latencyMs: number,
): CallAccounting {
  const cost = calculateCost(candidate.model, usage);
  return {
    provider: candidate.model.provider,
    model: candidate.model.name,
    routedBy: candidate.routedBy,
    usage,
    costMicros: cost.totalMicros,
    priceVersion: cost.priceVersion,
    attempts,
    latencyMs,
  };
}

interface AttemptOutcome<R> {
  value: R;
  candidate: ModelCandidate;
  attempts: number;
}

/**
 * Walks the candidate list, retrying each one under the rules of 7.4.
 *
 * `onFirstOutput` is how a stream opts out of retrying: once it has emitted
 * anything the caller can see, it reports so, and a later failure is raised
 * rather than re-attempted.
 */
async function attemptCandidates<R>(
  deps: ExecutionDeps,
  candidates: ModelCandidate[],
  request: CommonRequest,
  run: (params: {
    model: LanguageModel;
    definition: ModelDefinition;
    signal: AbortSignal;
  }) => Promise<R>,
): Promise<AttemptOutcome<R>> {
  const retry = {
    ...deps.retry,
    totalTimeoutMs: request.totalTimeoutMs ?? deps.retry.totalTimeoutMs,
  };
  const deadline = deps.clock.now() + retry.totalTimeoutMs;
  const failures: Array<{ provider: string; model: string; error: AiError }> = [];
  let attempts = 0;

  for (const candidate of candidates) {
    for (let tryIndex = 0; tryIndex <= retry.maxRetriesPerCandidate; tryIndex += 1) {
      if (request.abortSignal?.aborted) {
        throw new AiError('aborted', 'The call was aborted');
      }
      if (deps.clock.now() >= deadline) {
        throw new AiError('timeout', 'The call ran out of its time budget');
      }

      attempts += 1;
      try {
        const model = await deps.registry.languageModel(candidate.model);
        const value = await run({
          model,
          definition: candidate.model,
          signal: attemptSignal(deadline, deps.clock, request.abortSignal),
        });
        return { value, candidate, attempts };
      } catch (error) {
        const classified = classifyError(error, {
          provider: candidate.model.provider,
          model: candidate.model.name,
          callerAborted: request.abortSignal?.aborted,
        });

        if (classified.kind === 'aborted' || classified.kind === 'stream_interrupted') {
          throw classified;
        }

        failures.push({
          provider: candidate.model.provider,
          model: candidate.model.name,
          error: classified,
        });

        deps.trace.span({
          traceId: request.traceId,
          name: `${request.name ?? 'generate'}.attempt-failed`,
          startedAt: deps.clock.now(),
          endedAt: deps.clock.now(),
          metadata: {
            provider: candidate.model.provider,
            model: candidate.model.name,
            kind: classified.kind,
          },
        });

        const canRetrySameModel = classified.retryable && tryIndex < retry.maxRetriesPerCandidate;
        if (!canRetrySameModel) break;

        const wait = backoffMs(tryIndex, retry);
        if (deps.clock.now() + wait >= deadline) break;
        await sleep(wait, request.abortSignal);
      }
    }
  }

  // A single non-retryable failure explains itself better than a list of one.
  const only = failures.length === 1 ? failures[0] : undefined;
  if (only) throw only.error;
  throw new AllCandidatesFailedError(failures);
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
    routedBy: data.routedBy,
    usage: data.usage,
    costMicros: data.costMicros,
    priceVersion: data.priceVersion,
    status,
    latencyMs: data.latencyMs,
    attempts: data.attempts,
    traceId: request.traceId,
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

  const outcome = await attemptCandidates(deps, candidates, request, async ({ model, signal }) => {
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
  const outcome = await attemptCandidates(
    deps,
    candidates,
    request,
    async ({ model, definition, signal }) => {
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
            provider: definition.provider,
            model: definition.name,
            callerAborted: request.abortSignal?.aborted,
          });
        }
        prelude.push(step.value);
        if (VISIBLE_PARTS.has(step.value.type)) break;
      }

      return { iterator, prelude };
    },
  );

  const candidate = outcome.candidate;
  yield {
    type: 'model',
    provider: candidate.model.provider,
    model: candidate.model.name,
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
            provider: candidate.model.provider,
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
      provider: candidate.model.provider,
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
