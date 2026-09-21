import type { Catalog } from '../catalog/catalog.js';
import { estimateCost, estimateMtCost, estimateSttCost } from '../catalog/pricing.js';
import { selectCandidates, type ModelCandidate, type PolicyInput } from './policy.js';

/**
 * What a request would cost at each candidate that could answer it.
 *
 * A consumer that reserves budget before a call has to hold enough for the
 * dearest candidate in the fallback chain, not only the first: a backup route
 * may cost more than the route that failed, and a hold sized for the first
 * choice lets the fallback walk through a ceiling the first attempt respected.
 * Every consumer that reserves ends up writing this loop, once per kind of
 * model, so it lives here.
 *
 * The list is returned rather than its maximum because "dearest" is not always
 * a question of cost alone — a consumer applying a markup that depends on the
 * model's price has to weigh each candidate itself.
 */

/** The units a non-token call is measured in. Language models read `signals`. */
export interface QuoteUsage {
  /** Speech: seconds of audio. */
  audioSeconds?: number;
  /** Speech: whether it is a live session, which has its own price. */
  realtime?: boolean;
  /** Speech: whether the diarization surcharge applies. */
  diarization?: boolean;
  /** Translation engines: characters handed over. */
  characters?: number;
  /**
   * Embeddings: tokens across every input. `signals.estimatedInputTokens`
   * holds the largest single one, which is what the fit check needs.
   */
  embeddingTokens?: number;
}

export interface CandidateQuote {
  candidate: ModelCandidate;
  /** Upper estimate for this candidate, in micro-units of the currency. */
  costMicros: number;
  /**
   * False when the route carries no price, and `costMicros` is zero because
   * the cost is unknown. Only a catalog with `requirePricing: false` has these.
   */
  priced: boolean;
}

/**
 * A call decided but not made: which candidates, in what order, and what each
 * could cost at worst.
 *
 * A consumer that reserves budget needs the quotes before the call and the call
 * needs the candidates; handing the same plan to both is what keeps the hold
 * and the attempt about the same models. Every call accepts one as `plan`.
 */
export interface CandidatePlan {
  candidates: ModelCandidate[];
  /** Every candidate with its worst-case cost, in the same order. */
  quotes: CandidateQuote[];
}

/**
 * Every candidate `selectCandidates` would try, each with its worst-case cost.
 *
 * A language model is priced against `input.signals.estimatedInputTokens` and
 * its full output allowance (`signals.maxOutputTokens`, capped at the model's
 * own limit). A candidate whose route carries no price is quoted at zero.
 *
 * @throws NoSuitableModelError when nothing in the catalog fits the request.
 */
export function quoteCandidates(
  input: PolicyInput,
  catalog: Catalog,
  usage: QuoteUsage = {},
): CandidateQuote[] {
  return selectCandidates(input, catalog).map(candidate => ({
    candidate,
    costMicros: quoteCandidate(candidate, input, usage),
    priced: isPriced(candidate),
  }));
}

/** Whether the candidate's route carries the price block its kind is billed by. */
export function isPriced({ model, route }: ModelCandidate): boolean {
  switch (model.kind) {
    case 'stt':
      return route.sttPricing !== undefined;
    case 'mt':
      return route.mtPricing !== undefined;
    default:
      return route.pricing !== undefined;
  }
}

/** Worst-case cost of one candidate already selected. Internal to the package. */
export function quoteCandidate(
  candidate: ModelCandidate,
  input: PolicyInput,
  usage: QuoteUsage = {},
): number {
  const { model, route } = candidate;
  const priced = { name: model.name, provider: route.provider };

  switch (model.kind) {
    case 'stt':
      if (!route.sttPricing) return 0;
      return estimateSttCost(
        { ...priced, sttPricing: route.sttPricing },
        {
          audioSeconds: usage.audioSeconds ?? 0,
          ...(usage.realtime === undefined ? {} : { realtime: usage.realtime }),
          ...(usage.diarization === undefined ? {} : { diarization: usage.diarization }),
        },
      );
    case 'mt':
      if (!route.mtPricing) return 0;
      return estimateMtCost(
        { ...priced, mtPricing: route.mtPricing },
        { characters: usage.characters ?? 0 },
      );
    case 'embedding':
      if (!route.pricing) return 0;
      return estimateCost(
        { ...priced, pricing: route.pricing },
        usage.embeddingTokens ?? input.signals.estimatedInputTokens,
        0,
      );
    default:
      if (!route.pricing) return 0;
      return estimateCost(
        {
          ...priced,
          pricing: route.pricing,
          ...(model.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: model.maxOutputTokens }),
        },
        input.signals.estimatedInputTokens,
        input.signals.maxOutputTokens,
      );
  }
}
