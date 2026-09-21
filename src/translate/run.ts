import type { Catalog } from '../catalog/catalog.js';
import { calculateMtCost } from '../catalog/pricing.js';
import { AiError } from '../errors.js';
import { attemptCandidates, type AttemptDeps, type AttemptRequest } from '../execute/attempt.js';
import { NO_TOKENS, recordCall } from '../execute/record.js';
import {
  candidatePolicyOf,
  selectCandidates,
  type CandidatePolicy,
  type ModelCandidate,
} from '../policy/policy.js';
import { quoteCandidate, type CandidatePlan } from '../policy/quote.js';
import type { CallStatus, RoutedBy, UsageSink } from '../ports.js';
import type { MtProviderRegistry } from './registry.js';
import type { TranslationFormat, TranslationResult } from './types.js';

/**
 * Translating with a dedicated engine: pick a model, try it, price the
 * characters.
 *
 * The same retry loop as everything else; what differs is the unit. An engine
 * bills the characters it was handed, so the price is exact before the call
 * rather than estimated after it — which is why a quote shown to a customer
 * and the amount finally charged can be the same number here and cannot be for
 * a language model.
 */

export interface MtExecutionDeps extends AttemptDeps {
  catalog: Catalog;
  registry: MtProviderRegistry;
  usage: UsageSink;
}

/** Which engine, in the same terms every other kind of call uses. */
export type MtPolicyInput = CandidatePolicy;

export interface TranslateRequest extends AttemptRequest {
  policy: MtPolicyInput;
  texts: string[];
  targetLanguage: string;
  sourceLanguage?: string;
  format?: TranslationFormat;
  /**
   * A plan from `AiKit.planTranslation` for this same request, so the call
   * tries exactly the engines the caller quoted and reserved for.
   */
  plan?: CandidatePlan;
}

/** What a finished translation cost and who produced it. */
export interface MtAccounting {
  provider: string;
  model: string;
  /** The consumer's own id for the route that answered, when it gave one. */
  routeId?: string;
  routedBy: RoutedBy;
  /** Characters billed, counted from what was sent. */
  characters: number;
  costMicros: number;
  priceVersion: string;
  attempts: number;
  latencyMs: number;
}

export interface TranslateResult extends MtAccounting, TranslationResult {}

/** Characters the engine is handed, which is what every one of them bills. */
export function countCharacters(texts: readonly string[]): number {
  return texts.reduce((total, text) => total + text.length, 0);
}

/**
 * The engines a translation would try and what each would charge, exactly.
 *
 * @throws AiError('invalid_request') when the task class is not served by
 *   translation engines, and NoSuitableModelError when none fits.
 */
export function planTranslate(
  catalog: Catalog,
  request: Omit<TranslateRequest, 'plan'>,
): CandidatePlan {
  // An unknown or text-shaped task class is refused rather than defaulted:
  // routing a translation to whichever model happened to be first in a list
  // written for something else is how a dedicated engine quietly becomes a
  // chat model at twenty times the price.
  if (catalog.kindOf(request.policy.taskClass) !== 'mt') {
    throw new AiError(
      'invalid_request',
      `Task class "${request.policy.taskClass}" is not a machine translation task`,
    );
  }

  const policy = {
    ...candidatePolicyOf(request.policy),
    signals: {
      estimatedInputTokens: 0,
      ...(request.sourceLanguage === undefined ? {} : { language: request.sourceLanguage }),
      needsHtml: request.format === 'html',
    },
  };
  const characters = countCharacters(request.texts);
  const candidates = selectCandidates(policy, catalog);
  return {
    candidates,
    quotes: candidates.map(candidate => ({
      candidate,
      costMicros: quoteCandidate(candidate, policy, { characters }),
    })),
  };
}

function priceIt(
  candidate: ModelCandidate,
  characters: number,
  attempts: number,
  latencyMs: number,
): MtAccounting {
  const cost = calculateMtCost(
    {
      name: candidate.model.name,
      provider: candidate.route.provider,
      ...(candidate.route.mtPricing === undefined ? {} : { mtPricing: candidate.route.mtPricing }),
    },
    { characters },
  );
  return {
    provider: candidate.route.provider,
    model: candidate.model.name,
    ...(candidate.route.id === undefined ? {} : { routeId: candidate.route.id }),
    routedBy: candidate.routedBy,
    characters: cost.billedCharacters,
    costMicros: cost.totalMicros,
    priceVersion: cost.priceVersion,
    attempts,
    latencyMs,
  };
}

function record(
  deps: MtExecutionDeps,
  request: TranslateRequest,
  data: MtAccounting,
  status: CallStatus,
): Promise<void> {
  return recordCall(deps, {
    name: request.name ?? 'translate',
    event: {
      provider: data.provider,
      model: data.model,
      ...(data.routeId === undefined ? {} : { routeId: data.routeId }),
      routedBy: data.routedBy,
      usage: NO_TOKENS,
      audioSeconds: 0,
      characters: data.characters,
      costMicros: data.costMicros,
      priceVersion: data.priceVersion,
      status,
      latencyMs: data.latencyMs,
      attempts: data.attempts,
      ...(request.traceId === undefined ? {} : { traceId: request.traceId }),
    },
    trace: { metadata: { characters: data.characters, targetLanguage: request.targetLanguage } },
  });
}

/** One batch of strings, one translation. */
export async function runTranslate(
  deps: MtExecutionDeps,
  request: TranslateRequest,
): Promise<TranslateResult> {
  const candidates = request.plan?.candidates ?? planTranslate(deps.catalog, request).candidates;
  const characters = countCharacters(request.texts);
  const startedAt = deps.clock.now();

  const outcome = await attemptCandidates(deps, candidates, request, {
    operation: 'translate',
    prepare: candidate => deps.registry.provider(candidate.model, candidate.route, request.keys),
    run: ({ client, candidate, signal }) =>
      client.translate({
        modelId: candidate.route.model,
        texts: request.texts,
        targetLanguage: request.targetLanguage,
        ...(request.sourceLanguage === undefined ? {} : { sourceLanguage: request.sourceLanguage }),
        ...(request.format === undefined ? {} : { format: request.format }),
        signal,
      }),
  });

  const data = priceIt(
    outcome.candidate,
    characters,
    outcome.attempts,
    deps.clock.now() - startedAt,
  );
  await record(deps, request, data, 'ok');

  return { ...outcome.value, ...data };
}
