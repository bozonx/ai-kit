import { BaseValidator } from './config-validator.js';
import type { RouterConfig } from '../router-config.interface.js';

export class CircuitBreakerValidator extends BaseValidator<RouterConfig['circuitBreaker']> {
  public validate(value: unknown, path: string): asserts value is RouterConfig['circuitBreaker'] {
    if (value === undefined) {
      return;
    }

    this.assertType(value, 'object', path);

    const cb = value;

    if (cb.failureThreshold !== undefined) {
      this.assertNumber(cb.failureThreshold, `${path}.failureThreshold`, 1, 50);
    }

    if (cb.cooldownPeriodMins !== undefined) {
      this.assertNumber(cb.cooldownPeriodMins, `${path}.cooldownPeriodMins`, 0, 10080);
    }

    if (cb.successThreshold !== undefined) {
      this.assertNumber(cb.successThreshold, `${path}.successThreshold`, 1, 10);
    }

    if (cb.statsWindowSizeMins !== undefined) {
      this.assertNumber(cb.statsWindowSizeMins, `${path}.statsWindowSizeMins`, 0, 60);
    }
  }
}
