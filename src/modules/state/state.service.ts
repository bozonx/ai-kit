import { Injectable, OnModuleInit, OnModuleDestroy, Inject, Logger } from '@nestjs/common';
import { ModelsService } from '../models/models.service.js';
import type { ModelState, ModelStats, CircuitBreakerConfig } from './interfaces/state.interface.js';
import { STATE_CLEANUP_INTERVAL_MS } from '../../common/constants/app.constants.js';
import { CIRCUIT_BREAKER_CONFIG } from './circuit-breaker-config.provider.js';

/**
 * Service for managing in-memory state of all models.
 * Tracks Circuit Breaker state, active requests, and statistics.
 */
@Injectable()
export class StateService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StateService.name);
  private readonly states: Map<string, ModelState> = new Map();
  private cleanupIntervalId?: ReturnType<typeof setInterval>;
  private _fallbacksUsed = 0;

  constructor(
    private readonly modelsService: ModelsService,
    @Inject(CIRCUIT_BREAKER_CONFIG) private readonly config: CircuitBreakerConfig,
  ) { }

  /**
   * Initialize states for all models on module start
   */
  public onModuleInit(): void {
    const models = this.modelsService.getModels();

    for (const model of models) {
      this.states.set(model.name, this.createInitialState(model.name));
    }

    this.logger.log(`Initialized state for ${this.states.size} models`);

    // Schedule periodic cleanup of stale data (unref to not block exit)
    this.cleanupIntervalId = setInterval(() => this.cleanupStaleData(), STATE_CLEANUP_INTERVAL_MS);
    this.cleanupIntervalId.unref();
  }

  /**
   * Clean up on module destroy
   */
  public onModuleDestroy(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
    }
  }

  /**
   * Get state for a specific model.
   * Creates initial state if model doesn't exist.
   */
  public hasState(modelName: string): boolean {
    return this.states.has(modelName);
  }

  /**
   * Get state for a specific model.
   * Creates initial state if model doesn't exist.
   */
  public getState(modelName: string): ModelState {
    let state = this.states.get(modelName);

    if (!state) {
      state = this.createInitialState(modelName);
      this.states.set(modelName, state);
    }

    return state;
  }

  /**
   * Get all model states
   */
  public getAllStates(): ModelState[] {
    return Array.from(this.states.values());
  }

  /**
   * Record a successful request
   */
  public recordSuccess(modelName: string, latencyMs: number): void {
    const state = this.getState(modelName);
    const now = Date.now();

    // Add request record
    state.stats.requests.push({
      timestamp: now,
      latencyMs,
      success: true,
    });

    // Update counters
    state.stats.lifetimeTotalRequests++;
    state.consecutiveFailures = 0;
    state.consecutiveSuccesses++;

    // Recalculate statistics
    this.recalculateStats(state);
  }

  /**
   * Record a failed request
   */
  public recordFailure(modelName: string, latencyMs: number = 0): void {
    const state = this.getState(modelName);
    const now = Date.now();

    // Add request record
    state.stats.requests.push({
      timestamp: now,
      latencyMs,
      success: false,
    });

    // Update counters
    state.stats.lifetimeTotalRequests++;
    state.consecutiveFailures++;
    state.consecutiveSuccesses = 0;

    // Recalculate statistics
    this.recalculateStats(state);
  }

  /**
   * Mark model as permanently unavailable (e.g., 404 response)
   */
  public markPermanentlyUnavailable(modelName: string, reason: string = '404 Not Found'): void {
    const state = this.getState(modelName);
    state.circuitState = 'PERMANENTLY_UNAVAILABLE';
    state.unavailableReason = reason;
    this.logger.warn(`Model ${modelName} marked as permanently unavailable: ${reason}`);
  }

  /**
   * Set circuit state for a model
   */
  public setCircuitState(modelName: string, circuitState: ModelState['circuitState']): void {
    const state = this.getState(modelName);
    const previousState = state.circuitState;
    state.circuitState = circuitState;

    if (circuitState === 'OPEN') {
      state.openedAt = Date.now();
    } else if (circuitState === 'CLOSED') {
      state.openedAt = undefined;
      state.consecutiveFailures = 0;
      state.consecutiveSuccesses = 0;
    }

    if (previousState !== circuitState) {
      this.logger.log(`Model ${modelName} circuit state: ${previousState} -> ${circuitState}`);
    }
  }

  /**
   * Check if model is available for requests
   */
  public isAvailable(modelName: string): boolean {
    const state = this.getState(modelName);
    return state.circuitState === 'CLOSED' || state.circuitState === 'HALF_OPEN';
  }

  /**
   * Reset model state (for admin API)
   */
  public resetState(modelName: string): void {
    const state = this.getState(modelName);
    const initialState = this.createInitialState(modelName);
    Object.assign(state, initialState);
    this.logger.log(`Model ${modelName} state reset`);
  }

  public recordFallbackUsage(): void {
    this._fallbacksUsed++;
  }

  public getFallbacksUsed(): number {
    return this._fallbacksUsed;
  }

  /**
   * Get Circuit Breaker configuration
   */
  public getConfig(): CircuitBreakerConfig {
    return { ...this.config };
  }

  /**
   * Create initial state for a model
   */
  private createInitialState(modelName: string): ModelState {
    return {
      name: modelName,
      circuitState: 'CLOSED',
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      stats: this.createInitialStats(),
    };
  }

  /**
   * Create initial statistics object
   */
  private createInitialStats(): ModelStats {
    return {
      totalRequests: 0,
      lifetimeTotalRequests: 0,
      successCount: 0,
      errorCount: 0,
      avgLatency: 0,
      p95Latency: 0,
      successRate: 1.0,
      requests: [],
    };
  }

  /**
   * Recalculate statistics from request records
   */
  private recalculateStats(state: ModelState): void {
    const now = Date.now();
    const windowStart = now - this.config.statsWindowSizeMins * 60 * 1000;

    // Filter records within window
    state.stats.requests = state.stats.requests.filter(r => r.timestamp >= windowStart);

    const records = state.stats.requests;

    if (records.length === 0) {
      state.stats = this.createInitialStats();
      return;
    }

    // Calculate totals
    state.stats.totalRequests = records.length;
    state.stats.successCount = records.filter(r => r.success).length;
    state.stats.errorCount = records.filter(r => !r.success).length;

    // Success rate
    state.stats.successRate = state.stats.successCount / state.stats.totalRequests;

    // Average latency (only from successful requests)
    const successfulLatencies = records.filter(r => r.success).map(r => r.latencyMs);

    if (successfulLatencies.length > 0) {
      state.stats.avgLatency =
        successfulLatencies.reduce((a, b) => a + b, 0) / successfulLatencies.length;

      // P95 latency
      const sorted = [...successfulLatencies].sort((a, b) => a - b);
      const p95Index = Math.floor(sorted.length * 0.95);
      state.stats.p95Latency = sorted[Math.min(p95Index, sorted.length - 1)];
    } else {
      state.stats.avgLatency = 0;
      state.stats.p95Latency = 0;
    }
  }

  /**
   * Clean up stale data from all models
   */
  private cleanupStaleData(): void {
    const now = Date.now();
    const windowStart = now - this.config.statsWindowSizeMins * 60 * 1000;
    let totalCleaned = 0;

    for (const state of this.states.values()) {
      const beforeCount = state.stats.requests.length;
      state.stats.requests = state.stats.requests.filter(r => r.timestamp >= windowStart);
      totalCleaned += beforeCount - state.stats.requests.length;

      // Recalculate stats after cleanup
      if (beforeCount !== state.stats.requests.length) {
        this.recalculateStats(state);
      }
    }

    if (totalCleaned > 0) {
      this.logger.debug(`Cleaned up ${totalCleaned} stale request records`);
    }
  }
}
