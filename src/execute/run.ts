import {
  generateText,
  isStepCount,
  Output,
  streamText,
  type ModelMessage,
  type ToolChoice,
  type ToolSet,
} from 'ai';
import type { z } from 'zod';

import type { Catalog } from '../catalog/catalog.js';
import { calculateCost, estimateTokens } from '../catalog/pricing.js';
import { AiError, StreamInterruptedError, callStatusFor } from '../errors.js';
import { selectCandidates, type ModelCandidate, type PolicyInput } from '../policy/policy.js';
import { signalsFor } from '../policy/signals.js';
import type { CallStatus, RoutedBy, TokenUsage, UsageSink } from '../ports.js';
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

/**
 * Settings for one provider, by provider id, passed through untouched.
 *
 * The escape hatch for what only one provider has — a thinking budget, a cache
 * breakpoint, an upstream routing preference. Keyed by provider so that a
 * fallback to another provider simply ignores what was not meant for it.
 */
export type ProviderOptions = NonNullable<Parameters<typeof generateText>[0]['providerOptions']>;

interface CommonRequest extends AttemptRequest {
  policy: PolicyInput;
  /** Instructions. Untrusted material belongs in `messages`, wrapped. */
  system?: string;
  messages: ModelMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  providerOptions?: ProviderOptions;
  /**
   * Tools the model may call. Their presence makes `needsTools` true, so only
   * candidates that can call tools are tried.
   */
  tools?: ToolSet;
  toolChoice?: ToolChoice<ToolSet>;
  /**
   * How many model steps a call may take: each tool round trip is one more.
   * Defaults to 1, which returns the tool calls without a follow-up answer.
   */
  maxSteps?: number;
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

/** One tool the model called during the call, with what it got back. */
export interface ToolActivity {
  toolCallId: string;
  toolName: string;
  args: unknown;
  /** Absent when the tool has no `execute` and the caller runs it. */
  result?: unknown;
}

export interface GenerateResult<T = never> extends CallAccounting {
  text: string;
  /** Set only when the request carried a schema. */
  object: T | undefined;
  finishReason: string;
  /** Every tool call across every step, in order. Empty without tools. */
  toolCalls: ToolActivity[];
  /**
   * The assistant and tool messages this call produced, ready to be appended
   * to `messages` for the next turn.
   */
  responseMessages: ModelMessage[];
  /** Model steps taken; more than one only with tools and `maxSteps`. */
  steps: number;
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

function hasTools(request: CommonRequest): boolean | undefined {
  return request.tools && Object.keys(request.tools).length > 0 ? true : undefined;
}

/** The request fields the SDK takes as they are, present only when set. */
function sdkExtras(request: CommonRequest) {
  return {
    ...(request.providerOptions === undefined ? {} : { providerOptions: request.providerOptions }),
    ...(request.tools === undefined ? {} : { tools: request.tools }),
    ...(request.toolChoice === undefined ? {} : { toolChoice: request.toolChoice }),
    ...(request.maxSteps === undefined ? {} : { stopWhen: isStepCount(request.maxSteps) }),
  };
}

interface StepLike {
  toolCalls: ReadonlyArray<{ toolCallId: string; toolName: string; input: unknown }>;
  toolResults: ReadonlyArray<{ toolCallId: string; output: unknown }>;
}

function toolActivity(steps: readonly StepLike[]): ToolActivity[] {
  return steps.flatMap(step =>
    step.toolCalls.map(call => {
      const result = step.toolResults.find(item => item.toolCallId === call.toolCallId);
      return {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        args: call.input,
        ...(result === undefined ? {} : { result: result.output }),
      };
    }),
  );
}

function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  };
}

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
  status: CallStatus,
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
        needsTools: request.policy.signals.needsTools ?? hasTools(request),
        maxOutputTokens: request.policy.signals.maxOutputTokens ?? request.maxOutputTokens,
      },
    },
    deps.catalog,
  );

  const startedAt = deps.clock.now();

  const outcome = await attemptCandidates(deps, candidates, request, {
    prepare: candidate =>
      deps.registry.languageModel(candidate.model, candidate.route, request.keys),
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
        ...sdkExtras(request),
      };

      const result = request.schema
        ? await generateText({
            ...common,
            output: Output.object({
              schema: request.schema,
              ...(request.schemaName === undefined ? {} : { name: request.schemaName }),
              ...(request.schemaDescription === undefined
                ? {}
                : { description: request.schemaDescription }),
            }),
          })
        : await generateText(common);

      const object = request.schema ? (result.output as T) : undefined;
      return {
        text: request.schema ? JSON.stringify(object) : result.text,
        object,
        finishReason: String(result.finishReason),
        usage: normalizeUsage(result.usage),
        toolCalls: toolActivity(result.steps),
        responseMessages: result.responseMessages as ModelMessage[],
        steps: result.steps.length,
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
    toolCalls: outcome.value.toolCalls,
    responseMessages: outcome.value.responseMessages,
    steps: outcome.value.steps,
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
 *
 * A consumer may stop reading at any point. The provider request is then
 * cancelled and the call is still recorded, as `aborted`, with whatever it had
 * produced by then.
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
        needsTools: request.policy.signals.needsTools ?? hasTools(request),
        maxOutputTokens: request.policy.signals.maxOutputTokens ?? request.maxOutputTokens,
      },
    },
    deps.catalog,
  );

  const startedAt = deps.clock.now();
  let emitted = false;
  let text = '';

  // Aborted when the consumer walks away from the generator. The caller's own
  // signal says "stop", this one says "nobody is reading any more" — and both
  // mean the provider should stop generating tokens somebody pays for.
  const abandoned = new AbortController();
  const abortSignal = request.abortSignal
    ? AbortSignal.any([request.abortSignal, abandoned.signal])
    : abandoned.signal;

  // Retry and fallback happen inside here, and only up to the first part the
  // reader would see. Past that the answer is committed to whichever model
  // produced it.
  const outcome = await attemptCandidates(
    deps,
    candidates,
    { ...request, abortSignal },
    {
      prepare: candidate =>
        deps.registry.languageModel(candidate.model, candidate.route, request.keys),
      run: async ({ client: model, candidate, signal }) => {
        const result = streamText({
          model,
          system: request.system,
          messages: request.messages,
          temperature: request.temperature,
          maxOutputTokens: request.maxOutputTokens,
          abortSignal: signal,
          maxRetries: 0,
          ...sdkExtras(request),
          // The SDK's default handler writes to the console, and this package
          // does not log. Failures leave through the stream, where they belong.
          onError: () => undefined,
        });

        // The SDK opens every stream with bookkeeping parts — `start`,
        // `start-step`, `text-start` — and only then contacts the provider, so
        // a failure shows up several parts in. Draining up to the first visible
        // output is what makes "before the first token" a boundary the retry
        // loop can act on; anything drained is replayed below, not lost.
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
    },
  );

  const candidate = outcome.candidate;
  const iterator = outcome.value.iterator;

  let usage: TokenUsage = EMPTY_USAGE;
  let finishReason = 'stop';
  let status: CallStatus = 'ok';
  let failure: AiError | undefined;
  let settled: CallAccounting | undefined;

  /**
   * Prices and records the call. Runs exactly once, on whichever path the
   * stream ends — including the one where the consumer stopped reading, which
   * is the path a `UsageSink` would otherwise never hear about.
   */
  const settle = async (): Promise<CallAccounting> => {
    if (settled) return settled;
    // Providers commonly omit final usage when a stream is cancelled. Billing
    // zero after visible output would make "generate and cancel" free, so use
    // a conservative text estimate when no provider accounting arrived.
    if (emitted && usage.outputTokens === 0) {
      usage = {
        ...usage,
        inputTokens: usage.inputTokens || signalsFor(request).estimatedInputTokens,
        outputTokens: estimateTokens(text),
      };
    }
    settled = accounting(candidate, usage, outcome.attempts, deps.clock.now() - startedAt);
    // Anything that produced output is paid for, including a stream somebody
    // stopped. Otherwise "generate and cancel" is a free tier nobody designed.
    await recordUsage(deps, request, settled, status);
    return settled;
  };

  try {
    yield {
      type: 'model',
      provider: candidate.route.provider,
      model: candidate.model.name,
      ...(candidate.route.id === undefined ? {} : { routeId: candidate.route.id }),
      routedBy: candidate.routedBy,
    };

    try {
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
            // Summed because a stream that fails mid-answer never reaches the
            // final `finish`, and the tokens every finished step burned are
            // still owed — with tools there is more than one of them.
            usage = addUsage(usage, normalizeUsage(part.usage));
            if (part.finishReason) finishReason = String(part.finishReason);
            break;
          case 'finish':
            if (part.finishReason) finishReason = String(part.finishReason);
            usage = normalizeUsage(part.totalUsage);
            break;
          case 'abort':
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

    if (failure) {
      status = callStatusFor(failure.kind);
      // Output already delivered means the failure is an interruption, not a
      // reason to pretend the call never happened.
      if (emitted && failure.kind !== 'aborted') {
        failure = new StreamInterruptedError(text, { cause: failure });
      }
    }

    const data = await settle();

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
  } finally {
    if (!settled) {
      // The consumer stopped reading before the end. Stop the provider too,
      // then record what was already produced.
      status = 'aborted';
      abandoned.abort();
      try {
        await iterator.return?.();
      } catch {
        // The stream is being thrown away; how it objects to that is moot.
      }
      await settle();
    }
  }
}
