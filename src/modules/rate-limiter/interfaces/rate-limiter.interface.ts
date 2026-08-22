/**
 * Token Bucket state for a limiter
 */
export interface TokenBucket {
  /**
   * Current number of tokens available
   */
  tokens: number;

  /**
   * Timestamp of last refill
   */
  lastRefill: number;

  /**
   * Maximum tokens (bucket capacity)
   */
  maxTokens: number;

  /**
   * Tokens added per millisecond
   */
  refillRate: number;
}

/**
 * Rate limit status for admin API
 */
export interface RateLimitStatus {
  enabled: boolean;
  requestsPerMinute?: number;
  activeBuckets: {
    models: number;
  };
}
