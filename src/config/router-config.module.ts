import { Module, Global } from '@nestjs/common';
import { routerConfigProvider } from './router-config.provider.js';

/**
 * Global module for router configuration
 * Provides ROUTER_CONFIG token to all modules
 */
@Global()
@Module({
  providers: [routerConfigProvider],
  exports: [routerConfigProvider],
})
export class RouterConfigModule {}
