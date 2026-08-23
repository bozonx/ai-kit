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
  taskClassSchema,
  catalogSchema,
  modelSchema,
  pricingSchema,
  capabilitiesSchema,
  modelTierSchema,
  modalitySchema,
} from './catalog/schema.js';

export type {
  TaskClass,
  ModelTier,
  Modality,
  ModelPricing,
  ModelCapabilities,
  ModelDefinition,
  CatalogData,
} from './catalog/schema.js';

export { calculateCost, estimateCost, estimateTokens } from './catalog/pricing.js';
export type { CostBreakdown, FlatUsage } from './catalog/pricing.js';

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

export { parseModelInput, formatModelRef } from './utils/model-ref.js';
export type { ModelRef, ParsedModelInput } from './utils/model-ref.js';
