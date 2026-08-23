import type { Catalog } from './catalog/catalog.js';
import {
  DEFAULT_RETRY_POLICY,
  runGenerate,
  runStream,
  type ExecutionDeps,
  type GenerateRequest,
  type GenerateResult,
  type RetryPolicy,
  type StreamRequest,
} from './execute/run.js';
import {
  noopTraceSink,
  noopUsageSink,
  systemClock,
  type Clock,
  type KeyProvider,
  type StateStore,
  type TraceSink,
  type UsageSink,
} from './ports.js';
import { MemoryStateStore } from './state/memory-state-store.js';
import { ProviderRegistry, type ProviderFactory } from './providers/registry.js';
import type { StreamPart } from './stream/stream-parts.js';

/**
 * The package, assembled.
 *
 * Everything except the catalog and the credentials is optional, and that is a
 * design constraint rather than a convenience: a library that cannot be called
 * until five ports are implemented gets worked around instead of used. The
 * defaults are honest about being defaults — usage goes nowhere, traces go
 * nowhere, and shared state is per-process.
 */
export interface AiKitOptions {
  catalog: Catalog;
  keys: KeyProvider;
  /** Defaults to `MemoryStateStore`, which is wrong for more than one process. */
  state?: StateStore;
  usage?: UsageSink;
  trace?: TraceSink;
  clock?: Clock;
  retry?: Partial<RetryPolicy>;
  /** Adapters for providers the package does not ship, or replacements. */
  providers?: Record<string, ProviderFactory>;
}

export interface AiKit {
  readonly catalog: Catalog;
  readonly state: StateStore;
  /** One answer; pass a schema for structured output. */
  generate<T = never>(request: GenerateRequest<T>): Promise<GenerateResult<T>>;
  /** The same call, part by part. */
  stream(request: StreamRequest): AsyncIterable<StreamPart>;
}

export function createAiKit(options: AiKitOptions): AiKit {
  const state = options.state ?? new MemoryStateStore(options.clock ?? systemClock);

  const deps: ExecutionDeps = {
    catalog: options.catalog,
    registry: new ProviderRegistry({ keys: options.keys, factories: options.providers }),
    usage: options.usage ?? noopUsageSink,
    trace: options.trace ?? noopTraceSink,
    clock: options.clock ?? systemClock,
    retry: { ...DEFAULT_RETRY_POLICY, ...options.retry },
  };

  return {
    catalog: options.catalog,
    state,
    generate: request => runGenerate(deps, request),
    stream: request => runStream(deps, request),
  };
}
