import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { ChatContentPartDto } from '../dto/chat-completion.request.dto.js';

/**
 * Validator for message content field
 * Accepts: string, array of ChatContentPartDto, or null
 */
@ValidatorConstraint({ name: 'isValidContent', async: false })
export class IsValidContentConstraint implements ValidatorConstraintInterface {
  public validate(content: unknown, _args: ValidationArguments): boolean {
    // Allow null
    if (content === null) {
      return true;
    }

    // Allow string
    if (typeof content === 'string') {
      return true;
    }

    // Allow array of content parts
    if (Array.isArray(content)) {
      return content.every(part => {
        if (typeof part !== 'object' || part === null) {
          return false;
        }

        const p = part as Record<string, any>;

        // Check type field
        if (p.type !== 'text' && p.type !== 'image_url') {
          return false;
        }

        // Validate text part
        if (p.type === 'text') {
          return typeof p.text === 'string';
        }

        // Validate image_url part
        if (p.type === 'image_url') {
          if (!p.image_url || typeof p.image_url !== 'object') {
            return false;
          }
          if (typeof p.image_url.url !== 'string') {
            return false;
          }
          // detail is optional
          if (
            p.image_url.detail !== undefined &&
            !['auto', 'high', 'low'].includes(p.image_url.detail)
          ) {
            return false;
          }
          return true;
        }

        return false;
      });
    }

    return false;
  }

  public defaultMessage(_args: ValidationArguments): string {
    return 'content must be a string, an array of content parts (text or image_url), or null';
  }
}

/**
 * Decorator for validating message content
 */
export function IsValidContent(validationOptions?: ValidationOptions) {
  return function (object: Object, propertyName: string) {
    registerDecorator({
      target: object.constructor,
      propertyName: propertyName,
      options: validationOptions,
      constraints: [],
      validator: IsValidContentConstraint,
    });
  };
}
