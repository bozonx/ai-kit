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
] as const;

export type TaskClass = (typeof TASK_CLASSES)[number];

export const taskClassSchema = z.enum(TASK_CLASSES);

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

export const modelSchema = z.object({
  /** Name used everywhere else: in requests, in usage events, in the UI. */
  name: z.string().min(1),
  /** Which adapter runs it. Must have an entry in the provider registry. */
  provider: z.string().min(1),
  /** The provider's own id for the model, which is rarely the same string. */
  model: z.string().min(1),
  tier: modelTierSchema,
  contextSize: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  modalities: z
    .object({
      input: z.array(modalitySchema).default(['text']),
      output: z.array(modalitySchema).default(['text']),
    })
    .prefault({}),
  capabilities: capabilitiesSchema.prefault({}),
  pricing: pricingSchema,
  /** Relative weight for weighted random choice within a pool. */
  weight: z.number().int().positive().default(1),
  /** Set to false to take a model out of rotation without deleting its prices. */
  available: z.boolean().default(true),
  tags: z.array(z.string()).default([]),
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

    for (const [taskClass, candidates] of Object.entries(catalog.taskClasses)) {
      for (const candidate of candidates ?? []) {
        if (!names.has(candidate)) {
          ctx.addIssue({
            code: 'custom',
            path: ['taskClasses', taskClass],
            message: `Unknown model "${candidate}" listed for task class "${taskClass}"`,
          });
        }
      }
    }
  });

export type CatalogData = z.infer<typeof catalogSchema>;
