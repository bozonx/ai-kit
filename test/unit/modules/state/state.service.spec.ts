import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Test, type TestingModule } from '@nestjs/testing';
import { StateService } from '../../../../src/modules/state/state.service.js';
import { ModelsService } from '../../../../src/modules/models/models.service.js';
import { CIRCUIT_BREAKER_CONFIG } from '../../../../src/modules/state/circuit-breaker-config.provider.js';
import type { CircuitBreakerConfig } from '../../../../src/modules/state/interfaces/state.interface.js';
import type { ModelDefinition } from '../../../../src/modules/models/interfaces/model.interface.js';

describe('StateService', () => {
  let service: StateService;

  const mockModels: ModelDefinition[] = [
    {
      name: 'test-model-1',
      provider: 'openrouter',
      model: 'test/model-1',
      type: 'fast',
      contextSize: 128000,
      maxOutputTokens: 4096,
      tags: ['general'],
      jsonResponse: true,
      available: true,
    },
    {
      name: 'test-model-2',
      provider: 'deepseek',
      model: 'test/model-2',
      type: 'reasoning',
      contextSize: 64000,
      maxOutputTokens: 8192,
      tags: ['code'],
      jsonResponse: false,
      available: true,
    },
  ];

  const mockCircuitBreakerConfig: CircuitBreakerConfig = {
    failureThreshold: 3,
    cooldownPeriodMins: 1,
    successThreshold: 2,
    statsWindowSizeMins: 10,
  };

  beforeEach(async () => {
    const mockModelsService = {
      getModels: jest.fn().mockReturnValue(mockModels),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StateService,
        { provide: ModelsService, useValue: mockModelsService },
        { provide: CIRCUIT_BREAKER_CONFIG, useValue: mockCircuitBreakerConfig },
      ],
    }).compile();

    service = module.get<StateService>(StateService);

    // Trigger initialization
    service.onModuleInit();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  describe('onModuleInit', () => {
    it('should initialize states for all models', () => {
      const states = service.getAllStates();
      expect(states).toHaveLength(2);
      expect(states.map(s => s.name)).toContain('test-model-1');
      expect(states.map(s => s.name)).toContain('test-model-2');
    });

    it('should set initial state to CLOSED', () => {
      const state = service.getState('test-model-1');
      expect(state.circuitState).toBe('CLOSED');
      expect(state.consecutiveFailures).toBe(0);
      expect(state.consecutiveSuccesses).toBe(0);
    });
  });

  describe('getState', () => {
    it('should return existing state', () => {
      const state = service.getState('test-model-1');
      expect(state.name).toBe('test-model-1');
    });

    it('should create initial state for unknown model', () => {
      const state = service.getState('unknown-model');
      expect(state.name).toBe('unknown-model');
      expect(state.circuitState).toBe('CLOSED');
    });
  });

  describe('recordSuccess', () => {
    it('should increment consecutive successes', () => {
      service.recordSuccess('test-model-1', 100);
      const state = service.getState('test-model-1');
      expect(state.consecutiveSuccesses).toBe(1);
      expect(state.consecutiveFailures).toBe(0);
    });

    it('should reset consecutive failures on success', () => {
      service.recordFailure('test-model-1');
      service.recordFailure('test-model-1');
      service.recordSuccess('test-model-1', 100);
      const state = service.getState('test-model-1');
      expect(state.consecutiveFailures).toBe(0);
    });

    it('should add request to stats', () => {
      service.recordSuccess('test-model-1', 150);
      const state = service.getState('test-model-1');
      expect(state.stats.totalRequests).toBe(1);
      expect(state.stats.successCount).toBe(1);
      expect(state.stats.avgLatency).toBe(150);
    });
  });

  describe('recordFailure', () => {
    it('should increment consecutive failures', () => {
      service.recordFailure('test-model-1');
      const state = service.getState('test-model-1');
      expect(state.consecutiveFailures).toBe(1);
      expect(state.consecutiveSuccesses).toBe(0);
    });

    it('should reset consecutive successes on failure', () => {
      service.recordSuccess('test-model-1', 100);
      service.recordSuccess('test-model-1', 100);
      service.recordFailure('test-model-1');
      const state = service.getState('test-model-1');
      expect(state.consecutiveSuccesses).toBe(0);
    });

    it('should add request to stats', () => {
      service.recordFailure('test-model-1', 50);
      const state = service.getState('test-model-1');
      expect(state.stats.totalRequests).toBe(1);
      expect(state.stats.errorCount).toBe(1);
    });
  });

  describe('markPermanentlyUnavailable', () => {
    it('should set circuit state to PERMANENTLY_UNAVAILABLE', () => {
      service.markPermanentlyUnavailable('test-model-1', '404 Not Found');
      const state = service.getState('test-model-1');
      expect(state.circuitState).toBe('PERMANENTLY_UNAVAILABLE');
      expect(state.unavailableReason).toBe('404 Not Found');
    });
  });

  describe('setCircuitState', () => {
    it('should set circuit state', () => {
      service.setCircuitState('test-model-1', 'OPEN');
      const state = service.getState('test-model-1');
      expect(state.circuitState).toBe('OPEN');
      expect(state.openedAt).toBeDefined();
    });

    it('should clear openedAt when closing circuit', () => {
      service.setCircuitState('test-model-1', 'OPEN');
      service.setCircuitState('test-model-1', 'CLOSED');
      const state = service.getState('test-model-1');
      expect(state.openedAt).toBeUndefined();
      expect(state.consecutiveFailures).toBe(0);
    });
  });

  describe('isAvailable', () => {
    it('should return true for CLOSED state', () => {
      expect(service.isAvailable('test-model-1')).toBe(true);
    });

    it('should return true for HALF_OPEN state', () => {
      service.setCircuitState('test-model-1', 'HALF_OPEN');
      expect(service.isAvailable('test-model-1')).toBe(true);
    });

    it('should return false for OPEN state', () => {
      service.setCircuitState('test-model-1', 'OPEN');
      expect(service.isAvailable('test-model-1')).toBe(false);
    });

    it('should return false for PERMANENTLY_UNAVAILABLE state', () => {
      service.markPermanentlyUnavailable('test-model-1');
      expect(service.isAvailable('test-model-1')).toBe(false);
    });
  });

  describe('resetState', () => {
    it('should reset model state to initial', () => {
      service.recordFailure('test-model-1');
      service.setCircuitState('test-model-1', 'OPEN');
      service.resetState('test-model-1');

      const state = service.getState('test-model-1');
      expect(state.circuitState).toBe('CLOSED');
      expect(state.consecutiveFailures).toBe(0);
    });
  });

  describe('statistics calculation', () => {
    it('should calculate success rate correctly', () => {
      service.recordSuccess('test-model-1', 100);
      service.recordSuccess('test-model-1', 100);
      service.recordFailure('test-model-1', 50);

      const state = service.getState('test-model-1');
      expect(state.stats.totalRequests).toBe(3);
      expect(state.stats.successCount).toBe(2);
      expect(state.stats.errorCount).toBe(1);
      expect(state.stats.successRate).toBeCloseTo(0.667, 2);
    });

    it('should calculate average latency from successful requests', () => {
      service.recordSuccess('test-model-1', 100);
      service.recordSuccess('test-model-1', 200);
      service.recordSuccess('test-model-1', 300);

      const state = service.getState('test-model-1');
      expect(state.stats.avgLatency).toBe(200);
    });
  });
});
