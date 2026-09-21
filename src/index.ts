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
 *
 * This entry point is the kit and everything needed to call it. Speech and
 * translation extras — provider adapters, subtitles, audio helpers, glossary
 * and quality checks — live in `@bozonx/ai-kit/stt` and
 * `@bozonx/ai-kit/translate`; the stream vocabulary and its SSE codec, for a
 * browser, in `@bozonx/ai-kit/stream`.
 *
 * Nothing reachable from here needs Node: the network goes through the
 * `Transport` port and hashing through Web Crypto, so the same kit runs on a
 * server, in a browser and in a Tauri webview. Reading a catalog file and the
 * `ws` socket live in `@bozonx/ai-kit/node`.
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
  UNPRICED,
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
  isProviderFault,
  callStatusFor,
} from './errors.js';
export type { AiErrorKind, AiErrorOptions, CandidateFailure } from './errors.js';

export { noopAttemptObserver, noopTraceSink, noopUsageSink, systemClock } from './ports.js';
export type {
  CallAccounting,
  KeyProvider,
  UsageSink,
  TraceSink,
  AttemptObserver,
  AttemptFailure,
  Clock,
  RoutedBy,
  CallStatus,
  TokenUsage,
  UsageEvent,
  GenerationTrace,
  SpanTrace,
  Transport,
  FetchFunction,
  SocketOpener,
  OpenSocketOptions,
  SocketSession,
} from './ports.js';

export { platformFetch, platformSocket } from './transport/platform.js';

export type { KeyOverrides } from './providers/client-cache.js';

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
export type { ModelMessage, ToolSet, ToolChoice } from 'ai';

/**
 * Defining a tool is the SDK's own helper, re-exported for the same reason as
 * the message type: a consumer should not need `ai` as a dependency of its own.
 */
export { tool, jsonSchema } from 'ai';

export { createAiKit } from './kit.js';
export type { AiKit, AiKitOptions } from './kit.js';

export type { ProviderFactory, EmbeddingProviderFactory } from './providers/registry.js';

export { selectCandidates, fitsSignals, speaksLanguage, isManual } from './policy/policy.js';
export type {
  CandidatePolicy,
  PolicyInput,
  PolicySignals,
  ModelCandidate,
} from './policy/policy.js';

export { signalsFor } from './policy/signals.js';

export { quoteCandidates } from './policy/quote.js';
export type { QuoteUsage, CandidateQuote, CandidatePlan } from './policy/quote.js';

export { DEFAULT_RETRY_POLICY } from './execute/run.js';
export type {
  RetryPolicy,
  GenerateRequest,
  GenerateResult,
  StreamRequest,
  RequestPolicy,
  ProviderOptions,
  ToolActivity,
  CallPlan,
} from './execute/run.js';

export type {
  EmbedRequest,
  EmbedResult,
  EmbedAccounting,
  EmbedPolicyInput,
} from './execute/embed.js';

/** For authors of provider adapters, so their failures classify like ours. */
export { classifyError, kindFromStatus } from './execute/classify.js';
export type { ClassifyContext } from './execute/classify.js';

export type {
  SttPolicyInput,
  SttAccounting,
  SttPlanUsage,
  TranscribeRequest,
  TranscribeResult,
  StreamTranscribeRequest,
} from './stt/run.js';

export type {
  AudioChunk,
  AudioSource,
  SttProviderFactory,
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

export { countCharacters } from './translate/run.js';
export type {
  MtPolicyInput,
  MtAccounting,
  TranslateRequest,
  TranslateResult,
} from './translate/run.js';

export type {
  TranslationFormat,
  TranslationProviderFactory,
  TranslationResult,
} from './translate/types.js';

export { buildPrompt, wrapUntrusted, escapeUntrusted } from './prompt/untrusted.js';
export type { BuildPromptInput, BuiltPrompt, UntrustedBlock } from './prompt/untrusted.js';

export { parseModelInput, formatModelRef } from './utils/model-ref.js';
export type { ModelRef, ParsedModelInput } from './utils/model-ref.js';

export { chunkText } from './utils/chunk-text.js';

export { compactHistory } from './chat/compaction.js';
export type { CompactableMessage, CompactionInput, CompactionResult } from './chat/compaction.js';
