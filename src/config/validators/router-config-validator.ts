import { BaseValidator } from './config-validator.js';
import { ProviderValidator } from './provider-validator.js';
import { RoutingValidator } from './routing-validator.js';
import { CircuitBreakerValidator } from './circuit-breaker-validator.js';
import type { RouterConfig } from '../router-config.interface.js';

export class RouterConfigValidator extends BaseValidator<RouterConfig> {
  private readonly providerValidator: ProviderValidator = new ProviderValidator();
  private readonly routingValidator: RoutingValidator = new RoutingValidator();
  private readonly circuitBreakerValidator: CircuitBreakerValidator = new CircuitBreakerValidator();

  public validate(value: unknown, path = 'RouterConfig'): asserts value is RouterConfig {
    this.assertType(value, 'object', path);

    const config = value;

    this.assertString(config.modelsFile, `${path}.modelsFile`);
    this.providerValidator.validate(config.providers, `${path}.providers`);
    this.routingValidator.validate(config.routing, `${path}.routing`);
    this.circuitBreakerValidator.validate(config.circuitBreaker, `${path}.circuitBreaker`);

    if (config.modelRequestsPerMinute !== undefined) {
      this.assertNumber(config.modelRequestsPerMinute, `${path}.modelRequestsPerMinute`, 1, 10000);
    }

    // Cross-validation: ensure fallback provider is configured and enabled
    this.validateFallbackProvider(config, path);

    if (config.modelOverrides !== undefined) {
      this.validateModelOverrides(config.modelOverrides, `${path}.modelOverrides`);
    }
  }

  /**
   * Validate that fallback provider is properly configured
   */
  private validateFallbackProvider(config: Record<string, unknown>, path: string): void {
    const routing = config.routing as Record<string, unknown>;
    const fallback = routing?.fallback as Record<string, unknown>;
    const providers = config.providers as Record<string, Record<string, unknown>>;

    // Skip validation if fallback is disabled
    if (!fallback?.enabled) {
      return;
    }

    const providerName = fallback.provider as string;
    const provider = providers?.[providerName];

    if (!provider) {
      throw new Error(
        `${path}.routing.fallback.provider: Provider "${providerName}" is not configured in providers section`,
      );
    }

    if (!provider.enabled) {
      throw new Error(
        `${path}.routing.fallback.provider: Provider "${providerName}" is disabled. Enable it or use a different fallback provider.`,
      );
    }
  }

  private validateModelOverrides(value: unknown, path: string): void {
    this.assertArray(value, path);

    const overrides = value;

    for (const [index, override] of overrides.entries()) {
      this.validateModelOverride(override, `${path}[${index}]`);
    }
  }

  private validateModelOverride(value: unknown, path: string): void {
    this.assertType(value, 'object', path);

    const override = value;

    this.assertString(override.name, `${path}.name`);

    if (override.provider !== undefined) {
      this.assertString(override.provider, `${path}.provider`);
    }

    if (override.model !== undefined) {
      this.assertString(override.model, `${path}.model`);
    }

    if (override.weight !== undefined) {
      this.assertNumber(override.weight, `${path}.weight`);
    }

    if (override.tags !== undefined) {
      this.assertArray(override.tags, `${path}.tags`);
    }

    if (override.contextSize !== undefined) {
      this.assertNumber(override.contextSize, `${path}.contextSize`);
    }

    if (override.maxOutputTokens !== undefined) {
      this.assertNumber(override.maxOutputTokens, `${path}.maxOutputTokens`);
    }

    if (override.available !== undefined) {
      this.assertBoolean(override.available, `${path}.available`);
    }
  }
}
