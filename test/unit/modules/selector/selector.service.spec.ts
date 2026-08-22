import { Test, type TestingModule } from '@nestjs/testing';
import { jest } from '@jest/globals';
import { SelectorService } from '../../../../src/modules/selector/selector.service.js';
import { ModelsService } from '../../../../src/modules/models/models.service.js';
import { SmartStrategy } from '../../../../src/modules/selector/strategies/smart.strategy.js';
import { CircuitBreakerService } from '../../../../src/modules/state/circuit-breaker.service.js';
import type { ModelDefinition } from '../../../../src/modules/models/interfaces/model.interface.js';

describe('SelectorService', () => {
  let service: SelectorService;
  let modelsService: ModelsService;
  let strategy: SmartStrategy;

  const mockModel: ModelDefinition = {
    name: 'test-model',
    provider: 'openrouter',
    type: 'fast',
    contextSize: 8000,
    maxOutputTokens: 2000,
    tags: ['general'],
    jsonResponse: true,
    available: true,
    model: 'provider/test-model',
  };

  const mockModelsService = {
    findByName: jest.fn(),
    findByNameAndProvider: jest.fn(),
    filter: jest.fn(),
  };

  const mockStrategy = {
    select: jest.fn(),
  };

  const mockCircuitBreakerService = {
    canRequest: jest.fn().mockReturnValue(true),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SelectorService,
        { provide: ModelsService, useValue: mockModelsService },
        { provide: SmartStrategy, useValue: mockStrategy },
        { provide: CircuitBreakerService, useValue: mockCircuitBreakerService },
      ],
    }).compile();

    service = module.get<SelectorService>(SelectorService);
    modelsService = module.get<ModelsService>(ModelsService);
    strategy = module.get<SmartStrategy>(SmartStrategy);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('selectModel', () => {
    it('should return specific model from priority list if found', () => {
      mockModelsService.findByNameAndProvider.mockReturnValue([mockModel]);
      mockCircuitBreakerService.canRequest.mockReturnValue(true);

      const result = service.selectModel({
        models: [{ name: 'test-model' }],
        allowAutoFallback: false,
      });

      expect(modelsService.findByNameAndProvider).toHaveBeenCalledWith('test-model', undefined);
      expect(result).toEqual(mockModel);
    });

    it('should return null if specific model not found in priority list', () => {
      mockModelsService.findByNameAndProvider.mockReturnValue([]);

      const result = service.selectModel({
        models: [{ name: 'non-existent' }],
        allowAutoFallback: false,
      });

      expect(result).toBeNull();
    });

    it('should use strategy to select from filtered models', () => {
      const filteredModels = [mockModel];
      mockModelsService.filter.mockReturnValue(filteredModels);
      mockStrategy.select.mockReturnValue(mockModel);

      const criteria = { type: 'fast' as const, tags: ['general'] };
      const result = service.selectModel(criteria);

      expect(modelsService.filter).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'fast',
          tags: ['general'],
        }),
      );
      expect(strategy.select).toHaveBeenCalledWith(filteredModels, criteria);
      expect(result).toEqual(mockModel);
    });

    it('should return null if no models match filters', () => {
      mockModelsService.filter.mockReturnValue([]);

      const result = service.selectModel({ type: 'fast' });

      expect(result).toBeNull();
      expect(strategy.select).not.toHaveBeenCalled();
    });
  });

  describe('selectNextModel', () => {
    it('should add excludeModels to criteria', () => {
      const filteredModels = [mockModel];
      mockModelsService.filter.mockReturnValue(filteredModels);
      mockStrategy.select.mockReturnValue(mockModel);

      service.selectNextModel({ type: 'fast' }, ['excluded-model']);

      expect(strategy.select).toHaveBeenCalledWith(
        filteredModels,
        expect.objectContaining({
          excludeModels: ['excluded-model'],
        }),
      );
    });

    it('should merge existing excludeModels', () => {
      mockModelsService.filter.mockReturnValue([mockModel]);

      service.selectNextModel({ type: 'fast', excludeModels: ['initial'] }, ['added']);

      expect(strategy.select).toHaveBeenCalledWith(
        expect.any(Array),
        expect.objectContaining({
          excludeModels: ['initial', 'added'],
        }),
      );
    });
  });
});
