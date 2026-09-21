import { UNPRICED } from '../catalog/pricing.js';
import { callStatusFor, type AiError } from '../errors.js';
import type { ModelCandidate } from '../policy/policy.js';
import type {
  Clock,
  GenerationTrace,
  TokenUsage,
  TraceSink,
  UsageEvent,
  UsageSink,
} from '../ports.js';

/**
 * Handing a finished call to the host's sinks.
 *
 * Best effort, and that is the point of having one place for it: by the time a
 * call is recorded the provider has answered and been paid, so a sink that
 * throws must not turn a paid answer into an error the caller never sees the
 * text of. The library does not log, so a sink failure is reported the only
 * way it can be — as a span on the trace.
 */

export interface RecordDeps {
  trace: TraceSink;
  usage?: UsageSink;
  clock: Clock;
}

export const NO_TOKENS: TokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function recordCall(
  deps: RecordDeps,
  params: {
    name: string;
    event: UsageEvent;
    /** Trace fields that are not already in the event. */
    trace?: Pick<GenerationTrace, 'usage' | 'error' | 'metadata'>;
  },
): Promise<void> {
  const { name, event } = params;
  const endedAt = deps.clock.now();

  try {
    deps.trace.generation({
      traceId: event.traceId,
      name,
      provider: event.provider,
      model: event.model,
      startedAt: endedAt - event.latencyMs,
      endedAt,
      costMicros: event.costMicros,
      status: event.status,
      ...params.trace,
    });
  } catch {
    // A tracing backend having a bad day is not the caller's problem.
  }

  if (!deps.usage) return;
  try {
    await deps.usage.record(event);
  } catch (error) {
    try {
      deps.trace.span({
        traceId: event.traceId,
        name: `${name}.usage-failed`,
        startedAt: endedAt,
        endedAt: deps.clock.now(),
        metadata: { provider: event.provider, model: event.model, error: describe(error) },
      });
    } catch {
      // Nowhere left to report it.
    }
  }
}

/**
 * A call that ended without an answer, recorded at zero cost.
 *
 * Nothing reached the reader and nothing is owed, but it is still a call: a
 * host that only watches its sinks would otherwise see a route that stopped
 * answering as a route that stopped being asked.
 */
export async function recordFailure(
  deps: RecordDeps,
  params: {
    name: string;
    candidate: ModelCandidate;
    error: AiError;
    attempts: number;
    latencyMs: number;
    traceId?: string;
  },
): Promise<void> {
  const { candidate, error } = params;
  const route = candidate.route;
  const routeId = route.id;
  const price = route.pricing ?? route.sttPricing ?? route.mtPricing;
  await recordCall(deps, {
    name: params.name,
    event: {
      provider: route.provider,
      model: candidate.model.name,
      ...(routeId === undefined ? {} : { routeId }),
      routedBy: candidate.routedBy,
      usage: NO_TOKENS,
      audioSeconds: 0,
      characters: 0,
      costMicros: 0,
      priceVersion: price?.version ?? UNPRICED,
      priced: price !== undefined,
      status: callStatusFor(error.kind),
      latencyMs: params.latencyMs,
      attempts: params.attempts,
      ...(params.traceId === undefined ? {} : { traceId: params.traceId }),
    },
    trace: { error: error.message },
  });
}
