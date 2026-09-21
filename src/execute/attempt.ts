import { AiError, AllCandidatesFailedError } from '../errors.js';
import type { ModelCandidate } from '../policy/policy.js';
import type { Clock, TraceSink } from '../ports.js';
import { classifyError } from './classify.js';

/**
 * Walking the candidate list: try, retry, fall back, give up.
 *
 * Split out from the callers because speech and text differ in what they send
 * and what they get back, and not at all in how hard they should try. Two
 * copies of a retry loop drift, and the drift is invisible until one of them
 * is quietly retrying a call that has already shown output to somebody.
 */

/** How hard to try. Defaults are the ones a chat wants; batch work may differ. */
export interface RetryPolicy {
  /** Extra attempts on the same model after the first one fails. */
  maxRetriesPerCandidate: number;
  initialDelayMs: number;
  maxDelayMs: number;
  /** Ceiling for the whole call, retries and fallbacks included. */
  totalTimeoutMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetriesPerCandidate: 2,
  initialDelayMs: 500,
  maxDelayMs: 4_000,
  totalTimeoutMs: 120_000,
};

/** What the loop needs from the request, whatever else the request carries. */
export interface AttemptRequest {
  abortSignal?: AbortSignal;
  /** Overrides `RetryPolicy.totalTimeoutMs` for this call. */
  totalTimeoutMs?: number;
  traceId?: string;
  name?: string;
}

export interface AttemptDeps {
  trace: TraceSink;
  clock: Clock;
  retry: RetryPolicy;
}

export interface AttemptOutcome<R> {
  value: R;
  candidate: ModelCandidate;
  attempts: number;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AiError('aborted', 'The call was aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AiError('aborted', 'The call was aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Exponential backoff with jitter, so retries from many callers do not line up. */
function backoffMs(attempt: number, retry: RetryPolicy): number {
  const base = Math.min(retry.initialDelayMs * 2 ** attempt, retry.maxDelayMs);
  return Math.round(base / 2 + Math.random() * (base / 2));
}

/**
 * A signal that fires on the caller's abort or when the call's time is up.
 *
 * The remaining budget shrinks with every attempt, which is the point: the
 * deadline is a property of the request, not of the try.
 */
function attemptSignal(deadline: number, clock: Clock, caller?: AbortSignal): AbortSignal {
  const remaining = Math.max(1, deadline - clock.now());
  const timeout = AbortSignal.timeout(remaining);
  return caller ? AbortSignal.any([caller, timeout]) : timeout;
}

/**
 * Walks the candidate list, retrying each one under the rules of 7.4.
 *
 * A caller that has already shown output opts out of retrying by not coming
 * back here: everything past the first visible part belongs to the model that
 * produced it, and a second answer overwriting a half-read first is worse than
 * an interrupted one.
 *
 * `prepare` builds the client for a candidate. It is inside the attempt on
 * purpose: a provider with no key configured is that provider's failure, not
 * the whole call's, and the next candidate deserves its turn.
 */
export async function attemptCandidates<C, R>(
  deps: AttemptDeps,
  candidates: ModelCandidate[],
  request: AttemptRequest,
  steps: {
    prepare: (candidate: ModelCandidate) => Promise<C>;
    run: (params: { client: C; candidate: ModelCandidate; signal: AbortSignal }) => Promise<R>;
  },
): Promise<AttemptOutcome<R>> {
  const retry = {
    ...deps.retry,
    totalTimeoutMs: request.totalTimeoutMs ?? deps.retry.totalTimeoutMs,
  };
  const deadline = deps.clock.now() + retry.totalTimeoutMs;
  const failures: Array<{ provider: string; model: string; error: AiError }> = [];
  let attempts = 0;

  for (const candidate of candidates) {
    for (let tryIndex = 0; tryIndex <= retry.maxRetriesPerCandidate; tryIndex += 1) {
      if (request.abortSignal?.aborted) {
        throw new AiError('aborted', 'The call was aborted');
      }
      if (deps.clock.now() >= deadline) {
        throw new AiError('timeout', 'The call ran out of its time budget');
      }

      attempts += 1;
      try {
        const client = await steps.prepare(candidate);
        const value = await steps.run({
          client,
          candidate,
          signal: attemptSignal(deadline, deps.clock, request.abortSignal),
        });
        return { value, candidate, attempts };
      } catch (error) {
        const classified = classifyError(error, {
          provider: candidate.route.provider,
          model: candidate.model.name,
          callerAborted: request.abortSignal?.aborted,
        });

        if (classified.kind === 'aborted' || classified.kind === 'stream_interrupted') {
          throw classified;
        }

        failures.push({
          provider: candidate.route.provider,
          model: candidate.model.name,
          error: classified,
        });

        deps.trace.span({
          traceId: request.traceId,
          name: `${request.name ?? 'generate'}.attempt-failed`,
          startedAt: deps.clock.now(),
          endedAt: deps.clock.now(),
          metadata: {
            provider: candidate.route.provider,
            model: candidate.model.name,
            kind: classified.kind,
          },
        });

        const canRetrySameModel = classified.retryable && tryIndex < retry.maxRetriesPerCandidate;
        if (!canRetrySameModel) break;

        const wait = backoffMs(tryIndex, retry);
        if (deps.clock.now() + wait >= deadline) break;
        await sleep(wait, request.abortSignal);
      }
    }
  }

  // A single non-retryable failure explains itself better than a list of one.
  const only = failures.length === 1 ? failures[0] : undefined;
  if (only) throw only.error;
  throw new AllCandidatesFailedError(failures);
}
