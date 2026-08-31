/**
 * `@bozonx/ai-kit` — the part of an AI feature that is the same in every product.
 *
 * What lives here is everything a second product would otherwise rewrite from
 * memory: a priced model catalog, the rules for choosing a model and retrying a
 * call, the wire vocabulary of a streamed answer, error classification, and the
 * ports through which a host supplies keys, state and observability.
 *
 * What deliberately does not live here is anything that knows about tenants,
 * users, projects or a database. If a component needs one of those words, it
 * has been put in the wrong repository.
 */

export { Catalog } from './catalog/catalog.js';

export {
  TASK_CLASSES,
  STT_TASK_CLASSES,
  kindOfTaskClass,
  taskClassSchema,
  modelKindSchema,
  sttPricingSchema,
  sttCapabilitiesSchema,
  catalogSchema,
  modelSchema,
  pricingSchema,
  capabilitiesSchema,
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
  SttPricing,
  SttCapabilities,
  ModelDefinition,
  CatalogData,
} from './catalog/schema.js';

export {
  calculateCost,
  estimateCost,
  estimateTokens,
  calculateSttCost,
  estimateSttCost,
} from './catalog/pricing.js';
export type { CostBreakdown, FlatUsage, SttUsage, SttCostBreakdown } from './catalog/pricing.js';

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
  StateStore,
  Clock,
  RoutedBy,
  CallStatus,
  TokenUsage,
  UsageEvent,
  GenerationTrace,
  SpanTrace,
} from './ports.js';

export { MemoryStateStore } from './state/memory-state-store.js';

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

export { classifyError } from './execute/classify.js';
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
export { buildPrompt, wrapUntrusted, escapeUntrusted } from './prompt/untrusted.js';
export type { BuildPromptInput, BuiltPrompt, UntrustedBlock } from './prompt/untrusted.js';

export { parseModelInput, formatModelRef } from './utils/model-ref.js';
export type { ModelRef, ParsedModelInput } from './utils/model-ref.js';
