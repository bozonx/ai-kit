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
 * Classes of work, known at the call site rather than guessed from the prompt.
 *
 * The point of naming them is that the caller always knows which one it is —
 * an alt-text generator is not going to accidentally be a research agent — so
 * routing needs no classifier and no model call of its own.
 */
export const TASK_CLASSES = [
  'rewrite',
  'translate',
  'summarize',
  'tags',
  'alt_text',
  'generate_post',
  'chat_simple',
  'chat_agentic',
  'diagnose',
  'bulk_plan',
  'vision',
  'image',
  'video',
  'dictation',
  'transcription',
  'subtitles',
] as const;

export type TaskClass = (typeof TASK_CLASSES)[number];

export const taskClassSchema = z.enum(TASK_CLASSES);

/**
 * What a model is, which decides how it is priced and what it is asked to do.
 *
 * The two kinds share one catalog on purpose: two tables of models are two
 * places where somebody forgets to bump a price version. They do not share a
 * task class, and that is enforced below rather than remembered.
 */
export const modelKindSchema = z.enum(['llm', 'stt']);
export type ModelKind = z.infer<typeof modelKindSchema>;

/**
 * Task classes served by speech-to-text models.
 *
 * The three are not cosmetic variants of one another. `dictation` is realtime
 * and judged on latency; `transcription` is batch and judged on price per hour;
 * `subtitles` is batch and cannot be served at all by a model without word
 * timings, because a subtitle that is not aligned is not a subtitle.
 */
export const STT_TASK_CLASSES = ['dictation', 'transcription', 'subtitles'] as const;

const STT_TASK_CLASS_SET: ReadonlySet<string> = new Set(STT_TASK_CLASSES);

/** Which kind of model a task class is served by. */
export function kindOfTaskClass(taskClass: TaskClass): ModelKind {
  return STT_TASK_CLASS_SET.has(taskClass) ? 'stt' : 'llm';
}

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

export const capabilitiesSchema = z.object({
  tools: z.boolean().default(false),
  structuredOutput: z.boolean().default(false),
  promptCaching: z.boolean().default(false),
  reasoning: z.boolean().default(false),
  streaming: z.boolean().default(true),
});

export type ModelCapabilities = z.infer<typeof capabilitiesSchema>;

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
    baseUrl: z.string().url().optional(),
    tier: modelTierSchema,
    /** Language models only; meaningless for a model billed by the second. */
    contextSize: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
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
    /**
     * Languages the model claims, as BCP-47 tags. Empty means "any", the same
     * convention language models get by saying nothing.
     *
     * The reason this is worth a field: a model asked for a language it does
     * not know does not refuse, it returns plausible nonsense — the worst kind
     * of failure, because it does not look like one.
     */
    languages: z.array(z.string()).default([]),
    /** Relative weight for weighted random choice within a pool. */
    weight: z.number().int().positive().default(1),
    /** Set to false to take a model out of rotation without deleting its prices. */
    available: z.boolean().default(true),
    tags: z.array(z.string()).default([]),
  })
  .superRefine((model, ctx) => {
    const issue = (message: string): void => {
      ctx.addIssue({ code: 'custom', path: ['name'], message: `${model.name}: ${message}` });
    };

    if (model.kind === 'llm') {
      if (!model.pricing) issue('a language model needs `pricing`');
      if (model.sttPricing) issue('`sttPricing` belongs to a model of kind `stt`');
      if (model.sttCapabilities) issue('`sttCapabilities` belongs to a model of kind `stt`');
      if (model.contextSize === undefined) issue('a language model needs `contextSize`');
      if (model.maxOutputTokens === undefined) issue('a language model needs `maxOutputTokens`');
      return;
    }

    if (!model.sttPricing) issue('a speech model needs `sttPricing`');
    if (model.pricing) issue('`pricing` is per token and belongs to a model of kind `llm`');
    if (
      model.sttCapabilities?.realtime &&
      model.sttPricing?.perAudioHourRealtimeMicros === undefined
    ) {
      issue('a realtime speech model needs `sttPricing.perAudioHourRealtimeMicros`');
    }
    if (
      model.sttCapabilities?.diarization &&
      model.sttPricing?.diarizationPerAudioHourMicros === undefined
    ) {
      // Not an error of taste: a surcharge nobody wrote down is a surcharge
      // that arrives on the invoice and in nobody's usage table.
      issue('a diarizing speech model needs `sttPricing.diarizationPerAudioHourMicros`');
    }
  });

export type ModelDefinition = z.infer<typeof modelSchema>;

export const catalogSchema = z
  .object({
    models: z.array(modelSchema).min(1),
    /**
     * Candidates per task class, in order. The first one that is healthy and
     * fits the request wins; the rest are the fallback chain.
     */
    taskClasses: z.partialRecord(taskClassSchema, z.array(z.string().min(1)).min(1)),
  })
  .superRefine((catalog, ctx) => {
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
      const wantedKind = kindOfTaskClass(taskClass as TaskClass);
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
        // The invariant a test would otherwise have to state about every
        // deployment's catalog: a speech model can never answer a language
        // task, and a language model can never be routed a transcription.
        if (model.kind !== wantedKind) {
          ctx.addIssue({
            code: 'custom',
            path: ['taskClasses', taskClass],
            message: `Model "${candidate}" is of kind "${model.kind}", but task class "${taskClass}" is served by "${wantedKind}" models`,
          });
        }
      }
    }
  });

export type CatalogData = z.infer<typeof catalogSchema>;
