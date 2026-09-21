import {
  APICallError,
  InvalidPromptError,
  LoadAPIKeyError,
  NoObjectGeneratedError,
  TypeValidationError,
} from 'ai';

import { AiError, type AiErrorKind } from '../errors.js';

/**
 * Turning whatever a provider threw into a decision.
 *
 * Every provider fails in its own vocabulary and the SDK normalises only part
 * of it, so this is where "429 with a body that says quota" and "socket hung
 * up" become the same two facts the rest of the code needs: is another attempt
 * worth making, and what does the person on the other end get told.
 */

const CONNECTION_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);

/**
 * An HTTP status, in the vocabulary the retry loop reads.
 *
 * Shared with the speech adapters, which talk plain HTTP rather than going
 * through the AI SDK. It used to be written twice, and the two copies had
 * already drifted — one of them knew that 404 and 422 mean a bad request and
 * the other did not, so the same mistake was retried three times against one
 * kind of provider and refused immediately by another.
 */
export function kindFromStatus(status: number, message = ''): AiErrorKind {
  if (status === 429) return 'rate_limit';
  if (status === 401 || status === 403) return 'auth';
  if (status >= 500) return 'provider_unavailable';
  if (status === 408 || status === 409) return 'provider_unavailable';
  if (status === 404 || status === 422) return 'invalid_request';
  if (status === 400) {
    const text = message.toLowerCase();
    if (text.includes('context') && text.includes('length')) return 'context_length';
    if (text.includes('too long') || text.includes('maximum context')) return 'context_length';
    if (text.includes('safety') || text.includes('blocked') || text.includes('content filter')) {
      return 'content_filter';
    }
    return 'invalid_request';
  }
  return 'unknown';
}

function isAbort(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: string }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function errorCode(error: unknown): string | undefined {
  const cause = (error as { cause?: unknown })?.cause;
  const code =
    (error as { code?: unknown }).code ?? (cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

export interface ClassifyContext {
  provider?: string;
  model?: string;
  /** True when the caller's own signal fired, which makes an abort deliberate. */
  callerAborted?: boolean;
}

/**
 * Classifies a thrown value.
 *
 * An `AiError` passes through untouched — something closer to the failure has
 * already decided, and second-guessing it here is how a deliberate abort turns
 * into a retry.
 */
export function classifyError(error: unknown, context: ClassifyContext = {}): AiError {
  if (error instanceof AiError) return error;

  const options = { provider: context.provider, model: context.model, cause: error };
  const message = error instanceof Error ? error.message : String(error);

  if (isAbort(error)) {
    return context.callerAborted
      ? new AiError('aborted', 'The call was aborted', options)
      : new AiError('timeout', 'The call ran out of its time budget', options);
  }

  if (LoadAPIKeyError.isInstance(error)) {
    return new AiError('auth', message, options);
  }

  if (NoObjectGeneratedError.isInstance(error) || TypeValidationError.isInstance(error)) {
    return new AiError('invalid_output', 'The model produced output the schema rejects', options);
  }

  if (InvalidPromptError.isInstance(error)) {
    return new AiError('invalid_request', message, options);
  }

  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    const kind =
      status === undefined
        ? error.isRetryable
          ? 'provider_unavailable'
          : 'unknown'
        : kindFromStatus(status, `${message} ${String(error.responseBody ?? '')}`);
    return new AiError(kind, message, { ...options, status, provider: context.provider });
  }

  const code = errorCode(error);
  if (code && CONNECTION_CODES.has(code)) {
    return new AiError('provider_unavailable', message, options);
  }

  return new AiError('unknown', message, options);
}
