import type { TokenUsage } from '../ports.js';
import type { ModelDefinition } from './schema.js';

/**
 * What a call cost.
 *
 * Arithmetic, and the reason it is arithmetic and not a lookup table: the price
 * of an operation is derived from the tokens it burned and the price list in
 * force, so a change of provider prices is a change of one YAML file rather
 * than a re-pricing of every product feature.
 *
 * Everything is in micro-units of the currency (1_000_000 = 1 USD) and stays an
 * integer from end to end. Rounding happens once, at the end, upwards — over a
 * million calls a half-unit rounded the friendly way is real money lost.
 */

export interface CostBreakdown {
  /** Uncached input tokens at the full input price. */
  inputMicros: number;
  /** Input tokens served from the provider's cache, at the cached price. */
  cachedInputMicros: number;
  outputMicros: number;
  /** Reasoning tokens, when the provider prices them apart from output. */
  reasoningMicros: number;
  /** Flat charges: generated images, seconds of video. */
  flatMicros: number;
  totalMicros: number;
  priceVersion: string;
}

export interface FlatUsage {
  images?: number;
  videoSeconds?: number;
}

function perMTok(tokens: number, pricePerMTok: number): number {
  if (tokens <= 0 || pricePerMTok <= 0) return 0;
  return (tokens * pricePerMTok) / 1_000_000;
}

/**
 * Prices one call against one model.
 *
 * Cached input is subtracted from the input total rather than added on top:
 * providers report cached tokens as a subset of the input count, and billing
 * them twice is the single easiest way to overstate cost.
 */
export function calculateCost(
  model: ModelDefinition,
  usage: TokenUsage,
  flat: FlatUsage = {},
): CostBreakdown {
  const pricing = model.pricing;

  const cachedTokens = Math.max(0, Math.min(usage.cachedInputTokens, usage.inputTokens));
  const uncachedTokens = Math.max(0, usage.inputTokens - cachedTokens);

  // Without a cached price the provider does not discount cached input, so it
  // is billed like any other input token.
  const cachedPrice = pricing.cachedInputPerMTok ?? pricing.inputPerMTok;

  // Reasoning tokens are part of the output count for every provider that
  // reports them, so they are only priced separately when a separate price
  // exists — otherwise they are already inside `outputTokens`.
  const reasoningTokens = pricing.reasoningPerMTok === undefined ? 0 : usage.reasoningTokens;
  const outputTokens = Math.max(0, usage.outputTokens - reasoningTokens);

  const inputMicros = perMTok(uncachedTokens, pricing.inputPerMTok);
  const cachedInputMicros = perMTok(cachedTokens, cachedPrice);
  const outputMicros = perMTok(outputTokens, pricing.outputPerMTok);
  const reasoningMicros = perMTok(reasoningTokens, pricing.reasoningPerMTok ?? 0);

  const flatMicros =
    (flat.images ?? 0) * (pricing.perImage ?? 0) +
    (flat.videoSeconds ?? 0) * (pricing.perVideoSecond ?? 0);

  const total = inputMicros + cachedInputMicros + outputMicros + reasoningMicros + flatMicros;

  return {
    inputMicros: Math.ceil(inputMicros),
    cachedInputMicros: Math.ceil(cachedInputMicros),
    outputMicros: Math.ceil(outputMicros),
    reasoningMicros: Math.ceil(reasoningMicros),
    flatMicros,
    totalMicros: Math.ceil(total),
    priceVersion: pricing.version,
  };
}

/**
 * Upper estimate before the call, for consumers that reserve budget in advance.
 *
 * Deliberately pessimistic: it assumes the model writes to its output limit.
 * A reservation that turns out too large is refunded on settlement, while one
 * that turns out too small has already let the spend through.
 */
export function estimateCost(
  model: ModelDefinition,
  estimatedInputTokens: number,
  maxOutputTokens?: number,
): number {
  const outputTokens = Math.min(maxOutputTokens ?? model.maxOutputTokens, model.maxOutputTokens);
  return calculateCost(model, {
    inputTokens: Math.max(0, estimatedInputTokens),
    outputTokens: Math.max(0, outputTokens),
    cachedInputTokens: 0,
    reasoningTokens: 0,
  }).totalMicros;
}

/**
 * Rough token count for a piece of text.
 *
 * Four characters to a token is wrong for every language and right enough for
 * choosing a model and sizing a reservation. Anything that has to be exact
 * uses the count the provider returns afterwards.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}
