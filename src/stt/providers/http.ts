import { AiError } from '../../errors.js';
import { kindFromStatus } from '../../execute/classify.js';
import type { FetchFunction } from '../../ports.js';
import { platformFetch } from '../../transport/platform.js';
import type { TranscriptSegment, WordTiming } from '../types.js';
import type { z } from 'zod';

/**
 * The little that every speech adapter needs and the AI SDK does not provide.
 *
 * Speech providers are not language models, so none of them is reachable
 * through the SDK: these are plain HTTP and WebSocket APIs, and the shared part
 * is small on purpose — status classification, waiting, and turning words into
 * segments.
 */

export { kindFromStatus } from '../../execute/classify.js';

export interface HttpContext {
  provider: string;
  model: string;
}

/** A request whose failures are already in the vocabulary the retry loop reads. */
export type JsonRequest = <T>(url: string, init: RequestInit, context: HttpContext) => Promise<T>;

/** `JsonRequest` over the host's `fetch`, or the platform's when it supplied none. */
export function jsonRequester(send: FetchFunction = platformFetch): JsonRequest {
  return (url, init, context) => requestJson(send, url, init, context);
}

/** Refuses a successful HTTP response whose wire shape cannot be trusted. */
export function parseProviderResponse<T>(
  schema: z.ZodType<T>,
  value: unknown,
  context: HttpContext,
): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new AiError('provider_unavailable', `${context.provider} returned an invalid response`, {
    ...context,
    cause: parsed.error,
  });
}

async function requestJson<T>(
  send: FetchFunction,
  url: string,
  init: RequestInit,
  context: HttpContext,
): Promise<T> {
  let response: Response;
  try {
    response = await send(url, init);
  } catch (cause) {
    if (isAbort(cause)) throw cause;
    throw new AiError('provider_unavailable', `${context.provider} is unreachable`, {
      ...context,
      cause,
    });
  }

  if (!response.ok) {
    const body = await limitedResponseText(response, 64 * 1024);
    throw new AiError(
      kindFromStatus(response.status, body),
      `${context.provider} returned HTTP ${response.status}`,
      { ...context, status: response.status },
    );
  }

  const body = await response.text();

  try {
    return JSON.parse(body) as T;
  } catch (cause) {
    throw new AiError('unknown', `${context.provider} returned a body that is not JSON`, {
      ...context,
      cause,
    });
  }
}

async function limitedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return response.text();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = maxBytes - total;
    if (remaining <= 0) {
      await reader.cancel();
      break;
    }
    const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
    text += decoder.decode(slice, { stream: true });
    total += slice.byteLength;
    if (value.byteLength > remaining) {
      await reader.cancel();
      break;
    }
  }
  return text + decoder.decode();
}

function isAbort(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AiError('aborted', 'The call was aborted'));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AiError('aborted', 'The call was aborted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Groups words into segments when a provider returns no utterances of its own.
 *
 * Breaks on sentence-ending punctuation and on a pause long enough to be one,
 * with a ceiling on length so that a monologue without punctuation still yields
 * something a player can seek to. Rough by design: the readable version of a
 * transcript is produced by a language model afterwards, not here.
 */
const SEGMENT_PAUSE_MS = 800;
const SEGMENT_MAX_MS = 30_000;

export function segmentsFromWords(words: readonly WordTiming[]): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let current: WordTiming[] = [];

  const flush = (): void => {
    const first = current[0];
    const last = current[current.length - 1];
    if (!first || !last) return;
    segments.push({
      index: segments.length,
      startMs: first.startMs,
      endMs: last.endMs,
      text: current
        .map(word => word.text)
        .join(' ')
        .replace(/\s+([,.!?;:])/g, '$1')
        .trim(),
    });
    current = [];
  };

  for (const word of words) {
    const previous = current[current.length - 1];
    const first = current[0];
    if (
      previous &&
      first &&
      (/[.!?]["')\]]?$/.test(previous.text) ||
        word.startMs - previous.endMs >= SEGMENT_PAUSE_MS ||
        word.endMs - first.startMs >= SEGMENT_MAX_MS)
    ) {
      flush();
    }
    current.push(word);
  }
  flush();

  return segments;
}
