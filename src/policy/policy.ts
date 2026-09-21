import type { Catalog, ResolvedRoute } from '../catalog/catalog.js';
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
  /**
   * BCP-47 tag of the language the request is in, when it is known.
   *
   * Drops every candidate that does not claim it. Without this filter a cheap
   * model eventually gets handed a language it was never trained on and answers
   * anyway, which is worse than refusing.
   */
  language?: string;
  /** Images in the prompt. Drops every candidate that cannot read them. */
  hasImages?: boolean;
  needsTools?: boolean;
  needsStructuredOutput?: boolean;
  needsStreaming?: boolean;
  /** Output the caller intends to ask for, for the context-window check. */
  maxOutputTokens?: number;
  /** Speech: the answer has to arrive while the person is still speaking. */
  needsRealtime?: boolean;
  /** Speech: word-level timings, without which subtitles cannot be aligned. */
  needsWordTimings?: boolean;
  /** Speech: who said which line. */
  needsDiarization?: boolean;
  /** Translation: the material is HTML and has to come back as HTML. */
  needsHtml?: boolean;
}

/**
 * Whether a model claims a language.
 *
 * Compared on the primary subtag, so a model that says `es` serves a request
 * for `es-AR`: the region is a matter of which provider is better at it, and
 * that is expressed by the order of candidates rather than by exclusion.
 */
export function speaksLanguage(model: ModelDefinition, language?: string): boolean {
  if (!language || model.languages.length === 0) return true;
  const wanted = primarySubtag(language);
  return model.languages.some(claimed => primarySubtag(claimed) === wanted);
}

function primarySubtag(tag: string): string {
  return tag.trim().toLowerCase().split(/[-_]/)[0] ?? '';
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
  /**
   * Routes the caller does not want tried first, by their own route id.
   *
   * The consumer's health automation knows things the catalog does not — that
   * a provider has been failing for ten minutes. A route named here is moved
   * to the back rather than dropped: a degraded route is still better than no
   * answer when it is the only one left.
   */
  demotedRoutes?: ReadonlySet<string>;
}

/**
 * One attempt the executor may make: a model, and the way it will be reached.
 *
 * A candidate is a route and not a model because a fallback between two
 * providers of the *same* model is the only fallback a person who pinned a
 * model by name has agreed to.
 */
export interface ModelCandidate {
  model: ModelDefinition;
  route: ResolvedRoute;
  /** Why this one: the user asked, the catalog nominated, or it is a backup. */
  routedBy: RoutedBy;
}

/** Whether one model, reached one way, can serve one request at all. */
export function fitsSignals(
  model: ModelDefinition,
  signals: PolicySignals,
  route?: ResolvedRoute,
): boolean {
  if (!speaksLanguage(model, signals.language)) return false;

  if (model.kind === 'stt') {
    const capabilities = model.sttCapabilities;
    if (signals.needsRealtime && !capabilities?.realtime) return false;
    if (signals.needsWordTimings && !capabilities?.wordTimings) return false;
    if (signals.needsDiarization && !capabilities?.diarization) return false;
    return true;
  }

  if (model.kind === 'mt') {
    if (signals.needsHtml && !model.mtCapabilities?.html) return false;
    if (!signals.language && !(model.mtCapabilities?.languageDetection ?? true)) return false;
    return true;
  }

  // The route's answer wins where it has one: a provider that cannot do
  // structured output must not be handed a request that needs it, however
  // capable the model is elsewhere.
  const capabilities = route?.capabilities ?? model.capabilities;

  if (signals.hasImages && !model.modalities.input.includes('image')) return false;
  if (signals.needsTools && !capabilities.tools) return false;
  if (signals.needsStructuredOutput && !capabilities.structuredOutput) return false;
  if (signals.needsStreaming && !capabilities.streaming) return false;

  const maxOutput = model.maxOutputTokens ?? 0;
  const contextSize = model.contextSize ?? 0;
  const wantedOutput = Math.min(signals.maxOutputTokens ?? 0, maxOutput);
  if (signals.estimatedInputTokens + wantedOutput > contextSize) return false;

  return true;
}

function withinBudget(model: ModelDefinition, route: ResolvedRoute, input: PolicyInput): boolean {
  if (!input.budget) return true;
  // Speech and translation are budgeted by the caller against a duration or a
  // character count, both of which are better numbers than anything guessable
  // from the request shape here.
  if (model.kind !== 'llm') return true;
  const worstCase = estimateCost(
    {
      name: model.name,
      provider: route.provider,
      ...(route.pricing === undefined ? {} : { pricing: route.pricing }),
      ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
    },
    input.signals.estimatedInputTokens,
    input.signals.maxOutputTokens,
  );
  return worstCase <= input.budget.remainingMicros;
}

/**
 * Every way to reach one model that this request could use, first choice first.
 *
 * Demoted routes go last rather than away. The order within the model is the
 * catalog's, and the consumer's health automation only ever moves a route
 * backwards — a library that let it remove one would eventually leave a
 * request with nothing to try during an outage of somebody else's making.
 */
function routesFor(
  model: ModelDefinition,
  catalog: Catalog,
  input: PolicyInput,
  routedBy: RoutedBy,
): ModelCandidate[] {
  const usable = catalog
    .routesOf(model.name)
    .filter(route => fitsSignals(model, input.signals, route) && withinBudget(model, route, input));

  const demoted = input.demotedRoutes;
  const healthy = demoted ? usable.filter(route => !route.id || !demoted.has(route.id)) : usable;
  const rest = demoted ? usable.filter(route => route.id && demoted.has(route.id)) : [];

  return [...healthy, ...rest].map((route, index) => ({
    model,
    route,
    // Only the very first way of reaching the first model is the plan; every
    // other one is something going wrong, and the accounting says so.
    routedBy: index === 0 ? routedBy : 'fallback',
  }));
}

/**
 * Candidates in the order they should be tried.
 *
 * The first is the answer, the rest are the fallback chain: every route of the
 * first model, then every route of the next. A fallback never crosses a tier
 * boundary: replacing a premium model with a free one is not a degraded
 * answer, it is a different product, and the person who chose the expensive
 * one would rather see an error.
 *
 * @throws NoSuitableModelError when nothing in the catalog fits the request.
 */
export function selectCandidates(input: PolicyInput, catalog: Catalog): ModelCandidate[] {
  const nominated = catalog.candidatesFor(input.taskClass);

  if (input.mode === 'manual') {
    const requested = parseModelInput(input.requestedModel);
    const picked: ModelCandidate[] = [];
    const seen = new Set<string>();

    const wantedKind = catalog.kindOf(input.taskClass);

    for (const ref of requested.refs) {
      const model = catalog.find(ref.name);
      if (!model?.available) continue;
      // A pinned model is honoured even when it looks like a poor fit, but not
      // when it is the wrong kind of thing entirely: no amount of asking makes
      // a language model transcribe an hour of audio.
      if (wantedKind && model.kind !== wantedKind) continue;
      if (seen.has(model.name)) continue;

      // A pinned model is honoured even when it does not look like a fit: the
      // person asked for it by name, and a silent substitution is exactly what
      // pinning is meant to prevent. Which *route* answers is still a choice,
      // and the one the request cannot use is still skipped.
      const routes = catalog
        .routesOf(model.name)
        .filter(route => !ref.provider || route.provider === ref.provider);
      if (routes.length === 0) continue;

      seen.add(model.name);
      const usable = routes.filter(route => fitsSignals(model, input.signals, route));
      const ordered = usable.length > 0 ? usable : routes.slice(0, 1);
      const demoted = input.demotedRoutes;
      const healthy = demoted
        ? ordered.filter(route => !route.id || !demoted.has(route.id))
        : ordered;
      const rest = demoted ? ordered.filter(route => route.id && demoted.has(route.id)) : [];

      for (const [index, route] of [...healthy, ...rest].entries()) {
        picked.push({
          model,
          route,
          routedBy: index === 0 && picked.length === 0 ? 'user' : 'fallback',
        });
      }
    }

    const first = picked[0];
    if (first) {
      const firstTier = first.model.tier;
      const fallbacks = nominated
        .filter(model => !seen.has(model.name) && model.tier === firstTier)
        .flatMap(model => routesFor(model, catalog, input, 'fallback'));

      return requested.allowAuto ? [...picked, ...fallbacks] : picked;
    }

    if (!requested.allowAuto && requested.refs.length > 0) {
      throw new NoSuitableModelError(
        `None of the requested models is in the catalog: ${requested.refs.map(ref => ref.name).join(', ')}`,
      );
    }
  }

  const eligible = nominated
    .map(model => ({ model, candidates: routesFor(model, catalog, input, 'auto') }))
    .filter(entry => entry.candidates.length > 0);

  const firstTier = eligible[0]?.model.tier;
  const candidates = eligible
    .filter(entry => entry.model.tier === firstTier)
    .flatMap((entry, index) =>
      index === 0
        ? entry.candidates
        : entry.candidates.map(candidate => ({ ...candidate, routedBy: 'fallback' as const })),
    );

  if (candidates.length === 0) {
    throw new NoSuitableModelError(
      `No model nominated for task class "${input.taskClass}" fits the request`,
    );
  }

  return candidates;
}
