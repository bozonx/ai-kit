import type { Catalog } from '../catalog/catalog.js';
import { estimateCost } from '../catalog/pricing.js';
import type { ModelDefinition, TaskClass } from '../catalog/schema.js';
import { NoSuitableModelError } from '../errors.js';
import type { RoutedBy } from '../ports.js';
import { parseModelInput } from '../utils/model-ref.js';

/**
 * Which model answers, decided without asking a model.
 *
 * The whole of wave one is a filter over an ordered list the operator wrote in
 * the catalog. That is deliberate: a classifier in front of every request costs
 * a call, adds latency and makes "why did it answer differently today" an
 * unanswerable question. Escalation on a failed result comes later and is a
 * reaction to a fact, not a prediction.
 */

/** What the request looks like, in the terms a candidate can be filtered on. */
export interface PolicySignals {
  estimatedInputTokens: number;
  /** Images in the prompt. Drops every candidate that cannot read them. */
  hasImages?: boolean;
  needsTools?: boolean;
  needsStructuredOutput?: boolean;
  needsStreaming?: boolean;
  /** Output the caller intends to ask for, for the context-window check. */
  maxOutputTokens?: number;
}

export interface PolicyInput {
  /** `manual` honours `requestedModel`; `auto` follows the catalog's order. */
  mode: 'auto' | 'manual';
  taskClass: TaskClass;
  /**
   * What the caller pinned: a name, a `provider/name`, a priority list, or
   * `auto`. Only consulted in manual mode.
   */
  requestedModel?: string | string[];
  signals: PolicySignals;
  /**
   * Spend the caller is willing to allow for this call, in micro-units.
   * Candidates whose worst case exceeds it are dropped. Omitted means the
   * caller checks budget elsewhere, which is the normal case.
   */
  budget?: { remainingMicros: number };
}

export interface ModelCandidate {
  model: ModelDefinition;
  /** Why this one: the user asked, the catalog nominated, or it is a backup. */
  routedBy: RoutedBy;
}

/** Whether one model can serve one request at all. */
export function fitsSignals(model: ModelDefinition, signals: PolicySignals): boolean {
  if (signals.hasImages && !model.modalities.input.includes('image')) return false;
  if (signals.needsTools && !model.capabilities.tools) return false;
  if (signals.needsStructuredOutput && !model.capabilities.structuredOutput) return false;
  if (signals.needsStreaming && !model.capabilities.streaming) return false;

  const wantedOutput = Math.min(signals.maxOutputTokens ?? 0, model.maxOutputTokens);
  if (signals.estimatedInputTokens + wantedOutput > model.contextSize) return false;

  return true;
}

function withinBudget(model: ModelDefinition, input: PolicyInput): boolean {
  if (!input.budget) return true;
  const worstCase = estimateCost(
    model,
    input.signals.estimatedInputTokens,
    input.signals.maxOutputTokens,
  );
  return worstCase <= input.budget.remainingMicros;
}

/**
 * Candidates in the order they should be tried.
 *
 * The first is the answer, the rest are the fallback chain. A fallback never
 * crosses a tier boundary: replacing a premium model with a free one is not a
 * degraded answer, it is a different product, and the person who chose the
 * expensive one would rather see an error.
 *
 * @throws NoSuitableModelError when nothing in the catalog fits the request.
 */
export function selectCandidates(input: PolicyInput, catalog: Catalog): ModelCandidate[] {
  const nominated = catalog.candidatesFor(input.taskClass);
  const eligible = (model: ModelDefinition): boolean =>
    fitsSignals(model, input.signals) && withinBudget(model, input);

  if (input.mode === 'manual') {
    const requested = parseModelInput(input.requestedModel);
    const picked: ModelCandidate[] = [];
    const seen = new Set<string>();

    for (const ref of requested.refs) {
      const model = catalog.find(ref.name);
      if (!model?.available) continue;
      if (ref.provider && model.provider !== ref.provider) continue;
      if (seen.has(model.name)) continue;
      seen.add(model.name);
      picked.push({ model, routedBy: 'user' });
    }

    // A pinned model is honoured even when it does not look like a fit: the
    // person asked for it by name, and a silent substitution is exactly what
    // pinning is meant to prevent. The call fails loudly if it really cannot
    // serve the request.
    const first = picked[0];
    if (first) {
      const firstTier = first.model.tier;
      const fallbacks = nominated
        .filter(model => !seen.has(model.name) && model.tier === firstTier && eligible(model))
        .map((model): ModelCandidate => ({ model, routedBy: 'fallback' }));

      return requested.allowAuto ? [...picked, ...fallbacks] : picked;
    }

    if (!requested.allowAuto && requested.refs.length > 0) {
      throw new NoSuitableModelError(
        `None of the requested models is in the catalog: ${requested.refs.map(ref => ref.name).join(', ')}`,
      );
    }
  }

  const eligibleNominated = nominated.filter(eligible);
  const firstTier = eligibleNominated[0]?.tier;
  const candidates = eligibleNominated
    .filter(model => model.tier === firstTier)
    .map(
      (model, index): ModelCandidate => ({ model, routedBy: index === 0 ? 'auto' : 'fallback' }),
    );

  if (candidates.length === 0) {
    throw new NoSuitableModelError(
      `No model nominated for task class "${input.taskClass}" fits the request`,
    );
  }

  return candidates;
}
