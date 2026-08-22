import { BaseValidator } from './config-validator.js';
import type { RouterConfig } from '../router-config.interface.js';

export class ProviderValidator extends BaseValidator<RouterConfig['providers']> {
  public validate(value: unknown, path: string): asserts value is RouterConfig['providers'] {
    this.assertType(value, 'object', path);

    const providers = value;

    for (const [providerName, providerConfig] of Object.entries(providers)) {
      this.validateProvider(providerConfig, `${path}.${providerName}`);
    }
  }

  private validateProvider(value: unknown, path: string): void {
    this.assertType(value, 'object', path);

    const config = value;

    this.assertBoolean(config.enabled, `${path}.enabled`);
    this.assertString(config.apiKey, `${path}.apiKey`);
    if (config.baseUrl !== undefined) {
      this.assertString(config.baseUrl, `${path}.baseUrl`);
    }
  }
}
