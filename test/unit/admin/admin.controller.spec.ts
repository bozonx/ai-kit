import { Test, type TestingModule } from '@nestjs/testing';
import { jest } from '@jest/globals';
import { NotFoundException } from '@nestjs/common';
import { AdminController } from '../../../src/modules/admin/admin.controller.js';
import { StateService } from '../../../src/modules/state/state.service.js';
import { RateLimiterService } from '../../../src/modules/rate-limiter/rate-limiter.service.js';
import { ModelsService } from '../../../src/modules/models/models.service.js';

describe('AdminController', () => {
  let controller: AdminController;
  let stateService: StateService;
  let rateLimiterService: RateLimiterService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [
        {
          provide: StateService,
          useValue: {
            getAllStates: jest.fn(),
            hasState: jest.fn(),
            getState: jest.fn(),
            resetState: jest.fn(),
            getFallbacksUsed: jest.fn().mockReturnValue(0),
          },
        },
        {
          provide: RateLimiterService,
          useValue: {
            getStatus: jest.fn(),
          },
        },
        {
          provide: ModelsService,
          useValue: {
            findModel: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<AdminController>(AdminController);
    stateService = module.get<StateService>(StateService);
    rateLimiterService = module.get<RateLimiterService>(RateLimiterService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getStates', () => {
    it('should return all states and timestamp', () => {
      const mockStates = [{ name: 'model1' }];
      (stateService.getAllStates as jest.Mock).mockReturnValue(mockStates);

      const result = controller.getStates();
      expect(result.models).toEqual([
        {
          name: 'model1',
          modelName: 'model1',
          providerName: 'Unknown',
          tags: [],
          type: 'fast',
          contextSize: 0,
          weight: 1,
          supportsImage: false,
          supportsVideo: false,
          supportsAudio: false,
          supportsFile: false,
          jsonResponse: false,
          model: '',
          provider: '',
        },
      ]);
      expect(result.timestamp).toBeDefined();
    });
  });

  describe('getState', () => {
    it('should return state for specific model', () => {
      const mockState = { name: 'model1' };
      (stateService.hasState as jest.Mock).mockReturnValue(true);
      (stateService.getState as jest.Mock).mockReturnValue(mockState);

      const result = controller.getState('model1');
      expect(result).toEqual(mockState);
      expect(stateService.hasState).toHaveBeenCalledWith('model1');
      expect(stateService.getState).toHaveBeenCalledWith('model1');
    });

    it('should throw NotFoundException if model not found', () => {
      (stateService.hasState as jest.Mock).mockReturnValue(false);
      expect(() => controller.getState('unknown')).toThrow(NotFoundException);
    });
  });

  describe('resetState', () => {
    it('should reset state for specific model', () => {
      (stateService.hasState as jest.Mock).mockReturnValue(true);
      const result = controller.resetState('model1');
      expect(stateService.resetState).toHaveBeenCalledWith('model1');
      expect(result).toEqual({ message: 'State for model model1 reset' });
    });

    it('should throw NotFoundException if model not found', () => {
      (stateService.hasState as jest.Mock).mockReturnValue(false);
      expect(() => controller.resetState('unknown')).toThrow(NotFoundException);
    });
  });

  describe('getMetrics', () => {
    it('should calculate metrics correctly', () => {
      const mockStates = [
        {
          name: 'model1',
          circuitState: 'CLOSED',
          stats: {
            totalRequests: 100,
            successCount: 90,
            errorCount: 10,
            avgLatency: 200,
          },
        },
        {
          name: 'model2',
          circuitState: 'OPEN',
          stats: {
            totalRequests: 50,
            successCount: 0,
            errorCount: 50,
            avgLatency: 0,
          },
        },
      ];

      (stateService.getAllStates as jest.Mock).mockReturnValue(mockStates);
      (stateService.getFallbacksUsed as jest.Mock).mockReturnValue(5);

      const result = controller.getMetrics();

      expect(result).toEqual({
        uptime: expect.any(Number),
        totalRequests: 150,
        successfulRequests: 90,
        failedRequests: 60,
        fallbacksUsed: 5,
        avgLatency: 200, // Only model1 has successes
        modelsAvailable: 1,
        modelsInOpenState: 1,
        modelsPermanentlyUnavailable: 0,
      });
    });
  });

  describe('getRateLimits', () => {
    it('should return rate limit status', () => {
      const mockStatus = { enabled: true };
      (rateLimiterService.getStatus as jest.Mock).mockReturnValue(mockStatus);

      const result = controller.getRateLimits();
      expect(result).toEqual(mockStatus);
    });
  });
});
