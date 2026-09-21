/**
 * `@bozonx/ai-kit` — the part of an AI feature that is the same in every product.
 *
 * What lives here is everything a second product would otherwise rewrite from
 * memory: a priced model catalog, the rules for choosing a model and retrying a
 * call, the wire vocabulary of a streamed answer, error classification, and the
 * ports through which a host supplies keys and observability.
 *
 * What deliberately does not live here is anything that knows about tenants,
 * users, projects or a database — and, since 0.3.0, anything that knows what a
 * product calls its own kinds of work either. If a component needs one of those
 * words, it has been put in the wrong repository.
 */

export { Catalog } from './catalog/catalog.js';
export type { ResolvedRoute } from './catalog/catalog.js';

export {
  taskClassSchema,
  modelKindSchema,
  sttPricingSchema,
  sttCapabilitiesSchema,
  mtPricingSchema,
  mtCapabilitiesSchema,
  catalogSchema,
  modelSchema,
  modelRouteSchema,
  pricingSchema,
  capabilitiesSchema,
  routeCapabilitiesSchema,
  modelTierSchema,
  modalitySchema,
} from './catalog/schema.js';

export type {
  TaskClass,
  ModelKind,
  ModelTier,
  Modality,
  ModelPricing,
  ModelCapabilities,
  RouteCapabilities,
  ModelRouteDefinition,
  SttPricing,
  SttCapabilities,
  MtPricing,
  MtCapabilities,
  ModelDefinition,
  ModelDefinitionInput,
  CatalogData,
  CatalogInput,
} from './catalog/schema.js';

export {
  calculateCost,
  estimateCost,
  estimateTokens,
  calculateSttCost,
  estimateSttCost,
  calculateMtCost,
  estimateMtCost,
} from './catalog/pricing.js';
export type {
  CostBreakdown,
  FlatUsage,
  PricedLlm,
  PricedStt,
  PricedMt,
  SttUsage,
  SttCostBreakdown,
  MtUsage,
  MtCostBreakdown,
} from './catalog/pricing.js';

export {
  AiError,
  StreamInterruptedError,
  AllCandidatesFailedError,
  NoSuitableModelError,
  CatalogError,
  isAiError,
} from './errors.js';
export type { AiErrorKind, AiErrorOptions } from './errors.js';

export { noopTraceSink, noopUsageSink, systemClock } from './ports.js';
export type {
  KeyProvider,
  UsageSink,
  TraceSink,
  Clock,
  RoutedBy,
  CallStatus,
  TokenUsage,
  UsageEvent,
  GenerationTrace,
  SpanTrace,
} from './ports.js';

export type {
  StreamPart,
  StreamPartType,
  ModelPart,
  TextDeltaPart,
  ReasoningDeltaPart,
  ToolCallPart,
  ToolResultPart,
  SourcesPart,
  UsagePart,
  ErrorPart,
  FinishPart,
} from './stream/stream-parts.js';

/**
 * Message shapes come straight from the AI SDK.
 *
 * Re-exported rather than redeclared so that a consumer never has to depend on
 * `ai` itself to type a conversation, and so that an SDK upgrade is one bump in
 * one package instead of a coordinated one across every product.
 */
export type { ModelMessage } from 'ai';

export { createAiKit } from './kit.js';
export type { AiKit, AiKitOptions } from './kit.js';

export { ProviderRegistry } from './providers/registry.js';
export type { ProviderFactory, ProviderRegistryOptions } from './providers/registry.js';

export { selectCandidates, fitsSignals, speaksLanguage } from './policy/policy.js';
export type { PolicyInput, PolicySignals, ModelCandidate } from './policy/policy.js';

export { DEFAULT_RETRY_POLICY, runGenerate, runStream } from './execute/run.js';
export type {
  RetryPolicy,
  ExecutionDeps,
  GenerateRequest,
  GenerateResult,
  StreamRequest,
  CallAccounting,
} from './execute/run.js';

export { classifyError, kindFromStatus } from './execute/classify.js';
export type { ClassifyContext } from './execute/classify.js';

export { SttProviderRegistry } from './stt/registry.js';
export type { SttRegistryOptions } from './stt/registry.js';

export { assertSttCapabilities } from './stt/policy.js';

export { runTranscribe, runTranscribeStream } from './stt/run.js';
export type {
  SttExecutionDeps,
  SttPolicyInput,
  SttAccounting,
  TranscribeRequest,
  TranscribeResult,
  StreamTranscribeRequest,
} from './stt/run.js';

export { assemblyAiSttProvider } from './stt/providers/assemblyai.js';
export { deepgramSttProvider } from './stt/providers/deepgram.js';
export { groqSttProvider } from './stt/providers/groq.js';

export { segmentWords } from './stt/segment-words.js';
export type { SegmentWord } from './stt/segment-words.js';

export { renderSubtitles } from './stt/subtitles.js';
export type {
  SubtitleFormat,
  SubtitleSegment,
  SubtitleWord,
  RenderSubtitlesOptions,
} from './stt/subtitles.js';

export type {
  AudioChunk,
  AudioSource,
  SttProvider,
  SttProviderFactory,
  SttStreamEvent,
  ProviderTranscribeRequest,
  ProviderStreamRequest,
  TranscriptionOptions,
  TranscriptionResult,
  TranscriptSegment,
  WordTiming,
  TranscriptPart,
  TranscriptPartType,
  TranscriptModelPart,
  TranscriptPartialPart,
  TranscriptFinalPart,
  TranscriptUsagePart,
  TranscriptErrorPart,
  TranscriptFinishPart,
} from './stt/types.js';

export { MtProviderRegistry } from './translate/registry.js';
export type { MtRegistryOptions } from './translate/registry.js';

export { googleCloudTranslationProvider } from './translate/providers/google-cloud.js';

export { runTranslate, countCharacters } from './translate/run.js';
export type {
  MtExecutionDeps,
  MtPolicyInput,
  MtAccounting,
  TranslateRequest,
  TranslateResult,
} from './translate/run.js';

export type {
  TranslationFormat,
  TranslationProvider,
  TranslationProviderFactory,
  TranslationRequest,
  TranslationResult,
  ProviderTranslateRequest,
} from './translate/types.js';

export {
  glossaryEntryOccurs,
  glossaryRendering,
  selectGlossaryForText,
  renderGlossaryForPrompt,
  restoreKeptTerms,
  findGlossaryViolations,
} from './translate/glossary.js';
export type { GlossaryEntry } from './translate/glossary.js';

export {
  TRANSLATION_PROBLEM_CODES,
  TRANSLATION_QUALITY_THRESHOLDS,
  detectTranslationProblems,
  renderProblemsForPrompt,
} from './translate/quality.js';
export type {
  TranslationProblem,
  TranslationProblemCode,
  TranslationQualityInput,
} from './translate/quality.js';

export { buildPrompt, wrapUntrusted, escapeUntrusted } from './prompt/untrusted.js';
export type { BuildPromptInput, BuiltPrompt, UntrustedBlock } from './prompt/untrusted.js';

export { parseModelInput, formatModelRef } from './utils/model-ref.js';
export type { ModelRef, ParsedModelInput } from './utils/model-ref.js';
