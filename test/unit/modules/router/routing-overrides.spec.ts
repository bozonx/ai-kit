import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Test, type TestingModule } from '@nestjs/testing';
import { RouterService } from '../../../../src/modules/router/router.service.js';
import { SelectorService } from '../../../../src/modules/selector/selector.service.js';
import { StateService } from '../../../../src/modules/state/state.service.js';
import { CircuitBreakerService } from '../../../../src/modules/state/circuit-breaker.service.js';
import { ShutdownService } from '../../../../src/modules/shutdown/shutdown.service.js';
import { RetryHandlerService } from '../../../../src/modules/router/services/retry-handler.service.js';
import { RequestBuilderService } from '../../../../src/modules/router/services/request-builder.service.js';
import { RateLimiterService } from '../../../../src/modules/rate-limiter/rate-limiter.service.js';
import { ROUTER_CONFIG } from '../../../../src/config/router-config.provider.js';
import { PROVIDERS_MAP } from '../../../../src/modules/providers/providers.module.js';
import type { ChatCompletionRequestDto } from '../../../../src/modules/router/dto/chat-completion.request.dto.js';
import type { LlmProvider } from '../../../../src/modules/providers/interfaces/provider.interface.js';
import type { RouterConfig } from '../../../../src/config/router-config.interface.js';

describe('RouterService - Routing Overrides', () => {
  let service: RouterService;
  let retryHandler: RetryHandlerService;
  let selectorService: jest.Mocked<SelectorService>;
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
      retryDelay: 1000,
      timeoutSecs: 30,
      fallback: {
        enabled: false,
        provider: 'deepseek',
        model: 'deepseek-chat',
      },
    },
  };

  const mockModel = {
    name: 'test-model',
    provider: 'openrouter',
    model: 'test/model',
    type: 'fast' as const,
    contextSize: 8000,
    maxOutputTokens: 4000,
    available: true,
    jsonResponse: false,
    tags: [],
    weight: 10,
  };

  beforeEach(async () => {
    // Create mock provider
    mockProvider = {
      name: 'openrouter',
      chatCompletion: jest.fn(),
      chatCompletionStream: jest.fn(),
    } as unknown as jest.Mocked<LlmProvider>;

    // Create mock selector service
    selectorService = {
      selectNextModel: jest.fn(),
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
          useValue: {
            incrementActiveRequests: jest.fn(),
            decrementActiveRequests: jest.fn(),
            recordFallbackUsage: jest.fn(),
          },
        },
        {
          provide: CircuitBreakerService,
          useValue: {
            onSuccess: jest.fn(),
            onFailure: jest.fn(),
          },
        },
        {
          provide: ShutdownService,
          useValue: {
            registerRequest: jest.fn(),
            unregisterRequest: jest.fn(),
            createRequestSignal: jest.fn().mockReturnValue(new AbortController().signal),
            shuttingDown: false,
          },
        },
        {
          provide: RequestBuilderService,
          useValue: {
            buildChatCompletionParams: jest.fn().mockImplementation((req: any) => ({
              timeoutSecs: req.timeout_secs,
            })),
            hasImageContent: jest.fn().mockReturnValue(false),
          },
        },
        {
          provide: RateLimiterService,
          useValue: {
            checkModel: jest.fn().mockReturnValue(true),
          },
        },
        {
          provide: ROUTER_CONFIG,
          useValue: mockConfig,
        },
        {
          provide: PROVIDERS_MAP,
          useValue: new Map([['openrouter', mockProvider]]),
        },
      ],
    }).compile();

    service = module.get<RouterService>(RouterService);
    retryHandler = module.get<RetryHandlerService>(RetryHandlerService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Per-request routing overrides', () => {
    it('should use max_model_switches from request instead of config', async () => {
      const request: ChatCompletionRequestDto = {
        messages: [{ role: 'user', content: 'test' }],
        max_model_switches: 5, // Override config value of 3
      };

      // Mock selector to return null after 5 attempts
      let callCount = 0;
      selectorService.selectNextModel.mockImplementation(() => {
        callCount++;
        return callCount <= 5 ? mockModel : null;
      });

      // Mock retry handler to fail
      const error = new Error('Model failed');
      (error as any).response = { status: 500 };
      mockProvider.chatCompletion.mockRejectedValue(error);

      await expect(service.chatCompletion(request)).rejects.toThrow();

      // Should have tried 5 times (from request) instead of 3 (from config)
      expect(selectorService.selectNextModel).toHaveBeenCalledTimes(5);
    });

    it('should use max_same_model_retries from request instead of config', async () => {
      const request: ChatCompletionRequestDto = {
        messages: [{ role: 'user', content: 'test' }],
        max_same_model_retries: 5, // Override config value of 2
      };

      selectorService.selectNextModel.mockReturnValue(mockModel);
      mockProvider.chatCompletion.mockResolvedValue({
        id: 'test',
        model: 'test-model',
        content: 'response',
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      });

      const executeWithRetrySpy = jest.spyOn(retryHandler, 'executeWithRetry');

      await service.chatCompletion(request);

      expect(executeWithRetrySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          maxRetries: 5,
        }),
      );
    });

    it('should use retry_delay from request instead of config', async () => {
      const request: ChatCompletionRequestDto = {
        messages: [{ role: 'user', content: 'test' }],
        retry_delay: 500, // Override config value of 1000
      };

      selectorService.selectNextModel.mockReturnValue(mockModel);
      mockProvider.chatCompletion.mockResolvedValue({
        id: 'test',
        model: 'test-model',
        content: 'response',
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      });

      const executeWithRetrySpy = jest.spyOn(retryHandler, 'executeWithRetry');

      await service.chatCompletion(request);

      expect(executeWithRetrySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          retryDelay: 500,
        }),
      );
    });

    it('should use config values when request overrides are not provided', async () => {
      const request: ChatCompletionRequestDto = {
        messages: [{ role: 'user', content: 'test' }],
        // No overrides provided
      };

      selectorService.selectNextModel.mockReturnValue(mockModel);
      mockProvider.chatCompletion.mockResolvedValue({
        id: 'test',
        model: 'test-model',
        content: 'response',
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      });

      const executeWithRetrySpy = jest.spyOn(retryHandler, 'executeWithRetry');

      await service.chatCompletion(request);

      expect(executeWithRetrySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          maxRetries: 2, // From config
          retryDelay: 1000, // From config
        }),
      );
    });

    it('should allow setting max_same_model_retries to 0', async () => {
      const request: ChatCompletionRequestDto = {
        messages: [{ role: 'user', content: 'test' }],
        max_same_model_retries: 0, // Disable retries
      };

      selectorService.selectNextModel.mockReturnValue(mockModel);
      mockProvider.chatCompletion.mockResolvedValue({
        id: 'test',
        model: 'test-model',
        content: 'response',
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      });

      const executeWithRetrySpy = jest.spyOn(retryHandler, 'executeWithRetry');

      await service.chatCompletion(request);

      expect(executeWithRetrySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          maxRetries: 0,
        }),
      );
    });

    it('should pass timeout_secs from request to provider params', async () => {
      const request: ChatCompletionRequestDto = {
        messages: [{ role: 'user', content: 'test' }],
        timeout_secs: 120, // Override config value
      };

      selectorService.selectNextModel.mockReturnValue(mockModel);
      mockProvider.chatCompletion.mockResolvedValue({
        id: 'test',
        model: 'test-model',
        content: 'response',
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      });

      await service.chatCompletion(request);

      expect(mockProvider.chatCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          timeoutSecs: 120, // Should be passed to provider
        }),
      );
    });
  });
});
