/**
 * Everything the library needs from the outside world.
 *
 * The package implements none of it, because every one of these is a decision
 * the host application has already made: where secrets come from, where usage
 * is written, what observability looks like, and which process owns shared
 * state. A library that decides those for its host is a framework, and gets
 * worked around instead of used.
 *
 * All of them are optional at the call site — a no-op or in-memory default
 * stands in — with one exception: keys, because there is no sensible default
 * for a credential.
 */

/** Where provider credentials come from. */
export interface KeyProvider {
  /**
   * @param provider Provider id from the catalog, e.g. 'google' or 'openrouter'.
   * @throws If the deployment has no key for that provider.
   */
  get(provider: string): Promise<string>;
}

/**
 * Where a finished call is recorded.
 *
 * The library computes the cost and hands it over; it never stores anything.
 * Whether that becomes a row, a metric or nothing at all is not its business.
 */
export interface UsageSink {
  record(event: UsageEvent): Promise<void>;
}

/** Where traces go. No-op by default, so the library works without any. */
export interface TraceSink {
  generation(trace: GenerationTrace): void;
  span(trace: SpanTrace): void;
}

/**
 * Shared state for the parts that must agree across processes.
 *
 * Circuit breaker and rate limiter live here rather than in a `Map`, because a
 * `Map` is per-instance: with two API processes behind a balancer, a model
 * banned by one is happily used by the other. The port is declared now even
 * though its users arrive later, so that adding them does not change the
 * public API.
 */
export interface StateStore {
  incr(key: string, ttlSec: number): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  /** Atomic compare-and-set, for circuit breaker state transitions. */
  compareAndSet(
    key: string,
    expected: string | null,
    next: string,
    ttlSec: number,
  ): Promise<boolean>;
}

/** Injectable time, so that retry and cooldown logic is testable. */
export interface Clock {
  now(): number;
}

/** How the model that answered was arrived at. */
export type RoutedBy = 'auto' | 'user' | 'fallback' | 'escalation';

/** How a call ended. */
export type CallStatus = 'ok' | 'error' | 'aborted' | 'filtered';

/** Token counts as reported by the provider, normalised. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Part of `inputTokens` served from the provider's prompt cache. */
  cachedInputTokens: number;
  /** Thinking tokens, billed as output by every provider that has them. */
  reasoningTokens: number;
}

/**
 * One model call, priced.
 *
 * Everything a consumer needs to bill, attribute and audit the call. In
 * particular `priceVersion`: without it a price change makes the recorded
 * history impossible to recompute, and that is discovered a year too late.
 */
export interface UsageEvent {
  provider: string;
  model: string;
  routedBy: RoutedBy;
  usage: TokenUsage;
  /** What the call cost us, in micro-units of the currency. 1_000_000 = 1 USD. */
  costMicros: number;
  priceVersion: string;
  status: CallStatus;
  latencyMs: number;
  /** How many provider requests it took, including retries and fallbacks. */
  attempts: number;
  traceId?: string;
}

/** One model generation, for the observability backend. */
export interface GenerationTrace {
  traceId?: string;
  name: string;
  provider: string;
  model: string;
  startedAt: number;
  endedAt: number;
  usage?: TokenUsage;
  costMicros?: number;
  status: CallStatus;
  error?: string;
  metadata?: Record<string, unknown>;
}

/** One non-generation step worth seeing in a trace: a tool call, a retry. */
export interface SpanTrace {
  traceId?: string;
  name: string;
  startedAt: number;
  endedAt: number;
  metadata?: Record<string, unknown>;
}

/** Discards everything. The default, so observability stays optional. */
export const noopTraceSink: TraceSink = {
  generation: () => undefined,
  span: () => undefined,
};

/** Discards everything. The default, so usage accounting stays optional. */
export const noopUsageSink: UsageSink = {
  record: () => Promise.resolve(),
};

export const systemClock: Clock = {
  now: () => Date.now(),
};
