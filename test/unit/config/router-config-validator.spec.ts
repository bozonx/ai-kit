import { describe, it, expect, beforeEach } from '@jest/globals';
import { RouterConfigValidator } from '../../../src/config/validators/router-config-validator.js';
import { ConfigValidationError } from '../../../src/config/validators/config-validator.js';

describe('RouterConfigValidator', () => {
  let validator: RouterConfigValidator;

  beforeEach(() => {
    validator = new RouterConfigValidator();
  });

  const createValidConfig = () => ({
    modelsFile: './models.yaml',
    providers: {
      openrouter: {
        enabled: true,
        apiKey: 'test-key',
        baseUrl: 'https://openrouter.ai/api/v1',
      },
      deepseek: {
        enabled: true,
        apiKey: 'test-key',
        baseUrl: 'https://api.deepseek.com',
      },
    },
    routing: {
      maxModelSwitches: 3,
      maxSameModelRetries: 2,
      retryDelay: 1000,
      timeoutSecs: 30,
      fallback: {
        enabled: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
      },
    },
  });

  describe('valid configurations', () => {
    it('should validate a minimal valid config', () => {
      const config = createValidConfig();
      expect(() => validator.validate(config)).not.toThrow();
    });

    it('should validate config with disabled fallback', () => {
      const config = createValidConfig();
      config.routing.fallback.enabled = false;
      expect(() => validator.validate(config)).not.toThrow();
    });

    it('should validate config with circuitBreaker', () => {
      const config = {
        ...createValidConfig(),
        circuitBreaker: {
          failureThreshold: 5,
          cooldownPeriodMins: 2,
          successThreshold: 3,
          statsWindowSizeMins: 10,
        },
      };
      expect(() => validator.validate(config)).not.toThrow();
    });

    it('should validate config with modelOverrides', () => {
      const config = {
        ...createValidConfig(),
        modelOverrides: [
          {
            name: 'llama-3.3-70b',
            weight: 10,
          },
          {
            name: 'deepseek-r1',
            provider: 'openrouter',
            available: false,
          },
        ],
      };
      expect(() => validator.validate(config)).not.toThrow();
    });

    it('should validate config with modelRequestsPerMinute', () => {
      const config = {
        ...createValidConfig(),
        modelRequestsPerMinute: 30,
      };
      expect(() => validator.validate(config)).not.toThrow();
    });

    it('should reject invalid modelRequestsPerMinute', () => {
      const config = {
        ...createValidConfig(),
        modelRequestsPerMinute: -5,
      };
      expect(() => validator.validate(config)).toThrow(
        'RouterConfig.modelRequestsPerMinute must be >= 1',
      );
    });

    it('should validate config with missing baseUrl', () => {
      const config = createValidConfig();
      // @ts-expect-error - testing optional field
      delete config.providers.openrouter.baseUrl;
      expect(() => validator.validate(config)).not.toThrow();
    });
  });

  describe('invalid configurations', () => {
    it('should reject missing apiKey', () => {
      const config = createValidConfig();
      // @ts-expect-error - testing required field
      delete config.providers.openrouter.apiKey;
      expect(() => validator.validate(config)).toThrow(ConfigValidationError);
    });
    it('should reject missing modelsFile', () => {
      const config = createValidConfig();
      delete (config as Record<string, unknown>).modelsFile;
      expect(() => validator.validate(config)).toThrow(ConfigValidationError);
    });

    it('should reject missing providers', () => {
      const config = createValidConfig();
      delete (config as Record<string, unknown>).providers;
      expect(() => validator.validate(config)).toThrow(ConfigValidationError);
    });

    it('should reject missing routing', () => {
      const config = createValidConfig();
      delete (config as Record<string, unknown>).routing;
      expect(() => validator.validate(config)).toThrow(ConfigValidationError);
    });

    it('should reject non-object config', () => {
      expect(() => validator.validate(null)).toThrow(ConfigValidationError);
      expect(() => validator.validate('string')).toThrow(ConfigValidationError);
      expect(() => validator.validate(123)).toThrow(ConfigValidationError);
    });
  });

  describe('fallback provider validation', () => {
    it('should reject fallback with non-existent provider', () => {
      const config = createValidConfig();
      config.routing.fallback.provider = 'unknown-provider';
      expect(() => validator.validate(config)).toThrow(
        'Provider "unknown-provider" is not configured in providers section',
      );
    });

    it('should reject fallback with disabled provider', () => {
      const config = createValidConfig();
      config.providers.deepseek.enabled = false;
      expect(() => validator.validate(config)).toThrow('Provider "deepseek" is disabled');
    });

    it('should allow any fallback provider when fallback is disabled', () => {
      const config = createValidConfig();
      config.routing.fallback.enabled = false;
      config.routing.fallback.provider = 'unknown-provider';
      expect(() => validator.validate(config)).not.toThrow();
    });
  });

  describe('modelOverrides validation', () => {
    it('should reject override without name', () => {
      const config = {
        ...createValidConfig(),
        modelOverrides: [{ weight: 2 }],
      };
      expect(() => validator.validate(config)).toThrow(ConfigValidationError);
    });

    it('should reject override with invalid weight type', () => {
      const config = {
        ...createValidConfig(),
        modelOverrides: [{ name: 'test', weight: 'heavy' }],
      };
      expect(() => validator.validate(config)).toThrow(ConfigValidationError);
    });

    it('should reject override with invalid tags type', () => {
      const config = {
        ...createValidConfig(),
        modelOverrides: [{ name: 'test', tags: 'code' }],
      };
      expect(() => validator.validate(config)).toThrow(ConfigValidationError);
    });
  });
});
