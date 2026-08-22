import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { Test, type TestingModule } from '@nestjs/testing';
import { RouterController } from '../../../../src/modules/router/router.controller.js';
import { RouterService } from '../../../../src/modules/router/router.service.js';
import { ModelsService } from '../../../../src/modules/models/models.service.js';
import { ROUTER_CONFIG } from '../../../../src/config/router-config.provider.js';
import type { ChatCompletionRequestDto } from '../../../../src/modules/router/dto/chat-completion.request.dto.js';
import type { ChatCompletionResponseDto } from '../../../../src/modules/router/dto/chat-completion.response.dto.js';
import type { ModelDefinition } from '../../../../src/modules/models/interfaces/model.interface.js';

describe('RouterController', () => {
  let controller: RouterController;
  let routerService: jest.Mocked<RouterService>;
  let modelsService: jest.Mocked<ModelsService>;

  const mockRequest: ChatCompletionRequestDto = {
    messages: [{ role: 'user', content: 'Hello' }],
  };

  const mockResponse: ChatCompletionResponseDto = {
    id: 'test-id-123',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'test/model',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'Hello! How can I help you?',
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 20,
      total_tokens: 30,
    },
    _router: {
      provider: 'openrouter',
      model_name: 'test-model',
      attempts: 1,
      fallback_used: false,
      errors: [],
    },
  };

  const mockModels: ModelDefinition[] = [
    {
      name: 'model-1',
      provider: 'openrouter',
      model: 'test/model-1',
      type: 'fast',
      contextSize: 4096,
      maxOutputTokens: 2048,
      tags: ['general'],
      jsonResponse: true,
      available: true,
    },
    {
      name: 'model-2',
      provider: 'deepseek',
      model: 'deepseek/model-2',
      type: 'reasoning',
      contextSize: 8192,
      maxOutputTokens: 4096,
      tags: ['reasoning', 'code'],
      jsonResponse: false,
      available: true,
    },
  ];

  beforeEach(async () => {
    // Create mocks
    routerService = {
      chatCompletion: jest.fn(),
    } as any;

    modelsService = {
      getAvailable: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [RouterController],
      providers: [
        {
          provide: RouterService,
          useValue: routerService,
        },
        {
          provide: ModelsService,
          useValue: modelsService,
        },
        {
          provide: ROUTER_CONFIG,
          useValue: {
            routing: {
              timeoutSecs: 60,
            },
          },
        },
      ],
    }).compile();

    controller = module.get<RouterController>(RouterController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('chatCompletion', () => {
    it('should handle chat completion request successfully', async () => {
      // Arrange
      routerService.chatCompletion.mockResolvedValue(mockResponse);

      const mockReq = {
        raw: {
          on: jest.fn(),
          off: jest.fn(),
          complete: true,
        },
      } as any;

      const mockRes = {
        send: jest.fn(),
        raw: {
          on: jest.fn(),
          off: jest.fn(),
        },
      } as any;

      // Act
      const result = await controller.chatCompletion(mockRequest, mockReq, mockRes);

      // Assert
      expect(result).toEqual(mockResponse);
      expect(mockRes.send).toHaveBeenCalledWith(mockResponse);
      expect(routerService.chatCompletion).toHaveBeenCalledWith(
        mockRequest,
        expect.any(AbortSignal),
      );
      expect(routerService.chatCompletion).toHaveBeenCalledTimes(1);
    });

    it('should propagate errors from router service', async () => {
      // Arrange
      const error = new Error('Service unavailable');
      routerService.chatCompletion.mockRejectedValue(error);
      const mockReq = {
        raw: {
          on: jest.fn(),
          off: jest.fn(),
          complete: true,
        },
      } as any;

      const mockRes = {
        send: jest.fn(),
        raw: {
          on: jest.fn(),
          off: jest.fn(),
        },
      } as any;

      // Act & Assert
      await expect(controller.chatCompletion(mockRequest, mockReq, mockRes)).rejects.toThrow(
        'Service unavailable',
      );
      expect(routerService.chatCompletion).toHaveBeenCalledWith(
        mockRequest,
        expect.any(AbortSignal),
      );
    });

    it('should handle request with all optional parameters', async () => {
      // Arrange
      const fullRequest: ChatCompletionRequestDto = {
        messages: [
          { role: 'system', content: 'You are a helpful assistant' },
          { role: 'user', content: 'Hello' },
        ],
        temperature: 0.7,
        max_tokens: 500,
        top_p: 0.9,
        frequency_penalty: 0.5,
        presence_penalty: 0.5,
        stop: ['END'],
        model: 'specific-model',
        tags: ['code'],
        type: 'reasoning',
        min_context_size: 8192,
        response_format: { type: 'json_object' },
      };

      routerService.chatCompletion.mockResolvedValue(mockResponse);
      const mockReq = {
        raw: {
          on: jest.fn(),
          off: jest.fn(),
          complete: true,
        },
      } as any;

      const mockRes = {
        send: jest.fn(),
        raw: {
          on: jest.fn(),
          off: jest.fn(),
        },
      } as any;

      // Act
      const result = await controller.chatCompletion(fullRequest, mockReq, mockRes);

      // Assert
      expect(result).toEqual(mockResponse);
      expect(mockRes.send).toHaveBeenCalledWith(mockResponse);
      expect(routerService.chatCompletion).toHaveBeenCalledWith(
        fullRequest,
        expect.any(AbortSignal),
      );
    });

    it('should configure SSE headers and timeouts in streaming mode', async () => {
      // Arrange
      const streamRequest: ChatCompletionRequestDto = {
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      };

      async function* gen() {
        yield {
          id: 'chunk-1',
          model: 'test/model',
          delta: { content: 'Hi' },
        } as any;
      }

      routerService.chatCompletionStream = jest.fn().mockReturnValue(gen()) as any;

      const mockReq = {
        raw: {
          on: jest.fn(),
          off: jest.fn(),
          complete: false,
        },
      } as any;

      const mockSocket = {
        setTimeout: jest.fn(),
      };

      const mockRaw = {
        on: jest.fn(),
        off: jest.fn(),
        once: jest.fn(),
        setHeader: jest.fn(),
        setTimeout: jest.fn(),
        write: jest.fn().mockReturnValue(true),
        end: jest.fn(),
        socket: mockSocket,
        destroyed: false,
        writableEnded: false,
      };

      const mockRes = {
        send: jest.fn(),
        raw: mockRaw,
      } as any;

      // Act
      await controller.chatCompletion(streamRequest, mockReq, mockRes);

      // Assert
      expect(mockRaw.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
      expect(mockRaw.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache');
      expect(mockRaw.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');

      expect(mockRaw.setTimeout).toHaveBeenCalledWith(60_000, expect.any(Function));
      expect(mockSocket.setTimeout).toHaveBeenCalledWith(60_000, expect.any(Function));

      expect(mockRaw.end).toHaveBeenCalledTimes(1);
      expect(routerService.chatCompletionStream).toHaveBeenCalledWith(
        streamRequest,
        expect.any(AbortSignal),
      );
    });
  });

  describe('getModels', () => {
    it('should return list of available models', () => {
      // Arrange
      modelsService.getAvailable.mockReturnValue(mockModels);

      // Act
      const result = controller.getModels();

      // Assert
      expect(result).toEqual({
        models: [
          {
            name: 'model-1',
            provider: 'openrouter',
            model: 'test/model-1',
            type: 'fast',
            contextSize: 4096,
            maxOutputTokens: 2048,
            tags: ['general'],
            jsonResponse: true,
            available: true,
            priority: undefined,
            weight: undefined,
            maxConcurrent: undefined,
          },
          {
            name: 'model-2',
            provider: 'deepseek',
            model: 'deepseek/model-2',
            type: 'reasoning',
            contextSize: 8192,
            maxOutputTokens: 4096,
            tags: ['reasoning', 'code'],
            jsonResponse: false,
            available: true,
            priority: undefined,
            weight: undefined,
            maxConcurrent: undefined,
          },
        ],
      });
      expect(modelsService.getAvailable).toHaveBeenCalledTimes(1);
    });

    it('should return empty array when no models available', () => {
      // Arrange
      modelsService.getAvailable.mockReturnValue([]);

      // Act
      const result = controller.getModels();

      // Assert
      expect(result).toEqual({ models: [] });
      expect(modelsService.getAvailable).toHaveBeenCalledTimes(1);
    });
  });
});
