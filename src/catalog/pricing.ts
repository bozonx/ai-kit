import type { TokenUsage } from '../ports.js';
import { CatalogError } from '../errors.js';
import type { ModelPricing, MtPricing, SttPricing } from './schema.js';

/**
 * Anything that carries a price.
 *
 * A model definition and a resolved route both do, and both are priced by the
 * same arithmetic: the numbers live on the route when the model is reachable
 * at more than one, and on the model itself when it is not. Taking the price
 * block rather than the model is what keeps that from becoming two copies of
 * this file.
 */
export interface PricedLlm {
  name?: string;
  provider?: string;
  pricing?: ModelPricing;
  maxOutputTokens?: number;
}

export interface PricedStt {
  name?: string;
  provider?: string;
  sttPricing?: SttPricing;
}

export interface PricedMt {
  name?: string;
  provider?: string;
  mtPricing?: MtPricing;
}

/**
 * The price version recorded for a call whose route carries no price.
 *
 * Only reachable in a catalog with `requirePricing: false`, and always next to
 * `priced: false` — a zero cost on its own would read as a free call.
 */
export const UNPRICED = 'unpriced';

function label(priced: { name?: string; provider?: string }): string {
  if (priced.name && priced.provider) return `"${priced.name}" at "${priced.provider}"`;
  return priced.name ? `"${priced.name}"` : 'this route';
}

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
  model: PricedLlm,
  usage: TokenUsage,
  flat: FlatUsage = {},
): CostBreakdown {
  const pricing = model.pricing;
  if (!pricing) {
    throw new CatalogError(`No per-token pricing for ${label(model)}`);
  }

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
  model: PricedLlm,
  estimatedInputTokens: number,
  maxOutputTokens?: number,
): number {
  const limit = model.maxOutputTokens ?? 0;
  const outputTokens = Math.min(maxOutputTokens ?? limit, limit);
  return calculateCost(model, {
    inputTokens: Math.max(0, estimatedInputTokens),
    outputTokens: Math.max(0, outputTokens),
    cachedInputTokens: 0,
    reasoningTokens: 0,
  }).totalMicros;
}

/**
 * Characters per token for text in the Latin script.
 *
 * Wrong for every language and right enough for choosing a model and sizing a
 * reservation. Anything that has to be exact uses the count the provider
 * returns afterwards.
 */
const LATIN_CHARS_PER_TOKEN = 4;

/**
 * Characters per token for scripts the common BPE vocabularies barely cover.
 *
 * Cyrillic, Greek, Hebrew, Arabic and the Indic scripts are tokenized far more
 * finely than Latin — frequently one token per character, rarely better than
 * two. Estimating them at four characters a token understates the real count
 * by two to three times, and the two places that matter both fail quietly when
 * it does: a reservation that is too small has already let the spend through,
 * and a chat history budget that is too generous sends three times the context
 * it was told to. Two is the conservative end of the observed range.
 */
const DENSE_SCRIPT_CHARS_PER_TOKEN = 2;

/**
 * CJK is denser still: roughly one token per character, sometimes fewer for
 * common words. One is the safe assumption.
 */
const CJK_CHARS_PER_TOKEN = 1;

// Named by script rather than by code point range: the ranges are unreadable,
// and a combining mark is a character the tokenizer pays for like any other.
const DENSE_SCRIPT =
  /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Thai}]/gu;
const CJK_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/**
 * Rough token count for a piece of text.
 *
 * Counts each script at its own density rather than assuming everything reads
 * like English. Still an estimate, and still deliberately on the high side:
 * both callers — the pre-call reservation and the chat history budget — are
 * safe when it overshoots and quietly wrong when it undershoots.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  const cjkChars = text.match(CJK_SCRIPT)?.length ?? 0;
  const denseChars = text.match(DENSE_SCRIPT)?.length ?? 0;
  const latinChars = Math.max(0, text.length - cjkChars - denseChars);

  return Math.ceil(
    cjkChars / CJK_CHARS_PER_TOKEN +
      denseChars / DENSE_SCRIPT_CHARS_PER_TOKEN +
      latinChars / LATIN_CHARS_PER_TOKEN,
  );
}

/** How a stretch of audio was transcribed, in the terms it is billed by. */
export interface SttUsage {
  audioSeconds: number;
  /**
   * Streamed rather than submitted as a file.
   *
   * In realtime the clock that runs is the connection's, not the speech's:
   * silence is paid for. That is not a rounding detail — it is the reason a
   * dictation session has to be closed when nobody is talking.
   */
  realtime?: boolean;
  diarization?: boolean;
}

export interface SttCostBreakdown {
  /** Seconds actually charged, after rounding up to a whole second. */
  billedSeconds: number;
  baseMicros: number;
  diarizationMicros: number;
  totalMicros: number;
  priceVersion: string;
}

const SECONDS_PER_HOUR = 3_600;

function perAudioHour(seconds: number, pricePerHour: number): number {
  if (seconds <= 0 || pricePerHour <= 0) return 0;
  return (seconds * pricePerHour) / SECONDS_PER_HOUR;
}

/**
 * Prices one transcription.
 *
 * Seconds are rounded up to a whole second before anything is multiplied,
 * because that is what the providers bill; half a second lost per call is a
 * discrepancy between our reports and theirs that nobody reconciles later.
 * Everything after that is the same rule as tokens: integers, micro-units, one
 * rounding at the end, upwards.
 */
export function calculateSttCost(model: PricedStt, usage: SttUsage): SttCostBreakdown {
  const pricing = model.sttPricing;
  if (!pricing) {
    throw new CatalogError(`No per-audio-hour pricing for ${label(model)}`);
  }

  const billedSeconds = Math.max(0, Math.ceil(usage.audioSeconds));

  // Falling back to the batch price when a realtime one is missing is on
  // purpose: the alternative is billing zero for a session that really ran.
  const basePrice =
    usage.realtime && pricing.perAudioHourRealtimeMicros !== undefined
      ? pricing.perAudioHourRealtimeMicros
      : pricing.perAudioHourMicros;

  const baseMicros = perAudioHour(billedSeconds, basePrice);
  const diarizationMicros = usage.diarization
    ? perAudioHour(billedSeconds, pricing.diarizationPerAudioHourMicros ?? 0)
    : 0;

  return {
    billedSeconds,
    baseMicros: Math.ceil(baseMicros),
    diarizationMicros: Math.ceil(diarizationMicros),
    totalMicros: Math.ceil(baseMicros + diarizationMicros),
    priceVersion: pricing.version,
  };
}

/**
 * What a transcription will cost, before it runs.
 *
 * Unlike the token estimate this one is not a guess: the duration of a file is
 * known from `ffprobe` before a provider is called, which makes speech the one
 * place in AI where an exact price can be quoted up front.
 */
export function estimateSttCost(model: PricedStt, usage: SttUsage): number {
  return calculateSttCost(model, usage).totalMicros;
}

/** How a translation was billed: by the characters handed to the engine. */
export interface MtUsage {
  characters: number;
}

export interface MtCostBreakdown {
  /** Characters actually charged. Whole characters; there is no half of one. */
  billedCharacters: number;
  totalMicros: number;
  priceVersion: string;
}

const CHARS_PER_MILLION = 1_000_000;

/**
 * Prices one translation by a dedicated engine.
 *
 * Characters of *input*, because that is what the engines charge for: the
 * result has not been produced when the meter starts, and billing the output
 * would make the same paragraph cost different money depending on how verbose
 * the target language is.
 */
export function calculateMtCost(model: PricedMt, usage: MtUsage): MtCostBreakdown {
  const pricing = model.mtPricing;
  if (!pricing) {
    throw new CatalogError(`No per-character pricing for ${label(model)}`);
  }

  const billedCharacters = Math.max(0, Math.ceil(usage.characters));
  const total = (billedCharacters * pricing.perMillionCharsMicros) / CHARS_PER_MILLION;

  return {
    billedCharacters,
    totalMicros: Math.ceil(total),
    priceVersion: pricing.version,
  };
}

/**
 * What a translation will cost, before it runs.
 *
 * Exact rather than estimated, like speech and unlike tokens: the characters
 * are counted from the text in hand.
 */
export function estimateMtCost(model: PricedMt, usage: MtUsage): number {
  return calculateMtCost(model, usage).totalMicros;
}
