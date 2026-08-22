export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export abstract class BaseValidator<T> {
  public abstract validate(value: unknown, path: string): asserts value is T;

  protected assertType(
    value: unknown,
    type: string,
    path: string,
  ): asserts value is Record<string, unknown> {
    if (typeof value !== type || value === null) {
      throw new ConfigValidationError(
        `${path} must be ${type === 'object' ? 'an object' : `a ${type}`}, got ${typeof value === 'object' && value === null ? 'null' : typeof value}`,
      );
    }
  }

  protected assertString(value: unknown, path: string): asserts value is string {
    if (typeof value !== 'string') {
      throw new ConfigValidationError(
        `${path} must be a string, got ${typeof value} (value: ${String(value)})`,
      );
    }
  }

  protected assertNumber(
    value: unknown,
    path: string,
    min?: number,
    max?: number,
  ): asserts value is number {
    if (typeof value !== 'number') {
      throw new ConfigValidationError(
        `${path} must be a number, got ${typeof value} (value: ${String(value)})`,
      );
    }
    if (min !== undefined && value < min) {
      throw new ConfigValidationError(`${path} must be >= ${min}, got ${value}`);
    }
    if (max !== undefined && value > max) {
      throw new ConfigValidationError(`${path} must be <= ${max}, got ${value}`);
    }
  }

  protected assertBoolean(value: unknown, path: string): asserts value is boolean {
    if (typeof value !== 'boolean') {
      throw new ConfigValidationError(
        `${path} must be a boolean, got ${typeof value} (value: ${String(value)})`,
      );
    }
  }

  protected assertArray(value: unknown, path: string): asserts value is unknown[] {
    if (!Array.isArray(value)) {
      throw new ConfigValidationError(`${path} must be an array, got ${typeof value}`);
    }
  }

  protected assertEnum<T extends string>(
    value: unknown,
    allowedValues: readonly T[],
    path: string,
  ): asserts value is T {
    if (typeof value !== 'string' || !allowedValues.includes(value as T)) {
      throw new ConfigValidationError(
        `${path} must be one of: ${allowedValues.join(', ')}, got ${typeof value === 'string' ? `"${value}"` : typeof value}`,
      );
    }
  }
}
