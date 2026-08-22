/**
 * Provider configuration
 */
export interface ProviderConfig {
  /**
   * Provider enabled status
   */
  enabled: boolean;

  /**
   * Provider API key
   */
  apiKey: string;

  /**
   * Provider base URL (optional, defaults will be used if not provided)
   */
  baseUrl?: string;
}

/**
 * Fallback configuration
 */
export interface FallbackConfig {
  /**
   * Fallback enabled status
   */
  enabled: boolean;

  /**
   * Provider to use for fallback
   */
  provider: string;

  /**
   * Model to use for fallback
   */
  model: string;
}

/**
 * Routing configuration
 */
export interface RoutingConfig {
  /**
   * Maximum number of model switches (trying different models)
   */
  maxModelSwitches: number;

  /**
   * Maximum retries on the same model for temporary errors (429 rate limit, network issues)
   */
  maxSameModelRetries: number;

  /**
   * Retry delay in milliseconds (only for rate limit retries on the same model)
   */
  retryDelay: number;

  /**
   * Request timeout in seconds
   */
  timeoutSecs: number;

  /**
   * Fallback configuration
   */
  fallback: FallbackConfig;
}

/**
 * Circuit Breaker configuration (optional, has defaults)
 */
export interface CircuitBreakerConfig {
  /**
   * Number of consecutive failures to open circuit (default: 3)
   */
  failureThreshold?: number;

  /**
   * Cooldown period in minutes before trying HALF_OPEN (default: 3)
   */
  cooldownPeriodMins?: number;

  /**
   * Number of consecutive successes to close circuit from HALF_OPEN (default: 2)
   */
  successThreshold?: number;

  /**
   * Statistics sliding window size in minutes (default: 10)
   */
  statsWindowSizeMins?: number;
}

/**
 * Model override configuration
 */
export interface ModelOverrideConfig {
  /**
   * Unified model name (required for identification)
   */
  name: string;

  /**
   * Provider name (optional, for identification/verification)
   */
  provider?: string;

  /**
   * Real model ID (optional, for identification/verification)
   */
  model?: string;

  /**
   * Override weight for selection (1-100)
   * Higher weight = more likely to be selected
   */
  weight?: number;

  /**
   * Override tags
   */
  tags?: string[];

  /**
   * Override context size
   */
  contextSize?: number;

  /**
   * Override max output tokens
   */
  maxOutputTokens?: number;

  /**
   * Override availability
   */
  available?: boolean;

  /**
   * Override JSON response support
   */
  jsonResponse?: boolean;

  /**
   * Override image input support
   */
  supportsImage?: boolean;

  /**
   * Override video input support
   */
  supportsVideo?: boolean;

  /**
   * Override audio input support
   */
  supportsAudio?: boolean;

  /**
   * Override file/document input support
   */
  supportsFile?: boolean;

  /**
   * Override tools/function calling support
   */
  supportsTools?: boolean;
}

/**
 * Router configuration
 */
export interface RouterConfig {
  /**
   * Path to models file or URL (http/https)
   * Examples:
   *   - ./models.yaml (local file)
   *   - https://example.com/models.yaml (remote file)
   */
  modelsFile: string;

  /**
   * Provider configurations
   */
  providers: Record<string, ProviderConfig>;

  /**
   * Routing configuration
   */
  routing: RoutingConfig;

  /**
   * Circuit Breaker configuration (optional)
   */
  circuitBreaker?: CircuitBreakerConfig;

  /**
   * Model priority/weight overrides (optional)
   */
  modelOverrides?: ModelOverrideConfig[];

  /**
   * Global model rate limit (requests per minute per model)
   * Protection against skew/overload of specific models
   */
  modelRequestsPerMinute?: number;
}
