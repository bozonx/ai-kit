import { Module, Global } from '@nestjs/common';
import { RateLimiterService } from './rate-limiter.service.js';
import { routerConfigProvider } from '../../config/router-config.provider.js';

/**
 * Rate Limiter Module.
 * Provides Token Bucket based rate limiting.
 * Global module to make RateLimiterService available everywhere.
 */
@Global()
@Module({
  providers: [routerConfigProvider, RateLimiterService],
  exports: [RateLimiterService],
})
export class RateLimiterModule {}
