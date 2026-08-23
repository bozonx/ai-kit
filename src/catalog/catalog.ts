import { readFileSync } from 'node:fs';
import { load as parseYaml } from 'js-yaml';

import { CatalogError } from '../errors.js';
import { catalogSchema, type CatalogData, type ModelDefinition, type TaskClass } from './schema.js';

/**
 * A validated catalog with the lookups the rest of the library needs.
 *
 * Validation happens once, on load, and throws: a typo in a price or a task
 * class pointing at a model that no longer exists must stop a deployment from
 * starting, not surface as a strange bill three weeks later.
 */
export class Catalog {
  private readonly byName: ReadonlyMap<string, ModelDefinition>;
  private readonly data: CatalogData;

  private constructor(data: CatalogData) {
    this.data = data;
    this.byName = new Map(data.models.map(model => [model.name, model]));
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

  /** Reads, parses and validates a YAML file. */
  public static fromFile(path: string): Catalog {
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      throw new CatalogError(`Cannot read model catalog at ${path}`, { cause: error });
    }
    return Catalog.fromYaml(text);
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

  /** Task classes the catalog has an opinion about. */
  public get taskClasses(): readonly TaskClass[] {
    return Object.keys(this.data.taskClasses) as TaskClass[];
  }
}
