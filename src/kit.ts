import type { Catalog } from './catalog/catalog.js';
import {
  DEFAULT_RETRY_POLICY,
  planCall,
  runGenerate,
  type CallPlan,
  runStream,
  type ExecutionDeps,
  type GenerateRequest,
  type GenerateResult,
  type RetryPolicy,
  type StreamRequest,
} from './execute/run.js';
import {
  noopAttemptObserver,
  noopTraceSink,
  noopUsageSink,
  systemClock,
  type AttemptObserver,
  type Clock,
  type KeyProvider,
  type TraceSink,
  type UsageSink,
} from './ports.js';
import { runEmbed, type EmbedRequest, type EmbedResult } from './execute/embed.js';
import {
  ProviderRegistry,
  type EmbeddingProviderFactory,
  type ProviderFactory,
} from './providers/registry.js';
import type { StreamPart } from './stream/stream-parts.js';
import type { CandidatePlan } from './policy/quote.js';
import { SttProviderRegistry } from './stt/registry.js';
import {
  planTranscribe,
  runTranscribe,
  runTranscribeStream,
  type SttExecutionDeps,
  type SttPlanUsage,
  type StreamTranscribeRequest,
  type TranscribeRequest,
  type TranscribeResult,
} from './stt/run.js';
import type { SttProviderFactory, TranscriptPart } from './stt/types.js';
import { MtProviderRegistry } from './translate/registry.js';
import {
  planTranslate,
  runTranslate,
  type MtExecutionDeps,
  type TranslateRequest,
  type TranslateResult,
} from './translate/run.js';
import type { TranslationProviderFactory } from './translate/types.js';

/**
 * The package, assembled.
 *
 * Everything except the catalog and the credentials is optional, and that is a
 * design constraint rather than a convenience: a library that cannot be called
 * until five ports are implemented gets worked around instead of used. The
 * defaults are honest about being defaults — usage goes nowhere and traces go
 * nowhere.
 */
export interface AiKitOptions {
  catalog: Catalog;
  keys: KeyProvider;
  usage?: UsageSink;
  trace?: TraceSink;
  /** Told about every candidate that failed, including ones a fallback covered. */
  attempts?: AttemptObserver;
  clock?: Clock;
  retry?: Partial<RetryPolicy>;
  /** Adapters for providers the package does not ship, or replacements. */
  providers?: Record<string, ProviderFactory>;
  /** The same, for embedding models. */
  embeddingProviders?: Record<string, EmbeddingProviderFactory>;
  /** The same, for speech. A separate map because they are separate clients. */
  sttProviders?: Record<string, SttProviderFactory>;
  /** And for dedicated translation engines. */
  mtProviders?: Record<string, TranslationProviderFactory>;
}

/**
 * Every method accepts `keys` on the request: credentials for that call only,
 * applied over the kit's `KeyProvider`. That is how a customer's own key is
 * used without building a kit per customer.
 */
export interface AiKit {
  readonly catalog: Catalog;
  /**
   * The candidates a request would try and what each could cost, without
   * calling any. Pass the result back as `plan` on the same request.
   *
   * @throws NoSuitableModelError when nothing in the catalog fits.
   */
  plan<T = never>(request: GenerateRequest<T>, options?: { stream?: boolean }): CallPlan;
  /** One answer; pass a schema for structured output. */
  generate<T = never>(request: GenerateRequest<T>): Promise<GenerateResult<T>>;
  /** The same call, part by part. */
  stream(request: StreamRequest): AsyncIterable<StreamPart>;
  /**
   * The speech models a transcription would try and what each could cost,
   * without calling any. Pass the result back as `plan` on the same request.
   *
   * @throws NoSuitableModelError when nothing in the catalog fits.
   */
  planTranscription(
    request: TranscribeRequest | StreamTranscribeRequest,
    usage: SttPlanUsage,
  ): CandidatePlan;
  /** One recording, one transcript. */
  transcribe(request: TranscribeRequest): Promise<TranscribeResult>;
  /** Live dictation: drafts while somebody speaks, settled text behind them. */
  transcribeStream(request: StreamTranscribeRequest): AsyncIterable<TranscriptPart>;
  /**
   * The engines a translation would try and what each would charge, without
   * calling any. Pass the result back as `plan` on the same request.
   *
   * @throws NoSuitableModelError when nothing in the catalog fits.
   */
  planTranslation(request: TranslateRequest): CandidatePlan;
  /** One batch of strings through a dedicated translation engine. */
  translate(request: TranslateRequest): Promise<TranslateResult>;
  /** One batch of strings, one vector each. */
  embed(request: EmbedRequest): Promise<EmbedResult>;
}

export function createAiKit(options: AiKitOptions): AiKit {
  const usage = options.usage ?? noopUsageSink;
  const trace = options.trace ?? noopTraceSink;
  const clock = options.clock ?? systemClock;
  const attempts = options.attempts ?? noopAttemptObserver;
  const retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };

  const deps: ExecutionDeps = {
    catalog: options.catalog,
    registry: new ProviderRegistry({
      keys: options.keys,
      factories: options.providers,
      embeddingFactories: options.embeddingProviders,
    }),
    usage,
    trace,
    attempts,
    clock,
    retry,
  };

  const sttDeps: SttExecutionDeps = {
    catalog: options.catalog,
    registry: new SttProviderRegistry({ keys: options.keys, factories: options.sttProviders }),
    usage,
    trace,
    attempts,
    clock,
    retry,
  };

  const mtDeps: MtExecutionDeps = {
    catalog: options.catalog,
    registry: new MtProviderRegistry({ keys: options.keys, factories: options.mtProviders }),
    usage,
    trace,
    attempts,
    clock,
    retry,
  };

  return {
    catalog: options.catalog,
    plan: (request, planOptions) =>
      planCall(options.catalog, request as GenerateRequest<unknown>, planOptions),
    generate: request => runGenerate(deps, request),
    stream: request => runStream(deps, request),
    planTranscription: (request, usage) => planTranscribe(options.catalog, request, usage),
    transcribe: request => runTranscribe(sttDeps, request),
    transcribeStream: request => runTranscribeStream(sttDeps, request),
    planTranslation: request => planTranslate(options.catalog, request),
    translate: request => runTranslate(mtDeps, request),
    embed: request => runEmbed(deps, request),
  };
}
