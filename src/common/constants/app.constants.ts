/**
 * Global application constants
 */

/**
 * Graceful shutdown timeout in milliseconds.
 * Requests will be cancelled after this duration during shutdown.
 */
export const SHUTDOWN_TIMEOUT_MS = 25_000;

/**
 * Stale bucket cleanup threshold in milliseconds (10 minutes).
 * Rate limiter buckets not used within this time will be removed.
 */
export const STALE_BUCKET_THRESHOLD_MS = 600_000;

/**
 * Fetch timeout for loading models from URL in milliseconds (30 seconds)
 */
export const MODELS_FETCH_TIMEOUT_MS = 30_000;

/**
 * Cleanup interval for stale data in milliseconds (1 minute)
 */
export const STATE_CLEANUP_INTERVAL_MS = 60_000;

/**
 * Rate limiter cleanup interval in milliseconds (5 minutes)
 */
export const RATE_LIMITER_CLEANUP_INTERVAL_MS = 300_000;
