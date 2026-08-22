import { Injectable, Inject, Logger } from '@nestjs/common';
import { StateService } from '../../state/state.service.js';
import { CircuitBreakerService } from '../../state/circuit-breaker.service.js';
import { ROUTER_CONFIG } from '../../../config/router-config.provider.js';
import type { RouterConfig } from '../../../config/router-config.interface.js';
import type { ModelDefinition } from '../../models/interfaces/model.interface.js';
import type { SelectionStrategy, SelectionCriteria } from '../interfaces/selector.interface.js';
import {
  MIN_LATENCY_MS_FOR_CALCULATION,
  DEFAULT_MODEL_WEIGHT,
  DEFAULT_SUCCESS_RATE,
  LATENCY_NORMALIZATION_FACTOR,
} from './constants.js';

/**
 * Smart selection strategy.
 * Replaces round-robin and considers:
 * - Circuit Breaker state
 * - Model weights (for weighted random selection)
 * - Statistics (latency, success rate)
 * - Request filters (tags, type, min_context_size, min_max_output_tokens, prefer_fast, min_success_rate)

 */
@Injectable()
export class SmartStrategy implements SelectionStrategy {
  private readonly logger = new Logger(SmartStrategy.name);

  constructor(
    private readonly stateService: StateService,
    private readonly circuitBreaker: CircuitBreakerService,
    @Inject(ROUTER_CONFIG) private readonly config: RouterConfig,
  ) {}

  public select(models: ModelDefinition[], criteria: SelectionCriteria): ModelDefinition | null {
    if (models.length === 0) {
      return null;
    }

    const candidates = this.applyFilters(models, criteria);

    if (candidates.length === 0) {
      this.logger.debug('No candidates after filtering');
      return null;
    }

    this.logger.debug(
      `SmartStrategy: ${candidates.length} candidates available: ${candidates.map(c => c.name).join(', ')}`,
    );

    let selected: ModelDefinition | null;

    const mode = criteria.selectionMode || 'weighted_random';

    if (criteria.preferFast) {
      selected = this.selectFastest(candidates);
      this.logger.debug(`Selected fastest model: ${selected?.name ?? 'none'}`);
    } else if (mode === 'best') {
      selected = this.selectBest(candidates);
      this.logger.debug(`Selected best model: ${selected?.name ?? 'none'}`);
    } else if (mode === 'top_n_random') {
      selected = this.selectTopNRandom(candidates, 3);
      this.logger.debug(`Selected from top 3: ${selected?.name ?? 'none'}`);
    } else {
      selected = this.weightedRandomSelect(candidates);
      this.logger.debug(`Selected by weight: ${selected?.name ?? 'none'}`);
    }

    return selected;
  }

  private applyFilters(models: ModelDefinition[], criteria: SelectionCriteria): ModelDefinition[] {
    let candidates = this.filterExcluded(models, criteria.excludeModels);
    candidates = this.circuitBreaker.filterAvailable(candidates);

    if (criteria.minSuccessRate !== undefined) {
      candidates = this.filterBySuccessRate(candidates, criteria.minSuccessRate);
    }

    return candidates;
  }

  private filterExcluded(models: ModelDefinition[], excludeModels?: string[]): ModelDefinition[] {
    if (!excludeModels || excludeModels.length === 0) {
      return models;
    }

    return models.filter(model => !this.isModelExcluded(model, excludeModels));
  }

  private isModelExcluded(model: ModelDefinition, excludeModels: string[]): boolean {
    return (
      excludeModels.includes(model.name) ||
      excludeModels.includes(`${model.provider}/${model.name}`)
    );
  }

  private filterBySuccessRate(models: ModelDefinition[], minRate: number): ModelDefinition[] {
    return models.filter(model => this.meetsSuccessRateThreshold(model, minRate));
  }

  private meetsSuccessRateThreshold(model: ModelDefinition, minRate: number): boolean {
    const state = this.stateService.getState(model.name);
    const successRate =
      state.stats.totalRequests > 0 ? state.stats.successRate : DEFAULT_SUCCESS_RATE;
    return successRate >= minRate;
  }

  private selectFastest(models: ModelDefinition[]): ModelDefinition {
    return models.reduce((fastest, current) => {
      const fastestLatency = this.getModelLatency(fastest);
      const currentLatency = this.getModelLatency(current);
      return currentLatency < fastestLatency ? current : fastest;
    });
  }

  private getModelLatency(model: ModelDefinition): number {
    return this.stateService.getState(model.name).stats.avgLatency || Infinity;
  }

  private weightedRandomSelect(models: ModelDefinition[]): ModelDefinition | null {
    if (models.length === 0) {
      return null;
    }
    if (models.length === 1) {
      return models[0];
    }

    const weightedModels = this.calculateWeights(models);
    return this.selectRandomWeighted(weightedModels, models);
  }

  private calculateWeights(
    models: ModelDefinition[],
  ): Array<{ model: ModelDefinition; weight: number }> {
    return models.map(model => ({
      model,
      // Calculate weight based on static config, success rate, and latency
      weight: this.calculateEffectiveWeight(model),
    }));
  }

  private selectRandomWeighted(
    weightedModels: Array<{ model: ModelDefinition; weight: number }>,
    fallbackModels: ModelDefinition[],
  ): ModelDefinition {
    const totalWeight = weightedModels.reduce((sum, item) => sum + item.weight, 0);

    if (totalWeight === 0) {
      return fallbackModels[0];
    }

    // Weighted random selection:
    // 1. Generate a random number between 0 and totalWeight
    // 2. Iterate through models, subtracting their weight
    // 3. Pick the model where the random number drops below zero
    let random = Math.random() * totalWeight;
    for (const item of weightedModels) {
      random -= item.weight;
      if (random <= 0) {
        return item.model;
      }
    }

    return fallbackModels[fallbackModels.length - 1];
  }

  private calculateEffectiveWeight(model: ModelDefinition): number {
    const state = this.stateService.getState(model.name);
    const staticWeight = model.weight ?? DEFAULT_MODEL_WEIGHT;

    if (state.stats.totalRequests === 0) {
      return staticWeight;
    }

    const successRate = state.stats.successRate;
    const latencyFactor = this.calculateLatencyFactor(state.stats.avgLatency);

    // Final weight combines:
    // - Static weight from config (base importance)
    // - Success rate (reliability)
    // - Latency factor (performance speed)
    return staticWeight * successRate * latencyFactor;
  }

  private calculateLatencyFactor(avgLatency: number): number {
    // Avoid division by zero or extremely small numbers
    const normalizedLatency = Math.max(avgLatency, MIN_LATENCY_MS_FOR_CALCULATION);
    // Inverse relationship: lower latency -> higher factor
    return LATENCY_NORMALIZATION_FACTOR / normalizedLatency;
  }

  private selectBest(models: ModelDefinition[]): ModelDefinition {
    if (models.length === 0) throw new Error('No models to select from');
    if (models.length === 1) return models[0];

    const weightedModels = this.calculateWeights(models);
    // Sort by weight descending
    weightedModels.sort((a, b) => b.weight - a.weight);

    return weightedModels[0].model;
  }

  private selectTopNRandom(models: ModelDefinition[], n: number): ModelDefinition {
    if (models.length === 0) throw new Error('No models to select from');
    if (models.length <= n) {
      // If we have fewer models than N, just do weighted random on all of them
      return this.weightedRandomSelect(models)!;
    }

    const weightedModels = this.calculateWeights(models);
    // Sort by weight descending
    weightedModels.sort((a, b) => b.weight - a.weight);

    // Take top N
    const topN = weightedModels.slice(0, n);

    // Weighted random selection among top N
    return this.selectRandomWeighted(
      topN,
      topN.map(x => x.model),
    );
  }
}
