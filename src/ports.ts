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

/**
 * How the library reaches the network.
 *
 * A port because "the network" is not the same thing everywhere the package
 * runs. A browser page is stopped by CORS, a Tauri webview has to go through
 * its HTTP plugin, a server may want a proxy or a recording fetch in tests —
 * and the standard WebSocket has nowhere to put the header every speech
 * provider authenticates a live session with. The defaults are the platform's
 * own `fetch` and `WebSocket`; everything else is a host's decision.
 */
export interface Transport {
  /** Every HTTP request: language models through the AI SDK, speech, translation. */
  fetch: FetchFunction;
  /** Live speech sessions. */
  openSocket: SocketOpener;
}

/** The standard `fetch` signature, which is what every implementation offers. */
export type FetchFunction = typeof globalThis.fetch;

/**
 * Opens a WebSocket and resolves once it is open.
 *
 * The contract an implementation has to keep, and nothing more: reject when
 * the socket cannot be opened, end `messages` when the server closes normally
 * (1000 or 1005), throw from it when the session was cut short, and close the
 * socket when `signal` aborts. `connectSignal`, when supplied, only limits the
 * handshake and must be detached once the socket opens. The library turns every failure into an
 * `AiError` with the provider named, so an implementation throws plain errors.
 */
export type SocketOpener = (url: string, options: OpenSocketOptions) => Promise<SocketSession>;

export interface OpenSocketOptions {
  /** Request headers for the handshake. Most speech providers authenticate here. */
  headers?: Record<string, string>;
  protocols?: string[];
  /** Optional handshake-only deadline. It must not close an established session. */
  connectSignal?: AbortSignal;
  /** Cancellation for the established session's whole lifetime. */
  signal: AbortSignal;
}

/** A WebSocket in the shape the streaming adapters want. */
export interface SocketSession {
  /** Text frames, in arrival order. Ends when the socket closes. */
  messages: AsyncIterable<string>;
  send(data: Uint8Array | string): void;
  /**
   * Without a payload, closes the socket now. With one — a provider's "end of
   * stream" message — sends it and leaves the closing to the server, which
   * flushes the words it still owes first; a server that never closes is cut
   * off after a grace period. Safe to call more than once.
   */
  close(payload?: string): void;
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
 * What a finished language-model call cost and who produced it.
 *
 * Declared here rather than next to the executor so that the stream vocabulary
 * can carry it: a browser importing `@bozonx/ai-kit/stream` must not have to
 * resolve the AI SDK's types to read a usage part.
 */
export interface CallAccounting {
  provider: string;
  model: string;
  /** The consumer's own id for the route that answered, when it gave one. */
  routeId?: string;
  routedBy: RoutedBy;
  usage: TokenUsage;
  costMicros: number;
  priceVersion: string;
  /**
   * False when the route that answered has no price, which only a catalog
   * with `requirePricing: false` allows. `costMicros` is then zero because
   * nobody knows the cost, not because the call was free.
   */
  priced: boolean;
  /** Provider requests made, retries and fallbacks included. */
  attempts: number;
  latencyMs: number;
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
  /** False when the route has no price; see `CallAccounting.priced`. */
  priced: boolean;
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
