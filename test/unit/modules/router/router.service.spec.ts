import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Test, type TestingModule } from '@nestjs/testing';
import { RouterService } from '../../../../src/modules/router/router.service.js';
import { SelectorService } from '../../../../src/modules/selector/selector.service.js';
import { StateService } from '../../../../src/modules/state/state.service.js';
import { CircuitBreakerService } from '../../../../src/modules/state/circuit-breaker.service.js';
import { ShutdownService } from '../../../../src/modules/shutdown/shutdown.service.js';
import { RetryHandlerService } from '../../../../src/modules/router/services/retry-handler.service.js';
import { RequestBuilderService } from '../../../../src/modules/router/services/request-builder.service.js';
import { PROVIDERS_MAP } from '../../../../src/modules/providers/providers.module.js';
import { ROUTER_CONFIG } from '../../../../src/config/router-config.provider.js';
import { RateLimiterService } from '../../../../src/modules/rate-limiter/rate-limiter.service.js';
import type { ChatCompletionRequestDto } from '../../../../src/modules/router/dto/chat-completion.request.dto.js';
import type { LlmProvider } from '../../../../src/modules/providers/interfaces/provider.interface.js';
import type { ModelDefinition } from '../../../../src/modules/models/interfaces/model.interface.js';
import type { RouterConfig } from '../../../../src/config/router-config.interface.js';

describe('RouterService', () => {
  let service: RouterService;
  let selectorService: jest.Mocked<SelectorService>;
  let stateService: jest.Mocked<StateService>;
  let circuitBreaker: jest.Mocked<CircuitBreakerService>;
  let shutdownService: jest.Mocked<ShutdownService>;
  let rateLimiterService: jest.Mocked<RateLimiterService>;
  let providersMap: Map<string, LlmProvider>;
  let mockProvider: jest.Mocked<LlmProvider>;

  const mockConfig: RouterConfig = {
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
      retryDelay: 100,
      timeoutSecs: 30,
      fallback: {
        enabled: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
      },
    },
  };

  const mockModel: ModelDefinition = {
    name: 'test-model',
    provider: 'openrouter',
    model: 'test/model',
    type: 'fast',
    contextSize: 4096,
    maxOutputTokens: 2048,
    tags: ['general'],
    jsonResponse: true,
    available: true,
  };

  const mockRequest: ChatCompletionRequestDto = {
    messages: [{ role: 'user', content: 'Hello' }],
  };

  const mockCompletionResult = {
    id: 'test-id-123',
    model: 'test/model',
    content: 'Hello! How can I help you?',
    finishReason: 'stop' as const,
    usage: {
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    },
  };

  beforeEach(async () => {
    // Create mock provider
    mockProvider = {
      name: 'openrouter',
      chatCompletion: jest.fn(),
      chatCompletionStream: jest.fn(),
    } as unknown as jest.Mocked<LlmProvider>;

    // Create providers map
    providersMap = new Map();
    providersMap.set('openrouter', mockProvider);
    providersMap.set('deepseek', mockProvider);

    // Create mock selector service
    selectorService = {
      selectNextModel: jest.fn(),
    } as any;

    // Create mock state service
    stateService = {
      incrementActiveRequests: jest.fn(),
      decrementActiveRequests: jest.fn(),
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
      recordFallbackUsage: jest.fn(),
      getState: jest.fn().mockReturnValue({
        name: 'test-model',
        circuitState: 'CLOSED',
        consecutiveFailures: 0,
        consecutiveSuccesses: 0,
        activeRequests: 0,
        stats: {
          totalRequests: 0,
          successCount: 0,
          errorCount: 0,
          avgLatency: 0,
          p95Latency: 0,
          successRate: 1,
          requests: [],
        },
      }),
    } as any;

    // Create mock circuit breaker service
    circuitBreaker = {
      onSuccess: jest.fn(),
      onFailure: jest.fn(),
      canRequest: jest.fn().mockReturnValue(true),
      filterAvailable: jest.fn().mockImplementation(models => models),
    } as any;

    // Create mock shutdown service
    shutdownService = {
      shuttingDown: false,
      registerRequest: jest.fn(),
      unregisterRequest: jest.fn(),
      createRequestSignal: jest.fn().mockReturnValue(new AbortController().signal),
      getAbortSignal: jest.fn().mockReturnValue(null),
    } as any;

    // Create mock rate limiter service
    rateLimiterService = {
      checkModel: jest.fn().mockReturnValue(true),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RouterService,
        RetryHandlerService,
        RequestBuilderService,
        {
          provide: SelectorService,
          useValue: selectorService,
        },
        {
          provide: StateService,
          useValue: stateService,
        },
        {
          provide: CircuitBreakerService,
          useValue: circuitBreaker,
        },
        {
          provide: ShutdownService,
          useValue: shutdownService,
        },
        {
          provide: RateLimiterService,
          useValue: rateLimiterService,
        },
        {
          provide: PROVIDERS_MAP,
          useValue: providersMap,
        },
        {
          provide: ROUTER_CONFIG,
          useValue: mockConfig,
        },
      ],
    }).compile();

    service = module.get<RouterService>(RouterService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('chatCompletion', () => {
    it('should succeed on first attempt', async () => {
      // Arrange
      selectorService.selectNextModel.mockReturnValue(mockModel);
      mockProvider.chatCompletion.mockResolvedValue(mockCompletionResult);

      // Act
      const result = await service.chatCompletion(mockRequest);

      // Assert
      expect(result).toBeDefined();
      expect(result.id).toBe(mockCompletionResult.id);
      expect(result.model).toBe(mockCompletionResult.model);
      expect(result.choices[0].message.content).toBe(mockCompletionResult.content);
      expect(result._router.provider).toBe('openrouter');
      expect(result._router.model_name).toBe('test-model');
      expect(result._router.attempts).toBe(1);
      expect(result._router.fallback_used).toBe(false);
      expect(result._router.errors).toBeUndefined();
    });

    it('should retry with another model on 5xx error', async () => {
      // Arrange
      const failedModel = { ...mockModel, name: 'failed-model' };
      const successModel = { ...mockModel, name: 'success-model' };

      selectorService.selectNextModel
        .mockReturnValueOnce(failedModel)
        .mockReturnValueOnce(successModel);

      const serverError = new Error('Server error');

      (serverError as any).response = { status: 500 };

      mockProvider.chatCompletion
        .mockRejectedValueOnce(serverError)
        .mockResolvedValueOnce(mockCompletionResult);

      // Act
      const result = await service.chatCompletion(mockRequest);

      // Assert
      expect(result).toBeDefined();
      expect(result._router.attempts).toBe(2);
      expect(result._router.fallback_used).toBe(false);
      expect(result._router.errors).toHaveLength(1);
      const errors = result._router.errors;
      if (errors) {
        expect(errors[0].model).toBe('failed-model');
        expect(errors[0].code).toBe(500);
      }
      expect(selectorService.selectNextModel).toHaveBeenCalledTimes(2);
    });

    it('should retry on 429 rate limit error', async () => {
      // Arrange
      selectorService.selectNextModel.mockReturnValue(mockModel);

      const rateLimitError = new Error('Rate limit exceeded');

      (rateLimitError as any).response = { status: 429 };

      mockProvider.chatCompletion
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce(mockCompletionResult);

      // Act
      const result = await service.chatCompletion(mockRequest);

      // Assert
      expect(result).toBeDefined();
      expect(result._router.attempts).toBe(1);
      expect(mockProvider.chatCompletion).toHaveBeenCalledTimes(2);
    });

    it('should use fallback when all free models fail', async () => {
      // Arrange
      const model1 = { ...mockModel, name: 'model-1' };
      const model2 = { ...mockModel, name: 'model-2' };

      selectorService.selectNextModel
        .mockReturnValueOnce(model1)
        .mockReturnValueOnce(model2)
        .mockReturnValueOnce(null); // No more models

      const error = new Error('Service unavailable');

      (error as any).response = { status: 503 };

      mockProvider.chatCompletion
        .mockRejectedValueOnce(error)
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(mockCompletionResult); // Fallback succeeds

      // Act
      const result = await service.chatCompletion(mockRequest);

      // Assert
      expect(result).toBeDefined();
      expect(result._router.fallback_used).toBe(true);
      expect(result._router.attempts).toBe(4); // 3 retries + 1 fallback
      expect(result._router.errors).toHaveLength(2);
    });

    it('should throw on client error (400)', async () => {
      // Arrange
      selectorService.selectNextModel.mockReturnValue(mockModel);

      const clientError = new Error('Bad request');

      (clientError as any).response = { status: 400 };

      mockProvider.chatCompletion.mockRejectedValue(clientError);

      // Act & Assert
      await expect(service.chatCompletion(mockRequest)).rejects.toThrow('Bad request');
      expect(selectorService.selectNextModel).toHaveBeenCalledTimes(1);
    });

    it('should switch model when response_format is not supported by selected model', async () => {
      // Arrange
      const failedModel = { ...mockModel, name: 'failed-model' };
      const successModel = { ...mockModel, name: 'success-model' };

      selectorService.selectNextModel
        .mockReturnValueOnce(failedModel)
        .mockReturnValueOnce(successModel);

      const capabilityError = new Error(
        'OpenRouter API error: Provider returned error - {"details":{"_errors":["response_format is not supported by this model"]}}',
      );
      (capabilityError as any).response = { status: 400 };

      mockProvider.chatCompletion
        .mockRejectedValueOnce(capabilityError)
        .mockResolvedValueOnce(mockCompletionResult);

      const request: ChatCompletionRequestDto = {
        ...mockRequest,
        model: 'auto',
        response_format: { type: 'json_object' },
      };

      // Act
      const result = await service.chatCompletion(request);

      // Assert
      expect(result).toBeDefined();
      expect(result._router.attempts).toBe(2);
      expect(result._router.fallback_used).toBe(false);
      expect(result._router.errors).toHaveLength(1);
      expect(selectorService.selectNextModel).toHaveBeenCalledTimes(2);
    });

    it('should throw when all models and fallback fail', async () => {
      // Arrange
      selectorService.selectNextModel.mockReturnValueOnce(mockModel).mockReturnValueOnce(null);

      const error = new Error('Service unavailable');

      (error as any).response = { status: 503 };

      mockProvider.chatCompletion.mockRejectedValue(error);

      // Act & Assert
      await expect(service.chatCompletion(mockRequest)).rejects.toThrow(/All models failed/);
    });

    it('should exclude already tried models', async () => {
      // Arrange
      const model1 = { ...mockModel, name: 'model-1' };
      const model2 = { ...mockModel, name: 'model-2' };

      selectorService.selectNextModel.mockReturnValueOnce(model1).mockReturnValueOnce(model2);

      const error = new Error('Timeout');
      mockProvider.chatCompletion
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(mockCompletionResult);

      // Act
      await service.chatCompletion(mockRequest);

      // Assert
      // Now excludes with provider/model format for specific provider instance exclusion
      expect(selectorService.selectNextModel).toHaveBeenNthCalledWith(2, expect.anything(), [
        'openrouter/model-1',
      ]);
    });

    it('should include router metadata in response', async () => {
      // Arrange
      selectorService.selectNextModel.mockReturnValue(mockModel);
      mockProvider.chatCompletion.mockResolvedValue(mockCompletionResult);

      // Act
      const result = await service.chatCompletion(mockRequest);

      // Assert
      expect(result._router).toEqual({
        provider: 'openrouter',
        model_name: 'test-model',
        attempts: 1,
        fallback_used: false,
        errors: undefined,
      });
    });
  });
});
