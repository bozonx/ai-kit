import { describe, it, expect } from '@jest/globals';
import {
  parseModelInput,
  hasMultipleModels,
} from '../../../../../src/modules/selector/utils/model-parser.js';

describe('model-parser', () => {
  describe('parseModelInput', () => {
    describe('empty/undefined input', () => {
      it('should return allowAutoFallback=true for undefined', () => {
        const result = parseModelInput(undefined);
        expect(result).toEqual({ models: [], allowAutoFallback: true });
      });

      it('should return allowAutoFallback=true for "auto"', () => {
        const result = parseModelInput('auto');
        expect(result).toEqual({ models: [], allowAutoFallback: true });
      });

      it('should return allowAutoFallback=true for empty string', () => {
        const result = parseModelInput('');
        expect(result).toEqual({ models: [], allowAutoFallback: true });
      });
    });

    describe('single model string', () => {
      it('should parse simple model name', () => {
        const result = parseModelInput('deepseek-r1');
        expect(result).toEqual({
          models: [{ name: 'deepseek-r1' }],
          allowAutoFallback: false,
        });
      });

      it('should parse model with provider prefix', () => {
        const result = parseModelInput('openrouter/deepseek-r1');
        expect(result).toEqual({
          models: [{ name: 'deepseek-r1', provider: 'openrouter' }],
          allowAutoFallback: false,
        });
      });

      it('should handle model name with multiple slashes', () => {
        // e.g., "openrouter/meta-llama/llama-3-8b" - first slash is provider
        const result = parseModelInput('openrouter/meta-llama/llama-3-8b');
        expect(result).toEqual({
          models: [{ name: 'meta-llama/llama-3-8b', provider: 'openrouter' }],
          allowAutoFallback: false,
        });
      });

      it('should handle whitespace', () => {
        const result = parseModelInput('  deepseek-r1  ');
        expect(result).toEqual({
          models: [{ name: 'deepseek-r1' }],
          allowAutoFallback: false,
        });
      });
    });

    describe('array input', () => {
      it('should parse array of simple model names', () => {
        const result = parseModelInput(['deepseek-r1', 'llama-3.3-70b']);
        expect(result).toEqual({
          models: [{ name: 'deepseek-r1' }, { name: 'llama-3.3-70b' }],
          allowAutoFallback: false,
        });
      });

      it('should parse array with provider prefixes', () => {
        const result = parseModelInput(['openrouter/deepseek-r1', 'deepseek/deepseek-chat']);
        expect(result).toEqual({
          models: [
            { name: 'deepseek-r1', provider: 'openrouter' },
            { name: 'deepseek-chat', provider: 'deepseek' },
          ],
          allowAutoFallback: false,
        });
      });

      it('should set allowAutoFallback=true when "auto" is in array', () => {
        const result = parseModelInput(['deepseek-r1', 'llama-3.3-70b', 'auto']);
        expect(result).toEqual({
          models: [{ name: 'deepseek-r1' }, { name: 'llama-3.3-70b' }],
          allowAutoFallback: true,
        });
      });

      it('should ignore items after "auto"', () => {
        const result = parseModelInput(['deepseek-r1', 'auto', 'should-be-ignored']);
        expect(result).toEqual({
          models: [{ name: 'deepseek-r1' }],
          allowAutoFallback: true,
        });
      });

      it('should handle "auto" case-insensitively', () => {
        const result = parseModelInput(['deepseek-r1', 'AUTO']);
        expect(result).toEqual({
          models: [{ name: 'deepseek-r1' }],
          allowAutoFallback: true,
        });
      });

      it('should handle mixed provider/no-provider models', () => {
        const result = parseModelInput([
          'openrouter/deepseek-r1',
          'llama-3.3-70b',
          'deepseek/deepseek-chat',
        ]);
        expect(result).toEqual({
          models: [
            { name: 'deepseek-r1', provider: 'openrouter' },
            { name: 'llama-3.3-70b' },
            { name: 'deepseek-chat', provider: 'deepseek' },
          ],
          allowAutoFallback: false,
        });
      });

      it('should skip empty strings in array', () => {
        const result = parseModelInput(['deepseek-r1', '', 'llama-3.3-70b']);
        expect(result).toEqual({
          models: [{ name: 'deepseek-r1' }, { name: 'llama-3.3-70b' }],
          allowAutoFallback: false,
        });
      });

      it('should handle array with only "auto"', () => {
        const result = parseModelInput(['auto']);
        expect(result).toEqual({
          models: [],
          allowAutoFallback: true,
        });
      });

      it('should handle empty array', () => {
        const result = parseModelInput([]);
        expect(result).toEqual({
          models: [],
          allowAutoFallback: false,
        });
      });
    });
  });

  describe('hasMultipleModels', () => {
    it('should return false for undefined', () => {
      expect(hasMultipleModels(undefined)).toBe(false);
    });

    it('should return false for string', () => {
      expect(hasMultipleModels('deepseek-r1')).toBe(false);
    });

    it('should return false for single-element array', () => {
      expect(hasMultipleModels(['deepseek-r1'])).toBe(false);
    });

    it('should return true for multi-element array', () => {
      expect(hasMultipleModels(['deepseek-r1', 'llama-3.3-70b'])).toBe(true);
    });

    it('should not count "auto" as a model', () => {
      expect(hasMultipleModels(['deepseek-r1', 'auto'])).toBe(false);
    });

    it('should return true for multiple models with auto', () => {
      expect(hasMultipleModels(['deepseek-r1', 'llama-3.3-70b', 'auto'])).toBe(true);
    });
  });
});
