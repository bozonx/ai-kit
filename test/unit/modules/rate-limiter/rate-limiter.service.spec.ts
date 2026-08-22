import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Test, type TestingModule } from '@nestjs/testing';
import { RateLimiterService } from '../../../../src/modules/rate-limiter/rate-limiter.service.js';
import { ROUTER_CONFIG } from '../../../../src/config/router-config.provider.js';
import type { RouterConfig } from '../../../../src/config/router-config.interface.js';

describe('RateLimiterService', () => {
  let service: RateLimiterService;

  const createMockConfig = (modelRequestsPerMinute?: number): RouterConfig => ({
    modelsFile: './models.yaml',
    providers: {
      openrouter: { enabled: true, apiKey: 'test', baseUrl: 'https://test.com' },
    },
    routing: {
      maxModelSwitches: 3,
      maxSameModelRetries: 2,
      retryDelay: 100,
      timeoutSecs: 30,
      fallback: { enabled: false, provider: 'deepseek', model: 'deepseek-chat' },
    },
    modelRequestsPerMinute,
  });

  afterEach(() => {
    if (service) {
      service.onModuleDestroy();
    }
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  describe('when rate limiting is disabled (no limit configured)', () => {
    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RateLimiterService,
          { provide: ROUTER_CONFIG, useValue: createMockConfig(undefined) },
        ],
      }).compile();

      service = module.get<RateLimiterService>(RateLimiterService);
    });

    it('should not be enabled', () => {
      expect(service.isEnabled()).toBe(false);
    });

    it('should always allow model requests', () => {
      expect(service.checkModel('model-1')).toBe(true);
      expect(service.checkModel('model-2')).toBe(true);
    });
  });

  describe('when rate limiting is enabled', () => {
    const REQUESTS_PER_MINUTE = 10;

    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RateLimiterService,
          { provide: ROUTER_CONFIG, useValue: createMockConfig(REQUESTS_PER_MINUTE) },
        ],
      }).compile();

      service = module.get<RateLimiterService>(RateLimiterService);
    });

    it('should be enabled', () => {
      expect(service.isEnabled()).toBe(true);
    });

    describe('per-model rate limit', () => {
      it('should track models separately', () => {
        // Each model has 10 tokens
        for (let i = 0; i < 10; i++) {
          expect(service.checkModel('model-1')).toBe(true);
        }

        // model-1 exhausted
        expect(service.checkModel('model-1')).toBe(false);

        // model-2 still has tokens
        expect(service.checkModel('model-2')).toBe(true);
      });

      it('should return status correctly', () => {
        service.checkModel('model-1');
        const status = service.getStatus();
        expect(status.enabled).toBe(true);
        expect(status.requestsPerMinute).toBe(REQUESTS_PER_MINUTE);
        expect(status.activeBuckets.models).toBeGreaterThan(0);
      });
    });
  });

  describe('token bucket refill', () => {
    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          RateLimiterService,
          {
            provide: ROUTER_CONFIG,
            useValue: createMockConfig(60000), // 1000 requests per second
          },
        ],
      }).compile();

      service = module.get<RateLimiterService>(RateLimiterService);
    });

    it('should refill tokens over time', async () => {
      jest.useFakeTimers();
      // Consume some tokens
      for (let i = 0; i < 1000; i++) {
        service.checkModel('refill-model');
      }

      // Wait a bit for tokens to refill (at 1000/sec, 20ms = 20 tokens)
      jest.advanceTimersByTime(20);

      // Should have some tokens now
      expect(service.checkModel('refill-model')).toBe(true);
    });
  });
});
