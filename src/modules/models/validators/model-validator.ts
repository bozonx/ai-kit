export class ModelValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelValidationError';
  }
}

export class ModelValidator {
  private static readonly VALID_TYPES = ['fast', 'reasoning'] as const;

  public static validateRequired(model: Record<string, unknown>): void {
    this.assertString(model.name, 'name');
    this.assertString(model.provider, 'provider');
    this.assertString(model.model, 'model');
    this.assertEnum(model.type, this.VALID_TYPES, 'type');
    this.assertPositiveNumber(model.contextSize, 'contextSize');
    this.assertPositiveNumber(model.maxOutputTokens, 'maxOutputTokens');
    this.assertArray(model.tags, 'tags');
    this.assertBoolean(model.jsonResponse, 'jsonResponse');
    this.assertBoolean(model.available, 'available');
  }

  public static validateOptional(model: Record<string, unknown>): void {
    if (model.weight !== undefined) {
      this.assertNumberInRange(model.weight, 1, 100, 'weight');
    }
  }

  private static assertString(value: unknown, fieldName: string): asserts value is string {
    if (typeof value !== 'string' || !value) {
      throw new ModelValidationError(`Model "${fieldName}" must be a non-empty string`);
    }
  }

  private static assertBoolean(value: unknown, fieldName: string): asserts value is boolean {
    if (typeof value !== 'boolean') {
      throw new ModelValidationError(`Model "${fieldName}" must be a boolean`);
    }
  }

  private static assertArray(value: unknown, fieldName: string): asserts value is unknown[] {
    if (!Array.isArray(value)) {
      throw new ModelValidationError(`Model "${fieldName}" must be an array`);
    }
  }

  private static assertPositiveNumber(value: unknown, fieldName: string): asserts value is number {
    if (typeof value !== 'number' || value <= 0) {
      throw new ModelValidationError(`Model "${fieldName}" must be a positive number`);
    }
  }

  private static assertNonNegativeNumber(
    value: unknown,
    fieldName: string,
  ): asserts value is number {
    if (typeof value !== 'number' || value < 0) {
      throw new ModelValidationError(`Model "${fieldName}" must be a non-negative number`);
    }
  }

  private static assertNumberInRange(
    value: unknown,
    min: number,
    max: number,
    fieldName: string,
  ): asserts value is number {
    if (typeof value !== 'number' || value < min || value > max) {
      throw new ModelValidationError(
        `Model "${fieldName}" must be a number between ${min} and ${max}`,
      );
    }
  }

  private static assertEnum<T extends string>(
    value: unknown,
    allowedValues: readonly T[],
    fieldName: string,
  ): asserts value is T {
    if (typeof value !== 'string' || !allowedValues.includes(value as T)) {
      throw new ModelValidationError(
        `Model "${fieldName}" must be one of: ${allowedValues.join(', ')}`,
      );
    }
  }
}
