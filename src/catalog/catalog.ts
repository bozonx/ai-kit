import { load as parseYaml } from 'js-yaml';

import { CatalogError } from '../errors.js';
import {
  catalogSchema,
  type CatalogData,
  type ModelCapabilities,
  type ModelDefinition,
  type ModelKind,
  type ModelPricing,
  type MtPricing,
  type SttPricing,
  type TaskClass,
} from './schema.js';

/**
 * One way to reach one model, with everything already resolved.
 *
 * A route states only what it changes about the model, so the merge has to
 * happen somewhere; doing it once here is what lets the policy, the registry
 * and the pricing all read the same answer instead of each applying the
 * fallback rule slightly differently.
 */
export interface ResolvedRoute {
  /** The consumer's own identifier, when it gave one. Never interpreted here. */
  id?: string;
  /** 0 is the model's own route, the one written on the definition. */
  index: number;
  provider: string;
  /** The provider's own id for the model. */
  model: string;
  baseUrl?: string;
  capabilities: ModelCapabilities;
  pricing?: ModelPricing;
  sttPricing?: SttPricing;
  mtPricing?: MtPricing;
  available: boolean;
}

/**
 * A validated catalog with the lookups the rest of the library needs.
 *
 * Validation happens once, on load, and throws: a typo in a price or a task
 * class pointing at a model that no longer exists must stop a deployment from
 * starting, not surface as a strange bill three weeks later.
 */
export class Catalog {
  private readonly byName: ReadonlyMap<string, ModelDefinition>;
  private readonly routesByName: ReadonlyMap<string, readonly ResolvedRoute[]>;
  private readonly kindByTaskClass: ReadonlyMap<string, ModelKind>;
  private readonly data: CatalogData;

  private constructor(data: CatalogData) {
    this.data = data;
    this.byName = new Map(data.models.map(model => [model.name, model]));
    this.routesByName = new Map(data.models.map(model => [model.name, resolveRoutes(model)]));

    const kinds = new Map<string, ModelKind>();
    for (const [taskClass, names] of Object.entries(data.taskClasses)) {
      const first = (names ?? []).map(name => this.byName.get(name)).find(Boolean);
      if (first) kinds.set(taskClass, first.kind);
    }
    this.kindByTaskClass = kinds;
  }

  /** Validates an already-parsed object. */
  public static fromObject(input: unknown): Catalog {
    const result = catalogSchema.safeParse(input);
    if (!result.success) {
      const details = result.error.issues
        .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new CatalogError(`Model catalog is invalid: ${details}`, { cause: result.error });
    }
    return new Catalog(result.data);
  }

  /** Parses and validates YAML text. */
  public static fromYaml(yaml: string): Catalog {
    let parsed: unknown;
    try {
      parsed = parseYaml(yaml);
    } catch (error) {
      throw new CatalogError('Model catalog is not valid YAML', { cause: error });
    }
    return Catalog.fromObject(parsed);
  }

  public get models(): readonly ModelDefinition[] {
    return this.data.models;
  }

  public find(name: string): ModelDefinition | undefined {
    return this.byName.get(name);
  }

  /**
   * Same as `find`, for the callers that have no meaningful way to continue
   * without the model.
   */
  public require(name: string): ModelDefinition {
    const model = this.byName.get(name);
    if (!model) {
      throw new CatalogError(`Model "${name}" is not in the catalog`);
    }
    return model;
  }

  /**
   * The ways to reach a model, first choice first, unavailable ones dropped.
   *
   * Always at least the model's own route, so a catalog written without a
   * single `routes:` block behaves exactly as it did before they existed.
   */
  public routesOf(name: string): readonly ResolvedRoute[] {
    return this.routesByName.get(name) ?? [];
  }

  /**
   * Candidates for a task class, in the catalog's order, unavailable ones
   * dropped. Health and request fitness are somebody else's filter — this only
   * answers "what did the operator nominate".
   */
  public candidatesFor(taskClass: TaskClass): readonly ModelDefinition[] {
    const names = this.data.taskClasses[taskClass] ?? [];
    const candidates: ModelDefinition[] = [];
    for (const name of names) {
      const model = this.byName.get(name);
      if (model?.available) candidates.push(model);
    }
    return candidates;
  }

  /**
   * Which kind of model serves a task class, read off the models nominated
   * for it. Undefined for a class the catalog has never heard of.
   */
  public kindOf(taskClass: TaskClass): ModelKind | undefined {
    return this.kindByTaskClass.get(taskClass);
  }

  /**
   * The catalog as data, defaults filled in, unavailable models and routes
   * included.
   *
   * Valid input for `fromObject`, which is the point: a consumer that merges a
   * file catalog with its own records, or stores one, round-trips through this
   * instead of rebuilding the shape from lookups. A copy, so editing it cannot
   * change a catalog that is already validated.
   */
  public toData(): CatalogData {
    return structuredClone(this.data);
  }

  /** Whether every model had to carry a price to be accepted. See `requirePricing`. */
  public get requiresPricing(): boolean {
    return this.data.requirePricing;
  }

  /** Task classes the catalog has an opinion about. */
  public get taskClasses(): readonly TaskClass[] {
    return Object.keys(this.data.taskClasses);
  }
}

/**
 * The model's own route first, then its backups by priority.
 *
 * The definition's route is never sorted among the others: it is the one the
 * prices and the capabilities on the model itself describe, and a catalog that
 * wants a different first choice says so by editing the definition rather than
 * by giving a backup a lower number.
 */
function resolveRoutes(model: ModelDefinition): ResolvedRoute[] {
  const own: ResolvedRoute = {
    ...(model.routeId === undefined ? {} : { id: model.routeId }),
    index: 0,
    provider: model.provider,
    model: model.model,
    ...(model.baseUrl === undefined ? {} : { baseUrl: model.baseUrl }),
    capabilities: model.capabilities,
    ...(model.pricing === undefined ? {} : { pricing: model.pricing }),
    ...(model.sttPricing === undefined ? {} : { sttPricing: model.sttPricing }),
    ...(model.mtPricing === undefined ? {} : { mtPricing: model.mtPricing }),
    available: true,
  };

  const backups = [...model.routes]
    .sort((left, right) => left.priority - right.priority)
    .map((route, position): ResolvedRoute => {
      const pricing = route.pricing ?? model.pricing;
      const sttPricing = route.sttPricing ?? model.sttPricing;
      const mtPricing = route.mtPricing ?? model.mtPricing;
      return {
        ...(route.id === undefined ? {} : { id: route.id }),
        index: position + 1,
        provider: route.provider,
        model: route.model,
        ...(route.baseUrl === undefined ? {} : { baseUrl: route.baseUrl }),
        capabilities: { ...model.capabilities, ...clean(route.capabilities) },
        ...(pricing === undefined ? {} : { pricing }),
        ...(sttPricing === undefined ? {} : { sttPricing }),
        ...(mtPricing === undefined ? {} : { mtPricing }),
        available: route.available,
      };
    });

  return [own, ...backups].filter(route => route.available);
}

/** Drops the keys a route left unstated, so they do not overwrite the model's. */
function clean(
  capabilities: Record<string, boolean | undefined> | undefined,
): Partial<ModelCapabilities> {
  if (!capabilities) return {};
  return Object.fromEntries(
    Object.entries(capabilities).filter(([, value]) => value !== undefined),
  ) as Partial<ModelCapabilities>;
}
