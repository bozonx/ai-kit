import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Test, type TestingModule } from '@nestjs/testing';
import { SmartStrategy } from '../../../../src/modules/selector/strategies/smart.strategy.js';
import { StateService } from '../../../../src/modules/state/state.service.js';
import { CircuitBreakerService } from '../../../../src/modules/state/circuit-breaker.service.js';
import { ROUTER_CONFIG } from '../../../../src/config/router-config.provider.js';
import type { ModelDefinition } from '../../../../src/modules/models/interfaces/model.interface.js';
import type { RouterConfig } from '../../../../src/config/router-config.interface.js';

describe('SmartStrategy', () => {
  let strategy: SmartStrategy;
  let stateService: jest.Mocked<StateService>;
  let circuitBreaker: jest.Mocked<CircuitBreakerService>;

  const mockModels: ModelDefinition[] = [
    {
      name: 'model-high-weight',
      provider: 'openrouter',
      model: 'test/model-1',
      type: 'fast',
      contextSize: 128000,
      maxOutputTokens: 4096,
      tags: ['general'],
      jsonResponse: true,
      available: true,
      weight: 10,
    },
    {
      name: 'model-low-weight',
      provider: 'openrouter',
      model: 'test/model-2',
      type: 'reasoning',
      contextSize: 64000,
      maxOutputTokens: 8192,
      tags: ['code'],
      jsonResponse: false,
      available: true,
      weight: 5,
    },
    {
      name: 'model-with-max-concurrent',
      provider: 'deepseek',
      model: 'test/model-3',
      type: 'fast',
      contextSize: 32000,
      maxOutputTokens: 4096,
      tags: ['general'],
      jsonResponse: true,
      available: true,
      weight: 1,
      maxConcurrent: 2,
    },
  ];

  const mockRouterConfig: RouterConfig = {
    modelsFile: './models.yaml',
    providers: {
      openrouter: { enabled: true, apiKey: 'test', baseUrl: 'https://test.com' },
    },
    routing: {
      maxModelSwitches: 3,
      maxSameModelRetries: 2,
      retryDelay: 1000,
      timeoutSecs: 30,
      fallback: { enabled: true, provider: 'deepseek', model: 'deepseek-chat' },
    },
    modelOverrides: [
      {
        name: 'model-low-weight',
        weight: 20,
      },
    ],
  };

  const createMockState = (overrides: Partial<ReturnType<StateService['getState']>> = {}) => ({
    name: 'test-model',
    circuitState: 'CLOSED' as const,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    stats: {
      totalRequests: 0,
      successCount: 0,
      errorCount: 0,
      avgLatency: 0,
      p95Latency: 0,
      successRate: 1.0,
      requests: [],
    },
    ...overrides,
  });

  beforeEach(async () => {
    stateService = {
      getState: jest
        .fn()
        .mockImplementation((name: unknown) => createMockState({ name: String(name) })),
    } as any;

    circuitBreaker = {
      filterAvailable: jest.fn().mockImplementation(models => models),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SmartStrategy,
        { provide: StateService, useValue: stateService },
        { provide: CircuitBreakerService, useValue: circuitBreaker },
        { provide: ROUTER_CONFIG, useValue: mockRouterConfig },
      ],
    }).compile();

    strategy = module.get<SmartStrategy>(SmartStrategy);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('select', () => {
    it('should return null for empty models list', () => {
      const result = strategy.select([], {});
      expect(result).toBeNull();
    });

    it('should filter excluded models', () => {
      circuitBreaker.filterAvailable.mockImplementation(models => models);

      const result = strategy.select(mockModels, {
        excludeModels: ['model-high-weight', 'model-with-max-concurrent'],
      });

      expect(result?.name).toBe('model-low-weight');
    });

    it('should use Circuit Breaker filtering', () => {
      circuitBreaker.filterAvailable.mockReturnValue([mockModels[1]]);

      const result = strategy.select(mockModels, {});

      expect(circuitBreaker.filterAvailable).toHaveBeenCalled();
      expect(result?.name).toBe('model-low-weight');
    });

    it('should filter by minSuccessRate', () => {
      stateService.getState.mockImplementation((name: string) => {
        if (name === 'model-high-weight') {
          return createMockState({
            name,
            stats: { ...createMockState().stats, totalRequests: 10, successRate: 0.5 },
          });
        }
        return createMockState({
          name,
          stats: { ...createMockState().stats, totalRequests: 10, successRate: 0.9 },
        });
      });

      const result = strategy.select(mockModels, { minSuccessRate: 0.8 });

      expect(result?.name).not.toBe('model-high-weight');
    });

    it('should select fastest model when preferFast is true', () => {
      stateService.getState.mockImplementation((name: string) => {
        const latencies: Record<string, number> = {
          'model-high-weight': 500,
          'model-low-weight': 100,
          'model-with-max-concurrent': 300,
        };
        return createMockState({
          name,
          stats: {
            ...createMockState().stats,
            totalRequests: 10,
            avgLatency: latencies[name] ?? 200,
          },
        });
      });

      const result = strategy.select(mockModels, { preferFast: true });

      expect(result?.name).toBe('model-low-weight');
    });

    it('should respect model weights for selection', () => {
      // Simulate models with overrides applied (e.g. by ModelsService)
      const models = [
        { ...mockModels[0] }, // W=10
        { ...mockModels[1], weight: 20 }, // Override applied: W=5->20
      ];

      stateService.getState.mockImplementation((name: string) => createMockState({ name }));

      // W=10 vs W=20 -> model-low-weight should be selected ~66% of time

      // Run multiple times to get weighted distribution
      const selections: Record<string, number> = {};
      for (let i = 0; i < 100; i++) {
        const result = strategy.select(models, {});
        if (result) {
          selections[result.name] = (selections[result.name] ?? 0) + 1;
        }
      }

      // With weight 10 vs 20, model-low-weight should be selected ~66% of time
      expect(selections['model-low-weight']).toBeGreaterThan(50);
    });

    it('should return null when all models filtered out', () => {
      circuitBreaker.filterAvailable.mockReturnValue([]);

      const result = strategy.select(mockModels, {});

      expect(result).toBeNull();
    });

    it('should select based on weighted random from all available models', () => {
      // Test that weighted selection works correctly with different weights
      const modelsWithDifferentWeights: ModelDefinition[] = [
        { ...mockModels[0], weight: 1 }, // Low weight
        { ...mockModels[1], weight: 99 }, // Very high weight
      ];

      stateService.getState.mockImplementation((name: string) => createMockState({ name }));

      // Run multiple times to verify weighted selection
      const selections: Record<string, number> = {};
      for (let i = 0; i < 100; i++) {
        const result = strategy.select(modelsWithDifferentWeights, {});
        if (result) {
          selections[result.name] = (selections[result.name] ?? 0) + 1;
        }
      }

      // model-low-weight with weight 99 should be selected much more often
      // model-low-weight with weight 99 should be selected much more often
      expect(selections['model-low-weight']).toBeGreaterThan(80);
    });

    it('should select best model when selectionMode is "best"', () => {
      // models[0] has weight 10, models[1] has weight 5, models[2] has weight 1
      // Assuming equal stats, effective weight follows static weight
      const result = strategy.select(mockModels, { selectionMode: 'best' });

      expect(result?.name).toBe('model-high-weight');
    });

    it('should select from top models when selectionMode is "top_n_random"', () => {
      const modelsWithWeights: ModelDefinition[] = [
        { ...mockModels[0], name: 'model-100', weight: 100 },
        { ...mockModels[0], name: 'model-90', weight: 90 },
        { ...mockModels[0], name: 'model-80', weight: 80 },
        { ...mockModels[0], name: 'model-1', weight: 1 }, // Should not be selected
      ];

      // Run multiple times
      for (let i = 0; i < 20; i++) {
        const result = strategy.select(modelsWithWeights, { selectionMode: 'top_n_random' });
        expect(result).not.toBeNull();
        expect(result?.name).not.toBe('model-1');
        expect(['model-100', 'model-90', 'model-80']).toContain(result?.name);
      }
    });
  });
});
