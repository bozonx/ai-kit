import { Injectable, OnModuleDestroy, Inject, Logger } from '@nestjs/common';
import { ROUTER_CONFIG } from '../../config/router-config.provider.js';
import type { RouterConfig } from '../../config/router-config.interface.js';
import type { RateLimitStatus, TokenBucket } from './interfaces/rate-limiter.interface.js';
import {
  STALE_BUCKET_THRESHOLD_MS,
  RATE_LIMITER_CLEANUP_INTERVAL_MS,
} from '../../common/constants/app.constants.js';

/**
 * Rate Limiter Service implementing Token Bucket algorithm.
 * Provides global, per-client, and per-model rate limiting.
 */
@Injectable()
export class RateLimiterService implements OnModuleDestroy {
  private readonly logger = new Logger(RateLimiterService.name);
  private readonly modelRequestsPerMinute?: number;

  // Token buckets for model limiter
  private readonly modelBuckets: Map<string, TokenBucket> = new Map();

  // Cleanup interval for stale buckets
  private cleanupIntervalId?: ReturnType<typeof setInterval>;

  constructor(@Inject(ROUTER_CONFIG) routerConfig: RouterConfig) {
    this.modelRequestsPerMinute = routerConfig.modelRequestsPerMinute;

    if (this.modelRequestsPerMinute) {
      this.logger.log(`Rate limiting enabled for models: ${this.modelRequestsPerMinute} req/min`);

      // Schedule cleanup of stale model buckets (unref to not block exit)
      this.cleanupIntervalId = setInterval(
        () => this.cleanupStaleBuckets(),
        RATE_LIMITER_CLEANUP_INTERVAL_MS,
      );
      this.cleanupIntervalId.unref();
    }
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
   * Check if rate limiting is enabled
   */
  public isEnabled(): boolean {
    return !!this.modelRequestsPerMinute;
  }

  /**
   * Check per-model rate limit
   * @param modelName Model name
   * @returns true if allowed, false if rate limited
   */
  public checkModel(modelName: string): boolean {
    if (!this.modelRequestsPerMinute) return true;

    let bucket = this.modelBuckets.get(modelName);
    if (!bucket) {
      const rpm = this.modelRequestsPerMinute;
      bucket = this.createBucket(rpm, rpm);
      this.modelBuckets.set(modelName, bucket);
    }

    return this.tryConsume(bucket);
  }

  /**
   * Get current rate limiting status
   */
  public getStatus(): RateLimitStatus {
    return {
      enabled: !!this.modelRequestsPerMinute,
      requestsPerMinute: this.modelRequestsPerMinute,
      activeBuckets: {
        models: this.modelBuckets.size,
      },
    };
  }

  /**
   * Create a new token bucket
   */
  private createBucket(requestsPerMinute: number, maxTokens: number): TokenBucket {
    // Convert requests per minute to refill rate (tokens per millisecond)
    const refillRate = requestsPerMinute / 60000;

    return {
      tokens: maxTokens,
      lastRefill: Date.now(),
      maxTokens,
      refillRate,
    };
  }

  /**
   * Try to consume a token from the bucket
   * @returns true if token consumed, false if bucket empty
   */
  private tryConsume(bucket: TokenBucket): boolean {
    this.refillBucket(bucket);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }

    return false;
  }

  /**
   * Refill tokens based on elapsed time
   */
  private refillBucket(bucket: TokenBucket): void {
    const now = Date.now();
    const elapsed = now - bucket.lastRefill;
    const tokensToAdd = elapsed * bucket.refillRate;

    bucket.tokens = Math.min(bucket.maxTokens, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;
  }

  /**
   * Clean up buckets that haven't been used in a while
   */
  private cleanupStaleBuckets(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [modelName, bucket] of this.modelBuckets.entries()) {
      if (now - bucket.lastRefill > STALE_BUCKET_THRESHOLD_MS) {
        this.modelBuckets.delete(modelName);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.logger.debug(`Cleaned up ${cleaned} stale rate limit buckets`);
    }
  }
}
