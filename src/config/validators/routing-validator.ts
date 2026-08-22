import { BaseValidator } from './config-validator.js';
import type { RouterConfig } from '../router-config.interface.js';

export class RoutingValidator extends BaseValidator<RouterConfig['routing']> {
  public validate(value: unknown, path: string): asserts value is RouterConfig['routing'] {
    this.assertType(value, 'object', path);

    const routing = value;

    this.assertNumber(routing.maxModelSwitches, `${path}.maxModelSwitches`, 0, 10);
    this.assertNumber(routing.maxSameModelRetries, `${path}.maxSameModelRetries`, 0, 10);
    this.assertNumber(routing.retryDelay, `${path}.retryDelay`, 0, 30000);
    this.assertNumber(routing.timeoutSecs, `${path}.timeoutSecs`, 0, 600);

    this.validateFallback(routing.fallback, `${path}.fallback`);
  }

  private validateFallback(value: unknown, path: string): void {
    this.assertType(value, 'object', path);

    const fallback = value;

    this.assertBoolean(fallback.enabled, `${path}.enabled`);
    this.assertString(fallback.provider, `${path}.provider`);
    this.assertString(fallback.model, `${path}.model`);
  }
}
