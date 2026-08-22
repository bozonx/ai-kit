/**
 * Circuit Breaker state enumeration
 */
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN' | 'PERMANENTLY_UNAVAILABLE';

/**
 * Single request record for sliding window statistics
 */
export interface RequestRecord {
  /** Request timestamp */
  timestamp: number;

  /** Request latency in milliseconds */
  latencyMs: number;

  /** Whether request was successful */
  success: boolean;
}

/**
 * Model statistics for sliding window
 */
export interface ModelStats {
  /** Total requests in window */
  totalRequests: number;

  /** Total requests since service start */
  lifetimeTotalRequests: number;

  /** Successful requests count */
  successCount: number;

  /** Failed requests count */
  errorCount: number;

  /** Average latency in milliseconds */
  avgLatency: number;

  /** P95 latency in milliseconds */
  p95Latency: number;

  /** Success rate (0-1) */
  successRate: number;

  /** Request records for sliding window */
  requests: RequestRecord[];
}

/**
 * Model state for Circuit Breaker and statistics
 */
export interface ModelState {
  /** Model name */
  name: string;

  /** Circuit Breaker state */
  circuitState: CircuitState;

  /** Timestamp when circuit opened (for cooldown calculation) */
  openedAt?: number;

  /** Consecutive failure count */
  consecutiveFailures: number;

  /** Consecutive success count (for HALF_OPEN recovery) */
  consecutiveSuccesses: number;

  /** Statistics for sliding window */
  stats: ModelStats;

  /** Reason for PERMANENTLY_UNAVAILABLE state */
  unavailableReason?: string;
}

/**
 * Circuit Breaker configuration
 */
export interface CircuitBreakerConfig {
  /** Number of failures to open circuit (default: 3) */
  failureThreshold: number;

  /**
   * Cooldown period in minutes before trying HALF_OPEN (default: 3)
   */
  cooldownPeriodMins: number;

  /** Number of successes to close circuit from HALF_OPEN (default: 2) */
  successThreshold: number;

  /**
   * Statistics sliding window size in minutes (default: 10)
   */
  statsWindowSizeMins: number;
}

/**
 * Default Circuit Breaker configuration values
 */
export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  cooldownPeriodMins: 3,
  successThreshold: 2,
  statsWindowSizeMins: 10,
};
