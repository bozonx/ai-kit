import { Injectable, Logger, Inject } from '@nestjs/common';
import * as yaml from 'js-yaml';
import * as fs from 'fs';
import { ROUTER_CONFIG } from '../../config/router-config.provider.js';
import type { RouterConfig } from '../../config/router-config.interface.js';
import type { ModelDefinition } from './interfaces/model.interface.js';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

/**
 * Filter criteria for model selection
 */
export interface FilterCriteria {
  /**
   * Tags filter. 
   * Supports DNF logic: 
   * - Array elements (or comma-separated string) are OR-ed.
   * - Tags within an element joined by '&' are AND-ed.
   * Example: ["coding&tier-1", "llama"] means (coding AND tier-1) OR (llama)
   */
  tags?: string | string[];

  /**
   * Model type
   */
  type?: 'fast' | 'reasoning';

  /**
   * Minimum context size required
   */
  minContextSize?: number;

  /**
   * Minimum max output tokens required
   */
  minMaxOutputTokens?: number;

  /**
   * Whether model must support JSON response
   */
  jsonResponse?: boolean;

  /**
   * Whether model must support image input
   */
  supportsImage?: boolean;

  /**
   * Whether model must support video input
   */
  supportsVideo?: boolean;

  /**
   * Whether model must support audio input
   */
  supportsAudio?: boolean;

  /**
   * Whether model must support file input
   */
  supportsFile?: boolean;

  /**
   * Whether model must support tools/function calling
   */
  supportsTools?: boolean;

  /**
   * Filter by provider
   */
  provider?: string;
}

@Injectable()
export class ModelsService {
  private readonly logger = new Logger(ModelsService.name);
  private models: ModelDefinition[] = [];

  constructor(
    @Inject(ROUTER_CONFIG) private readonly config: RouterConfig,
    private readonly httpService: HttpService,
  ) { }

  async onModuleInit() {
    await this.loadModels();
  }

  /**
   * Load models from YAML file or URL
   */
  async loadModels() {
    try {
      const modelsFile = this.config.modelsFile;
      let content: string;

      if (modelsFile.startsWith('http://') || modelsFile.startsWith('https://')) {
        this.logger.log(`Loading models from URL: ${modelsFile}`);
        const response = await firstValueFrom(this.httpService.get(modelsFile));
        content = typeof response.data === 'string' ? response.data : yaml.dump(response.data);
      } else {
        this.logger.log(`Loading models from file: ${modelsFile}`);
        content = fs.readFileSync(modelsFile, 'utf8');
      }

      const data = yaml.load(content) as { models: ModelDefinition[] };
      this.models = data.models || [];
      this.logger.log(`Loaded ${this.models.length} models`);
    } catch (error) {
      this.logger.error(`Failed to load models: ${error instanceof Error ? error.message : String(error)}`);
      this.models = [];
    }
  }

  /**
   * Get all loaded models
   */
  getModels(): ModelDefinition[] {
    return this.models;
  }

  /**
   * Get only available models (where available !== false)
   */
  getAvailable(): ModelDefinition[] {
    return this.models.filter(model => model.available !== false);
  }

  /**
   * Find a model by its name or ID
   */
  findModel(modelName: string, provider?: string): ModelDefinition | undefined {
    // If provider is specified, look for exact match
    if (provider) {
      return this.models.find(m => m.model === modelName && m.provider === provider);
    }

    // Try finding by model name/id (OpenRouter format: provider/model)
    if (modelName.includes('/')) {
      const [p, m] = modelName.split('/');
      const match = this.models.find(model => model.provider === p && model.model === m);
      if (match) return match;
    }

    // Try finding by name field or model field
    return this.models.find(m => m.name === modelName || m.model === modelName);
  }

  /**
   * Find all models matching the name and optionally provider.
   * Used by SelectorService for priority list handling.
   */
  findByNameAndProvider(modelName: string, provider?: string): ModelDefinition[] {
    const results: ModelDefinition[] = [];

    // If provider is specified, look for exact match
    if (provider) {
      const match = this.models.find(m => m.name === modelName && m.provider === provider);
      if (match) {
        results.push(match);
      }
      return results;
    }

    // Find all models with matching name
    return this.models.filter(m => m.name === modelName);
  }

  /**
   * Filter models based on criteria
   */
  filter(criteria: FilterCriteria): ModelDefinition[] {
    // 1. First, filter by basic criteria (type, context size, capabilities, etc.)
    // Requirement: Basic filters apply before tags.
    const nonTagMatches = this.models.filter((model) => this.matchesNonTagCriteria(model, criteria));

    if (nonTagMatches.length === 0) {
      if (this.models.length > 0) {
        this.logger.warn(
          `No models found matching basic filters: ${this.formatCriteria(criteria)}. ` +
          `Total models checked: ${this.models.length}`,
        );
      }
      return [];
    }

    // 2. Then, filter the resulting set by tags
    if (!criteria.tags || (Array.isArray(criteria.tags) && criteria.tags.length === 0)) {
      return nonTagMatches;
    }

    const tagGroups =
      typeof criteria.tags === 'string'
        ? criteria.tags.split(',').map((t) => t.trim())
        : criteria.tags;

    const finalMatches = nonTagMatches.filter((model) => this.matchesTagGroups(model, tagGroups));

    if (finalMatches.length === 0) {
      this.logger.warn(
        `Models found (${nonTagMatches.length}) matching basic filters, but none match tags: "${tagGroups.join(', ')}". ` +
        `Applied filters: ${this.formatCriteria(criteria)}`,
      );
    }

    return finalMatches;
  }

  /**
   * Check if a model matches non-tag selection criteria
   */
  private matchesNonTagCriteria(model: ModelDefinition, criteria: FilterCriteria): boolean {
    // Model must be marked as available
    if (model.available === false) {
      return false;
    }

    if (criteria.type && model.type !== criteria.type) {
      return false;
    }

    if (criteria.minContextSize && (model.contextSize || 0) < criteria.minContextSize) {
      return false;
    }

    if (criteria.minMaxOutputTokens && (model.maxOutputTokens || 0) < criteria.minMaxOutputTokens) {
      return false;
    }

    if (criteria.jsonResponse && model.jsonResponse !== true) {
      return false;
    }

    if (criteria.supportsImage && model.supportsImage !== true) {
      return false;
    }

    if (criteria.supportsVideo && model.supportsVideo !== true) {
      return false;
    }

    if (criteria.supportsAudio && model.supportsAudio !== true) {
      return false;
    }

    if (criteria.supportsFile && model.supportsFile !== true) {
      return false;
    }

    if (criteria.supportsTools && model.supportsTools !== true) {
      return false;
    }

    if (criteria.provider && model.provider !== criteria.provider) {
      return false;
    }

    return true;
  }

  /**
   * Check if model matches any of the tag groups (OR logic between groups)
   * Each group can contain multiple tags joined by '&' (AND logic within group)
   */
  private matchesTagGroups(model: ModelDefinition, tagGroups: string[]): boolean {
    const activeGroups = tagGroups.filter((g) => g.trim().length > 0);
    if (activeGroups.length === 0) return true;

    // OR between groups (array elements or comma-separated)
    return activeGroups.some((group) => {
      // AND within group (e.g. "coding&tier-1")
      const requiredTags = group
        .split('&')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);

      if (requiredTags.length === 0) return false;

      return requiredTags.every((tag) => {
        // Support legacy '|' for OR inside AND group if needed
        if (tag.includes('|')) {
          const orTags = tag.split('|').map((t) => t.trim());
          return orTags.some((orTag) => model.tags.includes(orTag));
        }
        return model.tags.includes(tag);
      });
    });
  }

  /**
   * Format criteria for logging
   */
  private formatCriteria(criteria: FilterCriteria): string {
    const parts: string[] = [];
    if (criteria.type) parts.push(`type=${criteria.type}`);
    if (criteria.minContextSize) parts.push(`minContextSize=${criteria.minContextSize}`);
    if (criteria.jsonResponse) parts.push(`jsonResponse=true`);
    if (criteria.supportsImage) parts.push(`supportsImage=true`);
    if (criteria.supportsTools) parts.push(`supportsTools=true`);
    if (criteria.provider) parts.push(`provider=${criteria.provider}`);
    return parts.length > 0 ? parts.join(', ') : 'any';
  }

  /**
   * Check if a model matches the given selection criteria (legacy/compatibility)
   */
  matchesCriteria(model: ModelDefinition, criteria: FilterCriteria): boolean {
    if (!this.matchesNonTagCriteria(model, criteria)) {
      return false;
    }

    if (criteria.tags) {
      const tagGroups =
        typeof criteria.tags === 'string'
          ? criteria.tags.split(',').map((t) => t.trim())
          : criteria.tags;

      if (!this.matchesTagGroups(model, tagGroups)) {
        return false;
      }
    }

    return true;
  }
}
