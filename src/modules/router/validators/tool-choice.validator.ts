import {
  registerDecorator,
  type ValidationOptions,
  type ValidationArguments,
} from 'class-validator';

/**
 * Custom validator for tool_choice field
 * Validates that tool_choice is either 'auto', 'none', or a valid function selection object
 */
export function IsValidToolChoice(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isValidToolChoice',
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          if (value === undefined || value === null) {
            return true; // Optional field
          }

          // String values: 'auto' or 'none'
          if (typeof value === 'string') {
            return value === 'auto' || value === 'none';
          }

          // Object value: { type: 'function', function: { name: string } }
          if (typeof value === 'object' && value !== null) {
            const obj = value as Record<string, any>;
            return (
              obj.type === 'function' &&
              typeof obj.function === 'object' &&
              obj.function !== null &&
              typeof obj.function.name === 'string' &&
              obj.function.name.length > 0
            );
          }

          return false;
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} must be "auto", "none", or { type: "function", function: { name: string } }`;
        },
      },
    });
  };
}
