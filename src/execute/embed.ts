import { embedMany } from 'ai';

import type { Catalog } from '../catalog/catalog.js';
import { calculateCost, estimateTokens } from '../catalog/pricing.js';
import type { TaskClass } from '../catalog/schema.js';
import { AiError } from '../errors.js';
import { selectCandidates, type ModelCandidate } from '../policy/policy.js';
import type { CallStatus, RoutedBy, UsageSink } from '../ports.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { attemptCandidates, type AttemptDeps, type AttemptRequest } from './attempt.js';
import type { ProviderOptions } from './run.js';

/**
 * Turning text into vectors: pick a model, try it, price the tokens.
 *
 * The same loop as every other call. Two things differ. Nothing is shown to
 * anybody until the call is over, so the whole call may be retried. And the
 * vectors of two different models are not comparable, so a fallback to another
 * *model* would silently corrupt the index the vectors are written to — which
 * is why a caller filling an index pins the model and lets only its routes
 * vary.
 */

export interface EmbedExecutionDeps extends AttemptDeps {
  catalog: Catalog;
  registry: ProviderRegistry;
  usage: UsageSink;
}

export interface EmbedPolicyInput {
  /** `manual` honours `requestedModel`; `auto` follows the catalog's order. */
  mode: 'auto' | 'manual';
  taskClass: TaskClass;
  /**
   * Pin this when the vectors go into an existing index: only the same model
   * at another provider is then an acceptable fallback.
   */
  requestedModel?: string | string[];
  /** BCP-47 tag of the text, when known. */
  language?: string;
  /** Routes the caller does not want tried first, by their own route id. */
  demotedRoutes?: ReadonlySet<string>;
}

export interface EmbedRequest extends AttemptRequest {
  policy: EmbedPolicyInput;
  values: string[];
  providerOptions?: ProviderOptions;
}

export interface EmbedAccounting {
  provider: string;
  model: string;
  routeId?: string;
  routedBy: RoutedBy;
  /** Input tokens, as the provider counted them, or estimated when it did not. */
  tokens: number;
  costMicros: number;
  priceVersion: string;
  attempts: number;
  latencyMs: number;
}

export interface EmbedResult extends EmbedAccounting {
  /** One vector per value, in the same order. */
  embeddings: number[][];
  /** Vector length, so the caller can check it against its index. */
  dimensions: number;
}

/** A batch of strings, one vector each. */
export async function runEmbed(
  deps: EmbedExecutionDeps,
  request: EmbedRequest,
): Promise<EmbedResult> {
  if (deps.catalog.kindOf(request.policy.taskClass) !== 'embedding') {
    throw new AiError(
      'invalid_request',
      `Task class "${request.policy.taskClass}" is not an embedding task`,
    );
  }
  if (request.values.length === 0) {
    throw new AiError('invalid_request', 'Nothing to embed');
  }

  const perValue = request.values.map(value => estimateTokens(value));
  const candidates = selectCandidates(
    {
      mode: request.policy.mode,
      taskClass: request.policy.taskClass,
      ...(request.policy.requestedModel === undefined
        ? {}
        : { requestedModel: request.policy.requestedModel }),
      ...(request.policy.demotedRoutes === undefined
        ? {}
        : { demotedRoutes: request.policy.demotedRoutes }),
      signals: {
        estimatedInputTokens: Math.max(...perValue),
        ...(request.policy.language === undefined ? {} : { language: request.policy.language }),
      },
    },
    deps.catalog,
  );

  const startedAt = deps.clock.now();
  const outcome = await attemptCandidates(deps, candidates, request, {
    operation: 'embed',
    prepare: candidate =>
      deps.registry.embeddingModel(candidate.model, candidate.route, request.keys),
    run: async ({ client, signal }) => {
      const result = await embedMany({
        model: client,
        values: request.values,
        abortSignal: signal,
        maxRetries: 0,
        ...(request.providerOptions === undefined
          ? {}
          : { providerOptions: request.providerOptions }),
      });
      return { embeddings: result.embeddings, tokens: result.usage.tokens };
    },
  });

  // A provider that reports no usage is still paid: the estimate stands in.
  const tokens =
    outcome.value.tokens > 0 ? outcome.value.tokens : perValue.reduce((a, b) => a + b, 0);
  const data = priceIt(outcome.candidate, tokens, outcome.attempts, deps.clock.now() - startedAt);
  await record(deps, request, data, 'ok');

  return {
    ...data,
    embeddings: outcome.value.embeddings,
    dimensions: outcome.value.embeddings[0]?.length ?? 0,
  };
}

function priceIt(
  candidate: ModelCandidate,
  tokens: number,
  attempts: number,
  latencyMs: number,
): EmbedAccounting {
  const cost = calculateCost(
    {
      name: candidate.model.name,
      provider: candidate.route.provider,
      ...(candidate.route.pricing === undefined ? {} : { pricing: candidate.route.pricing }),
    },
    { inputTokens: tokens, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 },
  );
  return {
    provider: candidate.route.provider,
    model: candidate.model.name,
    ...(candidate.route.id === undefined ? {} : { routeId: candidate.route.id }),
    routedBy: candidate.routedBy,
    tokens,
    costMicros: cost.totalMicros,
    priceVersion: cost.priceVersion,
    attempts,
    latencyMs,
  };
}

async function record(
  deps: EmbedExecutionDeps,
  request: EmbedRequest,
  data: EmbedAccounting,
  status: CallStatus,
): Promise<void> {
  const usage = {
    inputTokens: data.tokens,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
  };
  deps.trace.generation({
    traceId: request.traceId,
    name: request.name ?? 'embed',
    provider: data.provider,
    model: data.model,
    startedAt: deps.clock.now() - data.latencyMs,
    endedAt: deps.clock.now(),
    usage,
    costMicros: data.costMicros,
    status,
    metadata: { values: request.values.length },
  });

  await deps.usage.record({
    provider: data.provider,
    model: data.model,
    ...(data.routeId === undefined ? {} : { routeId: data.routeId }),
    routedBy: data.routedBy,
    usage,
    audioSeconds: 0,
    characters: 0,
    costMicros: data.costMicros,
    priceVersion: data.priceVersion,
    status,
    latencyMs: data.latencyMs,
    attempts: data.attempts,
    traceId: request.traceId,
  });
}
