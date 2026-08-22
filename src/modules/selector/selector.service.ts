import { Injectable, Logger } from '@nestjs/common';
import { ModelsService } from '../models/models.service.js';
import { SmartStrategy } from './strategies/smart.strategy.js';
import { CircuitBreakerService } from '../state/circuit-breaker.service.js';
import type { ModelDefinition } from '../models/interfaces/model.interface.js';
import type { SelectionCriteria } from './interfaces/selector.interface.js';

/**
 * Service for selecting models based on criteria.
 * Uses SmartStrategy for intelligent model selection.
 */
@Injectable()
export class SelectorService {
  private readonly logger = new Logger(SelectorService.name);

  constructor(
    private readonly modelsService: ModelsService,
    private readonly smartStrategy: SmartStrategy,
    private readonly circuitBreaker: CircuitBreakerService,
  ) {}

  /**
   * Select a model based on criteria
   */
  public selectModel(criteria: SelectionCriteria): ModelDefinition | null {
    // 1. Handle Priority List (new way)
    if (criteria.models && criteria.models.length > 0) {
      for (const modelRef of criteria.models) {
        // Find matching models (optionally filtered by provider)
        const candidates = this.modelsService.findByNameAndProvider(
          modelRef.name,
          modelRef.provider,
        );

        for (const candidate of candidates) {
          if (this.isExcluded(candidate, criteria.excludeModels)) {
            this.logger.debug(
              `Model "${candidate.name}" (${candidate.provider}) excluded from selection`,
            );
            continue;
          }

          if (!candidate.available) {
            this.logger.debug(
              `Model "${candidate.name}" (${candidate.provider}) is not available (marked as unavailable)`,
            );
            continue;
          }

          if (!this.circuitBreaker.canRequest(candidate.name)) {
            this.logger.debug(
              `Model "${candidate.name}" (${candidate.provider}) is unavailable (Circuit Breaker)`,
            );
            continue;
          }

          this.logger.debug(
            `Selected specific model from priority list: ${candidate.name} (${candidate.provider})`,
          );
          return candidate;
        }
      }

      // If we are here, no specific models worked.
      // Check if we should fall back to auto/smart strategy
      if (!criteria.allowAutoFallback) {
        this.logger.warn(
          'All requested models in priority list are unavailable, and auto fallback is disabled',
        );
        return null;
      }

      this.logger.debug('Priority list exhausted, falling back to Smart Strategy');
    }

    // 2. Fallback: Filter and Smart Strategy
    // Filter models by criteria
    const filteredModels = this.modelsService.filter({
      tags: criteria.tags,
      type: criteria.type,
      minContextSize: criteria.minContextSize,
      minMaxOutputTokens: criteria.minMaxOutputTokens,
      jsonResponse: criteria.jsonResponse,
      supportsImage: criteria.supportsImage,
      supportsVideo: criteria.supportsVideo,
      supportsAudio: criteria.supportsAudio,
      supportsFile: criteria.supportsFile,
    });

    if (filteredModels.length === 0) {
      this.logger.warn('No models match the criteria');
      return null;
    }

    // Use smart strategy to pick a model
    // Note: SmartStrategy should also respect excludeModels passed in criteria
    const selectedModel = this.smartStrategy.select(filteredModels, criteria);

    if (!selectedModel) {
      this.logger.warn('Selection strategy returned no model');
    }

    return selectedModel;
  }

  /**
   * Check if a model is in the exclusion list.
   * Checks against "name" and "provider/name".
   */
  private isExcluded(model: ModelDefinition, excludeModels?: string[]): boolean {
    if (!excludeModels || excludeModels.length === 0) {
      return false;
    }

    // Check exact name match
    if (excludeModels.includes(model.name)) {
      return true;
    }

    // Check provider/name match (e.g. "openrouter/deepseek-r1")
    const providerRef = `${model.provider}/${model.name}`;
    if (excludeModels.includes(providerRef)) {
      return true;
    }

    return false;
  }

  /**
   * Select next model excluding already tried ones
   */
  public selectNextModel(
    criteria: SelectionCriteria,
    excludeModels: string[],
  ): ModelDefinition | null {
    const extendedCriteria: SelectionCriteria = {
      ...criteria,
      excludeModels: [...(criteria.excludeModels ?? []), ...excludeModels],
    };

    return this.selectModel(extendedCriteria);
  }
}
