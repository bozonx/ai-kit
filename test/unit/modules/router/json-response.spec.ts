import { jest, describe, it, expect, beforeEach } from '@jest/globals';
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

describe('RouterService - JSON Response', () => {
  let service: RouterService;
  let mockProvider: any;

  beforeEach(async () => {
    mockProvider = {
      chatCompletion: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RouterService,
        {
          provide: SelectorService,
          useValue: {
            selectNextModel: jest.fn().mockReturnValue({
              name: 'test-model',
              provider: 'test-provider',
              model: 'test-model',
              contextSize: 4096,
            }),
          },
        },
        {
          provide: StateService,
          useValue: {
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
          provide: RetryHandlerService,
          useValue: {
            executeWithRetry: jest.fn(({ operation }) => operation()),
          },
        },
        {
          provide: RequestBuilderService,
          useValue: {
            buildChatCompletionParams: jest.fn((req: any, model: string) => ({
              messages: req.messages,
              model,
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
          useValue: {
            routing: {
              maxModelSwitches: 3,
              maxSameModelRetries: 2,
              retryDelay: 1000,
              fallback: {
                enabled: false,
              },
            },
          },
        },
        {
          provide: PROVIDERS_MAP,
          useValue: new Map([['test-provider', mockProvider]]),
        },
      ],
    }).compile();

    service = module.get<RouterService>(RouterService);
  });

  it('should parse JSON and add to _router.data when content is valid JSON', async () => {
    const jsonResponse = { results: [{ id: 1, name: 'test' }] };
    const jsonString = JSON.stringify(jsonResponse);

    mockProvider.chatCompletion.mockResolvedValue({
      id: 'test-id',
      model: 'test-model',
      content: jsonString,
      finishReason: 'stop',
      usage: {
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
      },
    });

    const request: ChatCompletionRequestDto = {
      messages: [{ role: 'user', content: 'Test' }],
      response_format: { type: 'json_object' },
    };

    const response = await service.chatCompletion(request);

    expect(response._router.data).toEqual(jsonResponse);
    expect(response.choices[0].message.content).toBe(jsonString);
  });

  it('should not add data field when content is not valid JSON', async () => {
    mockProvider.chatCompletion.mockResolvedValue({
      id: 'test-id',
      model: 'test-model',
      content: 'This is plain text, not JSON',
      finishReason: 'stop',
      usage: {
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
      },
    });

    const request: ChatCompletionRequestDto = {
      messages: [{ role: 'user', content: 'Test' }],
    };

    const response = await service.chatCompletion(request);

    expect(response._router.data).toBeUndefined();
    expect(response.choices[0].message.content).toBe('This is plain text, not JSON');
  });

  it('should not add data field when content is null', async () => {
    mockProvider.chatCompletion.mockResolvedValue({
      id: 'test-id',
      model: 'test-model',
      content: null,
      finishReason: 'stop',
      usage: {
        promptTokens: 10,
        completionTokens: 20,
        totalTokens: 30,
      },
    });

    const request: ChatCompletionRequestDto = {
      messages: [{ role: 'user', content: 'Test' }],
    };

    const response = await service.chatCompletion(request);

    expect(response._router.data).toBeUndefined();
    expect(response.choices[0].message.content).toBeNull();
  });
});
