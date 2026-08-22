import { Injectable, Inject, Logger } from '@nestjs/common';
import { StateService } from './state.service.js';
import type { ModelDefinition } from '../models/interfaces/model.interface.js';
import type { CircuitBreakerConfig } from './interfaces/state.interface.js';
import { CIRCUIT_BREAKER_CONFIG } from './circuit-breaker-config.provider.js';

/**
 * Circuit Breaker service implementing the Circuit Breaker pattern.
 *
 * States:
 * - CLOSED: Normal operation, requests allowed
 * - OPEN: Circuit tripped, requests blocked until cooldown expires
 * - HALF_OPEN: Testing if service recovered, limited requests allowed
 * - PERMANENTLY_UNAVAILABLE: Model doesn't exist (404), blocked until restart
 */
@Injectable()
export class CircuitBreakerService {
  private readonly logger = new Logger(CircuitBreakerService.name);

  constructor(
    private readonly stateService: StateService,
    @Inject(CIRCUIT_BREAKER_CONFIG) private readonly config: CircuitBreakerConfig,
  ) {}

  /**
   * Handle successful response from a model.
   * May transition HALF_OPEN -> CLOSED.
   */
  public onSuccess(modelName: string, latencyMs: number): void {
    this.stateService.recordSuccess(modelName, latencyMs);
    const state = this.stateService.getState(modelName);

    // If in HALF_OPEN and enough consecutive successes, close the circuit
    if (
      state.circuitState === 'HALF_OPEN' &&
      state.consecutiveSuccesses >= this.config.successThreshold
    ) {
      this.stateService.setCircuitState(modelName, 'CLOSED');
      this.logger.log(
        `Model ${modelName} recovered: HALF_OPEN -> CLOSED after ${state.consecutiveSuccesses} successes`,
      );
    }
  }

  /**
   * Handle error response from a model.
   * May transition CLOSED -> OPEN or mark as PERMANENTLY_UNAVAILABLE.
   *
   * @param modelName Model name
   * @param errorCode HTTP error code (optional)
   * @param latencyMs Request latency (optional)
   */
  public onFailure(modelName: string, errorCode?: number, latencyMs: number = 0): void {
    // 404 means model doesn't exist - mark as permanently unavailable
    if (errorCode === 404) {
      this.stateService.markPermanentlyUnavailable(modelName, '404 Not Found');
      return;
    }

    this.stateService.recordFailure(modelName, latencyMs);
    const state = this.stateService.getState(modelName);

    // Check if we should open the circuit
    if (
      state.circuitState !== 'OPEN' &&
      state.circuitState !== 'PERMANENTLY_UNAVAILABLE' &&
      state.consecutiveFailures >= this.config.failureThreshold
    ) {
      this.stateService.setCircuitState(modelName, 'OPEN');
      this.logger.warn(
        `Model ${modelName} circuit opened after ${state.consecutiveFailures} consecutive failures`,
      );
    }

    // If in HALF_OPEN and a failure occurs, go back to OPEN
    if (state.circuitState === 'HALF_OPEN') {
      this.stateService.setCircuitState(modelName, 'OPEN');
      this.logger.warn(`Model ${modelName} failed during HALF_OPEN, returning to OPEN`);
    }
  }

  /**
   * Check if a request can be made to the model.
   * Handles state transitions for cooldown expiry.
   */
  public canRequest(modelName: string): boolean {
    const state = this.stateService.getState(modelName);

    switch (state.circuitState) {
      case 'CLOSED':
        return true;

      case 'HALF_OPEN':
        // Allow test requests in HALF_OPEN state to verify recovery
        return true;

      case 'OPEN':
        // Check if cooldown has expired
        if (state.openedAt) {
          const elapsed = Date.now() - state.openedAt;
          if (elapsed >= this.config.cooldownPeriodMins * 60 * 1000) {
            // Transition to HALF_OPEN to test if the service has recovered
            this.stateService.setCircuitState(modelName, 'HALF_OPEN');
            this.logger.log(`Model ${modelName} cooldown expired, transitioning to HALF_OPEN`);
            return true;
          }
        }
        // Still in cooldown period
        return false;

      case 'PERMANENTLY_UNAVAILABLE':
        // Never allow requests to models that are permanently broken (e.g. 404s)
        return false;

      default:
        return false;
    }
  }

  /**
   * Filter models to only those available for requests
   */
  public filterAvailable(models: ModelDefinition[]): ModelDefinition[] {
    return models.filter(model => this.canRequest(model.name));
  }

  /**
   * Get remaining cooldown time for a model in OPEN state
   */
  public getRemainingCooldown(modelName: string): number {
    const state = this.stateService.getState(modelName);

    if (state.circuitState !== 'OPEN' || !state.openedAt) {
      return 0;
    }

    const elapsed = Date.now() - state.openedAt;
    return Math.max(0, this.config.cooldownPeriodMins * 60 * 1000 - elapsed);
  }

  /**
   * Get Circuit Breaker configuration
   */
  public getConfig(): CircuitBreakerConfig {
    return { ...this.config };
  }
}
