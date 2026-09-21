/**
 * Error classification.
 *
 * This is the basis of both the retry rules and the message the user ends up
 * reading, which is why it lives in the library: every product gets it subtly
 * wrong in its own way, and the cost of getting it wrong is either a retry
 * storm against a provider that is already refusing, or a dead end shown to
 * someone who only needed to wait two seconds.
 */

/**
 * Why a call failed, in terms that decide what happens next.
 *
 * `retryable` is the whole point of the taxonomy: a rate limit is worth another
 * attempt, a content filter never is, and a context overflow is a bug in the
 * caller that retrying only makes slower.
 */
export type AiErrorKind =
  /** 429 and provider-specific quota refusals. Retryable. */
  | 'rate_limit'
  /** 5xx, connection reset, DNS. Retryable. */
  | 'provider_unavailable'
  /** The call ran out of its time budget. Retryable only before the first token. */
  | 'timeout'
  /** Caller aborted. Never retried — somebody asked for it to stop. */
  | 'aborted'
  /** 401/403. Retrying with the same key produces the same answer. */
  | 'auth'
  /** 400 and schema violations. The request is wrong, not unlucky. */
  | 'invalid_request'
  /** Prompt plus expected output exceeds the model's window. */
  | 'context_length'
  /** Provider refused on safety grounds. */
  | 'content_filter'
  /** The model produced something the schema rejects. Escalate, do not repeat. */
  | 'invalid_output'
  /** The stream died after output had already been shown. */
  | 'stream_interrupted'
  /** Every candidate has been tried. */
  | 'no_candidates'
  /** Anything not yet understood. Treated as non-retryable on purpose. */
  | 'unknown';

const RETRYABLE: ReadonlySet<AiErrorKind> = new Set<AiErrorKind>([
  'rate_limit',
  'provider_unavailable',
  'timeout',
]);

/**
 * Failures that say something about the provider rather than the request.
 *
 * What a route's health automation should count. A bad request, a filtered
 * answer or a context overflow would fail at any route, and holding one against
 * the route it happened on demotes a healthy provider. `unknown` counts: an
 * error nobody has classified yet is more often the provider's than ours.
 */
const PROVIDER_FAULTS: ReadonlySet<AiErrorKind> = new Set<AiErrorKind>([
  'rate_limit',
  'provider_unavailable',
  'timeout',
  'unknown',
]);

export function isProviderFault(kind: AiErrorKind): boolean {
  return PROVIDER_FAULTS.has(kind);
}

export interface AiErrorOptions {
  provider?: string;
  model?: string;
  /** HTTP status, when the failure came from an HTTP call. */
  status?: number;
  cause?: unknown;
}

/** Every failure the library raises. */
export class AiError extends Error {
  public readonly kind: AiErrorKind;
  public readonly provider?: string;
  public readonly model?: string;
  public readonly status?: number;

  constructor(kind: AiErrorKind, message: string, options: AiErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'AiError';
    this.kind = kind;
    this.provider = options.provider;
    this.model = options.model;
    this.status = options.status;
  }

  /**
   * Whether another attempt could plausibly succeed.
   *
   * Says nothing about whether one is allowed: after the first token has
   * reached the user, nothing is retried regardless of what this returns,
   * because the alternative is a second answer overwriting a half-read first.
   */
  public get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}

/**
 * The stream stopped with output already delivered.
 *
 * Carries the partial text so the caller can save it: the user has read it,
 * so pretending it never happened is a worse lie than an interrupted answer.
 */
export class StreamInterruptedError extends AiError {
  public readonly partialText: string;

  constructor(partialText: string, options: AiErrorOptions = {}) {
    super('stream_interrupted', 'The model stream ended before it finished', options);
    this.name = 'StreamInterruptedError';
    this.partialText = partialText;
  }
}

/** One candidate that did not answer, and why. */
export interface CandidateFailure {
  provider: string;
  model: string;
  /** The consumer's own id for the route that failed, when it gave one. */
  routeId?: string;
  error: AiError;
}

/** Every candidate failed. Keeps each failure, because the last one rarely explains. */
export class AllCandidatesFailedError extends AiError {
  public readonly failures: readonly CandidateFailure[];

  constructor(failures: readonly CandidateFailure[]) {
    super('no_candidates', `All ${failures.length} candidate models failed`);
    this.name = 'AllCandidatesFailedError';
    this.failures = failures;
  }
}

/** The catalog holds nothing that satisfies the request. */
export class NoSuitableModelError extends AiError {
  constructor(message = 'No model in the catalog satisfies the request') {
    super('no_candidates', message);
    this.name = 'NoSuitableModelError';
  }
}

/** Not a failure of the library — a failure to configure it. */
export class CatalogError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'CatalogError';
  }
}

export function isAiError(error: unknown): error is AiError {
  return error instanceof AiError;
}

/**
 * How a call that failed this way is recorded.
 *
 * One mapping, because every consumer of a stream ends up writing it next to
 * its usage row, and a content filter written down as an ordinary error is a
 * spike on the error graph that nobody can do anything about.
 */
export function callStatusFor(kind: AiErrorKind): 'error' | 'aborted' | 'filtered' {
  if (kind === 'aborted') return 'aborted';
  if (kind === 'content_filter') return 'filtered';
  return 'error';
}
