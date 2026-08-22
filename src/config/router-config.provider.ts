import { loadRouterConfig } from './router.config.js';
import type { RouterConfig } from './router-config.interface.js';

/**
 * Token for router configuration injection
 */
export const ROUTER_CONFIG = 'ROUTER_CONFIG';

/**
 * Provider factory for router configuration
 */
export const routerConfigProvider = {
  provide: ROUTER_CONFIG,
  useFactory: (): RouterConfig => loadRouterConfig(),
};
