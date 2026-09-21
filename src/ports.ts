import type { AiErrorKind } from './errors.js';

/**
 * Everything the library needs from the outside world.
 *
 * The package implements none of it, because every one of these is a decision
 * the host application has already made: where secrets come from, where usage
 * is written, and what observability looks like. A library that decides those for its host is a framework, and gets
 * worked around instead of used.
 *
 * All of them are optional at the call site — a no-op default stands in —
 * with one exception: keys, because there is no sensible default
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
 * Told about every candidate that failed, including the ones a fallback then
 * covered for.
 *
 * The result of a call names only the route that answered, and a failure
 * nobody can attribute is a failure nobody's health automation can act on —
 * which is most of them, because a route that fails before the first token is
 * exactly the one the next candidate quietly replaces.
 */
export interface AttemptObserver {
  failed(failure: AttemptFailure): void;
}

export interface AttemptFailure {
  traceId?: string;
  /** The call's `name`, e.g. the consumer's feature. */
  name: string;
  provider: string;
  model: string;
  /** The consumer's own id for the route that failed, when it gave one. */
  routeId?: string;
  kind: AiErrorKind;
  message: string;
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
  /**
   * Seconds of audio the call transcribed. Zero for everything else.
   *
   * Speech is billed by the second, text by the token and a dedicated
   * translation engine by the character, and a consumer that has to report on
   * all three needs each in its own column — deriving one from a cost is how a
   * price change rewrites history.
   */
  audioSeconds: number;
  /** Characters a translation engine was handed. Zero for everything else. */
  characters: number;
  /** The route that answered, by the consumer's own id, when it gave one. */
  routeId?: string;
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

/** Ignores every failure. The default. */
export const noopAttemptObserver: AttemptObserver = {
  failed: () => undefined,
};

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
