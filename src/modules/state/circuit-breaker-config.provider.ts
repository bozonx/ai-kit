import { loadRouterConfig } from '../../config/router.config.js';
import type { CircuitBreakerConfig } from './interfaces/state.interface.js';
import { DEFAULT_CIRCUIT_BREAKER_CONFIG } from './interfaces/state.interface.js';

/**
 * Circuit Breaker configuration injection token
 */
export const CIRCUIT_BREAKER_CONFIG = 'CIRCUIT_BREAKER_CONFIG';

/**
 * Factory function to create the merged Circuit Breaker config
 */
export function createCircuitBreakerConfig(): CircuitBreakerConfig {
  const routerConfig = loadRouterConfig();
  return {
    ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
    ...routerConfig.circuitBreaker,
  };
}

/**
 * Circuit Breaker config provider for NestJS DI
 */
export const CircuitBreakerConfigProvider = {
  provide: CIRCUIT_BREAKER_CONFIG,
  useFactory: createCircuitBreakerConfig,
};
