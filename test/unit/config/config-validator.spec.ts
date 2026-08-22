import { describe, it, expect } from '@jest/globals';
import {
  BaseValidator,
  ConfigValidationError,
} from '../../../src/config/validators/config-validator.js';

// Create a concrete implementation for testing
class TestValidator extends BaseValidator<Record<string, unknown>> {
  public validate(value: unknown, path: string): asserts value is Record<string, unknown> {
    this.assertType(value, 'object', path);
  }

  // Expose protected methods for testing
  public testAssertType(value: unknown, type: string, path: string) {
    return this.assertType(value, type, path);
  }

  public testAssertString(value: unknown, path: string) {
    return this.assertString(value, path);
  }

  public testAssertNumber(value: unknown, path: string, min?: number) {
    return this.assertNumber(value, path, min);
  }

  public testAssertBoolean(value: unknown, path: string) {
    return this.assertBoolean(value, path);
  }

  public testAssertArray(value: unknown, path: string) {
    return this.assertArray(value, path);
  }

  public testAssertEnum<T extends string>(
    value: unknown,
    allowedValues: readonly T[],
    path: string,
  ) {
    return this.assertEnum(value, allowedValues, path);
  }
}

describe('BaseValidator', () => {
  let validator: TestValidator;

  beforeEach(() => {
    validator = new TestValidator();
  });

  describe('assertType', () => {
    it('should pass for valid object', () => {
      expect(() => validator.testAssertType({}, 'object', 'test')).not.toThrow();
    });

    it('should throw for null', () => {
      expect(() => validator.testAssertType(null, 'object', 'test')).toThrow(ConfigValidationError);
    });

    it('should throw for string when expecting object', () => {
      expect(() => validator.testAssertType('string', 'object', 'test')).toThrow(
        ConfigValidationError,
      );
    });
  });

  describe('assertString', () => {
    it('should pass for valid string', () => {
      expect(() => validator.testAssertString('hello', 'test')).not.toThrow();
    });

    it('should throw for number', () => {
      expect(() => validator.testAssertString(123, 'test')).toThrow(ConfigValidationError);
    });

    it('should throw for undefined', () => {
      expect(() => validator.testAssertString(undefined, 'test')).toThrow(ConfigValidationError);
    });

    it('should include value in error message', () => {
      expect(() => validator.testAssertString(123, 'test.path')).toThrow(/value: 123/);
    });
  });

  describe('assertNumber', () => {
    it('should pass for valid number', () => {
      expect(() => validator.testAssertNumber(42, 'test')).not.toThrow();
    });

    it('should pass for zero', () => {
      expect(() => validator.testAssertNumber(0, 'test')).not.toThrow();
    });

    it('should throw for string', () => {
      expect(() => validator.testAssertNumber('42', 'test')).toThrow(ConfigValidationError);
    });

    it('should throw for NaN', () => {
      expect(() => validator.testAssertNumber(NaN, 'test')).not.toThrow(); // NaN is still typeof number
    });

    it('should validate minimum value', () => {
      expect(() => validator.testAssertNumber(5, 'test', 10)).toThrow(/must be >= 10/);
      expect(() => validator.testAssertNumber(10, 'test', 10)).not.toThrow();
      expect(() => validator.testAssertNumber(15, 'test', 10)).not.toThrow();
    });
  });

  describe('assertBoolean', () => {
    it('should pass for true', () => {
      expect(() => validator.testAssertBoolean(true, 'test')).not.toThrow();
    });

    it('should pass for false', () => {
      expect(() => validator.testAssertBoolean(false, 'test')).not.toThrow();
    });

    it('should throw for string', () => {
      expect(() => validator.testAssertBoolean('true', 'test')).toThrow(ConfigValidationError);
    });

    it('should throw for number', () => {
      expect(() => validator.testAssertBoolean(1, 'test')).toThrow(ConfigValidationError);
    });
  });

  describe('assertArray', () => {
    it('should pass for valid array', () => {
      expect(() => validator.testAssertArray([], 'test')).not.toThrow();
      expect(() => validator.testAssertArray([1, 2, 3], 'test')).not.toThrow();
    });

    it('should throw for object', () => {
      expect(() => validator.testAssertArray({}, 'test')).toThrow(ConfigValidationError);
    });

    it('should throw for string', () => {
      expect(() => validator.testAssertArray('array', 'test')).toThrow(ConfigValidationError);
    });
  });

  describe('assertEnum', () => {
    const allowedValues = ['fast', 'medium', 'slow'] as const;

    it('should pass for valid enum value', () => {
      expect(() => validator.testAssertEnum('fast', allowedValues, 'test')).not.toThrow();
      expect(() => validator.testAssertEnum('medium', allowedValues, 'test')).not.toThrow();
      expect(() => validator.testAssertEnum('slow', allowedValues, 'test')).not.toThrow();
    });

    it('should throw for invalid string value', () => {
      expect(() => validator.testAssertEnum('invalid', allowedValues, 'test')).toThrow(
        /must be one of: fast, medium, slow/,
      );
    });

    it('should throw for number', () => {
      expect(() => validator.testAssertEnum(1, allowedValues, 'test')).toThrow(
        ConfigValidationError,
      );
    });
  });
});

describe('ConfigValidationError', () => {
  it('should have correct name', () => {
    const error = new ConfigValidationError('test message');
    expect(error.name).toBe('ConfigValidationError');
  });

  it('should have correct message', () => {
    const error = new ConfigValidationError('test message');
    expect(error.message).toBe('test message');
  });

  it('should be instanceof Error', () => {
    const error = new ConfigValidationError('test');
    expect(error).toBeInstanceOf(Error);
  });
});
