import { z } from 'zod';

/**
 * The model catalog.
 *
 * The catalog is the main entity of this package, not a lookup table. It says
 * what a model costs, what it can do and which tasks it is a candidate for —
 * so changing which model answers a given kind of request is an edit to a YAML
 * file rather than a release of the library.
 *
 * The catalog is data owned by the consumer. The package ships the schema and
 * the loader; `models.example.yaml` is an example, not a default.
 */

/**
 * A class of work, named by the consumer.
 *
 * Deliberately a free string. It used to be a closed list, and the list held
 * words like `generate_post` and `alt_text` — the vocabulary of one product,
 * shipped inside a library that claims to know nothing about anybody's domain.
 * A second product could then either fork the package or call its ticket
 * triage `rewrite`.
 *
 * What the library still needs to know — whether a class is served by language
 * models or by speech ones — is derived from the models nominated for it, and
 * the schema refuses a class that nominates both. That is the same invariant,
 * read off the data instead of hard-coded.
 */
export type TaskClass = string;

export const taskClassSchema = z.string().min(1);

/**
 * What a model is, which decides how it is priced and what it is asked to do.
 *
 * The kinds share one catalog on purpose: several tables of models are several
 * places where somebody forgets to bump a price version. They do not share a
 * task class, and that is enforced below rather than remembered.
 */
export const modelKindSchema = z.enum(['llm', 'stt', 'mt', 'embedding']);
export type ModelKind = z.infer<typeof modelKindSchema>;

/**
 * Quality class, and the boundary a fallback may not cross.
 *
 * A premium model silently replaced by a free one is not a degraded answer,
 * it is a different product. Fallback looks for the same tier first.
 */
export const modelTierSchema = z.enum(['economy', 'standard', 'premium']);
export type ModelTier = z.infer<typeof modelTierSchema>;

export const modalitySchema = z.enum(['text', 'image', 'audio', 'video', 'pdf']);
export type Modality = z.infer<typeof modalitySchema>;

/**
 * Prices per million tokens, in micro-units of the currency (1_000_000 = 1 USD).
 *
 * Integers, deliberately: money in floating point is a bug that only shows up
 * in the aggregate, months later, in an invoice nobody can reconcile.
 */
export const pricingSchema = z.object({
  /**
   * Label of the price table these numbers came from, e.g. '2026-08'. Written
   * into every usage event, because history cannot be recomputed without it.
   */
  version: z.string().min(1),
  inputPerMTok: z.number().int().nonnegative(),
  outputPerMTok: z.number().int().nonnegative(),
  /** Price of an input token served from the provider's prompt cache. */
  cachedInputPerMTok: z.number().int().nonnegative().optional(),
  /** Price of a reasoning token, when the provider bills it apart from output. */
  reasoningPerMTok: z.number().int().nonnegative().optional(),
  /** Flat price per generated image, for image models. */
  perImage: z.number().int().nonnegative().optional(),
  /** Flat price per second of generated video. */
  perVideoSecond: z.number().int().nonnegative().optional(),
});

export type ModelPricing = z.infer<typeof pricingSchema>;

/**
 * What a model can do.
 *
 * `tools`, `structuredOutput` and `streaming` decide whether a request may be
 * sent to it. `promptCaching` and `reasoning` are descriptive: no policy reads
 * them, and they exist for the consumer's own model picker and prompt layout.
 */
export const capabilitiesSchema = z.object({
  tools: z.boolean().default(false),
  structuredOutput: z.boolean().default(false),
  promptCaching: z.boolean().default(false),
  reasoning: z.boolean().default(false),
  streaming: z.boolean().default(true),
});

export type ModelCapabilities = z.infer<typeof capabilitiesSchema>;

/**
 * The same capabilities, as a route states them.
 *
 * Every field optional and nothing defaulted: a route says what it changes
 * about the model, and silence means "whatever the model says". Defaulting
 * here would turn every unstated capability into a denial.
 */
export const routeCapabilitiesSchema = z.object({
  tools: z.boolean().optional(),
  structuredOutput: z.boolean().optional(),
  promptCaching: z.boolean().optional(),
  reasoning: z.boolean().optional(),
  streaming: z.boolean().optional(),
});

export type RouteCapabilities = z.infer<typeof routeCapabilitiesSchema>;

/**
 * Prices per hour of audio, in micro-units of the currency (1_000_000 = 1 USD).
 *
 * A different unit from `pricing` for the same reason it is a different field:
 * speech is billed by the second everywhere, and pretending it is billed by the
 * token would mean converting twice and reconciling never.
 */
export const sttPricingSchema = z.object({
  /** Label of the price table these numbers came from, e.g. '2026-08'. */
  version: z.string().min(1),
  perAudioHourMicros: z.number().int().nonnegative(),
  /**
   * Streaming costs more than batch at every provider, so it is a second price
   * rather than a multiplier: a coefficient invented here would be wrong for
   * one of them the day it is written.
   */
  perAudioHourRealtimeMicros: z.number().int().nonnegative().optional(),
  /** Provider surcharges add to the base price, they do not replace it. */
  diarizationPerAudioHourMicros: z.number().int().nonnegative().optional(),
});

export type SttPricing = z.infer<typeof sttPricingSchema>;

export const sttCapabilitiesSchema = z.object({
  realtime: z.boolean().default(false),
  wordTimings: z.boolean().default(false),
  diarization: z.boolean().default(false),
  punctuation: z.boolean().default(false),
  /** Accepts a list of terms to bias recognition towards. */
  keyterms: z.boolean().default(false),
  languageDetection: z.boolean().default(false),
});

export type SttCapabilities = z.infer<typeof sttCapabilitiesSchema>;

/**
 * Prices per million characters, in micro-units of the currency.
 *
 * The third unit, and the third one that had to be its own field. A dedicated
 * translation engine bills the characters it was handed, before it has
 * produced anything — there is no output price because there is no output
 * anybody is charged for.
 */
export const mtPricingSchema = z.object({
  /** Label of the price table these numbers came from, e.g. '2026-08'. */
  version: z.string().min(1),
  perMillionCharsMicros: z.number().int().nonnegative(),
});

export type MtPricing = z.infer<typeof mtPricingSchema>;

export const mtCapabilitiesSchema = z.object({
  /** Translates HTML without destroying the tags. */
  html: z.boolean().default(false),
  /** Works out the source language when it is not given one. */
  languageDetection: z.boolean().default(true),
  /** Accepts a glossary the engine itself enforces. */
  glossary: z.boolean().default(false),
});

export type MtCapabilities = z.infer<typeof mtCapabilitiesSchema>;

/**
 * One more way to reach a model the catalog already defines.
 *
 * The same model is served by several providers at different prices, with
 * different latencies and different bad days. Without this the only fallback
 * available to somebody who pinned a model by name would be a *different
 * model*, which is exactly what pinning is meant to prevent.
 *
 * The definition itself is the first route; everything listed here is a backup
 * for it, tried in `priority` order.
 */
export const modelRouteSchema = z.object({
  /**
   * The consumer's own identifier for this route, echoed back in the
   * accounting. The library never interprets it — it exists so that "which of
   * my routes answered" is a question the consumer can answer about its own
   * rows without matching on provider names.
   */
  id: z.string().min(1).optional(),
  /** Which adapter runs it. Must have an entry in the provider registry. */
  provider: z.string().min(1),
  /** The provider's own id for the model, which is rarely the same string. */
  model: z.string().min(1),
  /** Where the adapter should talk, when it is not the provider's own endpoint. */
  baseUrl: z.url().optional(),
  /** Lower goes first. The definition's own route is always tried first. */
  priority: z.number().int().default(100),
  /**
   * What the provider can actually do, where it differs from the model.
   *
   * A route without structured output must not be handed a request that needs
   * it, however capable the model is elsewhere.
   */
  capabilities: routeCapabilitiesSchema.optional(),
  /** What this route charges. Falls back to the model's own price. */
  pricing: pricingSchema.optional(),
  sttPricing: sttPricingSchema.optional(),
  mtPricing: mtPricingSchema.optional(),
  /** Set to false to take a route out of rotation without deleting its prices. */
  available: z.boolean().default(true),
});

export type ModelRouteDefinition = z.infer<typeof modelRouteSchema>;

export const modelSchema = z
  .object({
    /** Name used everywhere else: in requests, in usage events, in the UI. */
    name: z.string().min(1),
    /** What the model is. Decides which price block and which task classes apply. */
    kind: modelKindSchema.default('llm'),
    /** Which adapter runs it. Must have an entry in the provider registry. */
    provider: z.string().min(1),
    /** The provider's own id for the model, which is rarely the same string. */
    model: z.string().min(1),
    /**
     * Where the adapter should talk, when it is not the provider's own endpoint.
     *
     * Exists so that a self-hosted or fine-tuned model is a line of YAML rather
     * than a new adapter — the difference between trying one and not trying one.
     */
    baseUrl: z.url().optional(),
    /** The consumer's own identifier for the model's first route. */
    routeId: z.string().min(1).optional(),
    /** Backup routes: the same model somewhere else. */
    routes: z.array(modelRouteSchema).default([]),
    tier: modelTierSchema,
    /**
     * Language models: the whole window. Embedding models: the most tokens one
     * input may have. Meaningless for a model billed by the second.
     */
    contextSize: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    /**
     * `input` decides whether a request with images may be sent here;
     * `output` is descriptive, for the consumer.
     */
    modalities: z
      .object({
        input: z.array(modalitySchema).default(['text']),
        output: z.array(modalitySchema).default(['text']),
      })
      .prefault({}),
    capabilities: capabilitiesSchema.prefault({}),
    pricing: pricingSchema.optional(),
    sttCapabilities: sttCapabilitiesSchema.optional(),
    sttPricing: sttPricingSchema.optional(),
    mtCapabilities: mtCapabilitiesSchema.optional(),
    mtPricing: mtPricingSchema.optional(),
    /**
     * Length of the vectors an embedding model returns. Descriptive: vectors
     * of different lengths cannot share an index, and the consumer's index is
     * where that has to be checked.
     */
    dimensions: z.number().int().positive().optional(),
    /**
     * Languages the model claims, as BCP-47 tags. Empty means "any", the same
     * convention language models get by saying nothing.
     *
     * The reason this is worth a field: a model asked for a language it does
     * not know does not refuse, it returns plausible nonsense — the worst kind
     * of failure, because it does not look like one.
     */
    languages: z.array(z.string()).default([]),
    /**
     * The consumer's own ranking hint. Never read by the library: candidates
     * are tried in the order `taskClasses` lists them, not drawn at random.
     */
    weight: z.number().int().positive().default(1),
    /** Set to false to take a model out of rotation without deleting its prices. */
    available: z.boolean().default(true),
    /** The consumer's own labels. Never read by the library. */
    tags: z.array(z.string()).default([]),
  })
  .superRefine((model, ctx) => {
    const issue = (message: string): void => {
      ctx.addIssue({ code: 'custom', path: ['name'], message: `${model.name}: ${message}` });
    };

    const providers = new Set([model.provider]);
    for (const route of model.routes) {
      // Two routes at one provider are either a duplicate or a mistake, and
      // both of them mean a fallback that goes nowhere new.
      if (providers.has(route.provider)) {
        issue(`has more than one route at provider "${route.provider}"`);
      }
      providers.add(route.provider);
    }

    if (model.kind !== 'embedding' && model.dimensions !== undefined) {
      issue('`dimensions` belongs to a model of kind `embedding`');
    }

    if (model.kind === 'embedding') {
      if (model.contextSize === undefined) issue('an embedding model needs `contextSize`');
      if (model.sttPricing) issue('`sttPricing` belongs to a model of kind `stt`');
      if (model.mtPricing) issue('`mtPricing` belongs to a model of kind `mt`');
      for (const route of model.routes) {
        if (route.sttPricing ?? route.mtPricing) {
          issue(`route at "${route.provider}" prices a different kind of model`);
        }
      }
      return;
    }

    if (model.kind === 'llm') {
      if (model.sttPricing) issue('`sttPricing` belongs to a model of kind `stt`');
      if (model.sttCapabilities) issue('`sttCapabilities` belongs to a model of kind `stt`');
      if (model.mtPricing) issue('`mtPricing` belongs to a model of kind `mt`');
      if (model.contextSize === undefined) issue('a language model needs `contextSize`');
      if (model.maxOutputTokens === undefined) issue('a language model needs `maxOutputTokens`');
      for (const route of model.routes) {
        if (route.sttPricing ?? route.mtPricing) {
          issue(`route at "${route.provider}" prices a different kind of model`);
        }
      }
      return;
    }

    if (model.kind === 'mt') {
      if (model.pricing) issue('`pricing` is per token and belongs to a model of kind `llm`');
      if (model.sttPricing) issue('`sttPricing` belongs to a model of kind `stt`');
      for (const route of model.routes) {
        if (route.pricing ?? route.sttPricing) {
          issue(`route at "${route.provider}" prices a different kind of model`);
        }
      }
      return;
    }

    if (model.pricing) issue('`pricing` is per token and belongs to a model of kind `llm`');
    if (model.mtPricing) issue('`mtPricing` belongs to a model of kind `mt`');
    for (const route of model.routes) {
      if (route.pricing ?? route.mtPricing) {
        issue(`route at "${route.provider}" prices a different kind of model`);
      }
    }
    // The surcharges are checked only on a price block that exists: a model
    // with no price at all is the catalog-level decision `requirePricing`.
    if (
      model.sttPricing &&
      model.sttCapabilities?.realtime &&
      model.sttPricing.perAudioHourRealtimeMicros === undefined
    ) {
      issue('a realtime speech model needs `sttPricing.perAudioHourRealtimeMicros`');
    }
    if (
      model.sttPricing &&
      model.sttCapabilities?.diarization &&
      model.sttPricing.diarizationPerAudioHourMicros === undefined
    ) {
      // Not an error of taste: a surcharge nobody wrote down is a surcharge
      // that arrives on the invoice and in nobody's usage table.
      issue('a diarizing speech model needs `sttPricing.diarizationPerAudioHourMicros`');
    }
  });

export type ModelDefinition = z.infer<typeof modelSchema>;

/** The price block a model of this kind is billed by, when it has none. */
function missingPrice(model: ModelDefinition): string | undefined {
  switch (model.kind) {
    // Priced per input token through the ordinary `pricing` block: an
    // embedding is billed exactly like a prompt that produces no answer.
    case 'embedding':
      return model.pricing ? undefined : 'an embedding model needs `pricing`';
    case 'llm':
      return model.pricing ? undefined : 'a language model needs `pricing`';
    case 'mt':
      return model.mtPricing ? undefined : 'a translation model needs `mtPricing`';
    case 'stt':
      return model.sttPricing ? undefined : 'a speech model needs `sttPricing`';
  }
}

/**
 * A model as it is written down, before the defaults are filled in.
 *
 * The type to annotate a catalog kept in code with: a literal that omits
 * `routes`, `weight` or `tags` is a valid catalog, and only becomes the fuller
 * shape once it has been through the schema.
 */
export type ModelDefinitionInput = z.input<typeof modelSchema>;

export const catalogSchema = z
  .object({
    models: z.array(modelSchema).min(1),
    /**
     * Candidates per task class, in order. The first one that is healthy and
     * fits the request wins; the rest are the fallback chain.
     *
     * The class names are the consumer's own words. What they may not do is
     * mix kinds: a class served by both a speech model and a language one is a
     * class whose requests would be routed by whichever happened to be first.
     */
    taskClasses: z.record(taskClassSchema, z.array(z.string().min(1)).min(1)),
    /**
     * Whether every model has to carry a price.
     *
     * On by default, because a product that bills its users must never learn
     * from an invoice that a model was quietly free in its usage table. Off is
     * for a catalog nobody is billed through — a desktop app on the user's own
     * key, a local model — where an unpriced call is recorded as exactly that:
     * `priced: false`, zero cost, price version `unpriced`.
     */
    requirePricing: z.boolean().default(true),
  })
  .superRefine((catalog, ctx) => {
    if (catalog.requirePricing) {
      catalog.models.forEach((model, index) => {
        const missing = missingPrice(model);
        if (missing) {
          ctx.addIssue({
            code: 'custom',
            path: ['models', index, 'name'],
            message: `${model.name}: ${missing}`,
          });
        }
      });
    }

    const names = new Set<string>();
    for (const model of catalog.models) {
      if (names.has(model.name)) {
        ctx.addIssue({
          code: 'custom',
          path: ['models'],
          message: `Duplicate model name: ${model.name}`,
        });
      }
      names.add(model.name);
    }

    const byName = new Map(catalog.models.map(model => [model.name, model]));

    for (const [taskClass, candidates] of Object.entries(catalog.taskClasses)) {
      let kind: ModelKind | undefined;
      for (const candidate of candidates ?? []) {
        const model = byName.get(candidate);
        if (!model) {
          ctx.addIssue({
            code: 'custom',
            path: ['taskClasses', taskClass],
            message: `Unknown model "${candidate}" listed for task class "${taskClass}"`,
          });
          continue;
        }
        // The invariant that used to be a hard-coded list of speech task
        // classes: whatever a class is called, everything nominated for it has
        // to be the same kind of thing, or the request is routed by accident.
        kind ??= model.kind;
        if (model.kind !== kind) {
          ctx.addIssue({
            code: 'custom',
            path: ['taskClasses', taskClass],
            message: `Task class "${taskClass}" mixes models of kind "${kind}" and "${model.kind}"`,
          });
        }
      }
    }
  });

export type CatalogData = z.infer<typeof catalogSchema>;

/** A catalog as it is written down. See `ModelDefinitionInput`. */
export type CatalogInput = z.input<typeof catalogSchema>;
