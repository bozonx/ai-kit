import { Test, type TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { jest } from '@jest/globals';
import { OpenRouterProvider } from '../../../../src/modules/providers/openrouter.provider.js';
import type { BaseProviderConfig } from '../../../../src/modules/providers/base.provider.js';

describe('OpenRouterProvider', () => {
  let provider: OpenRouterProvider;
  let httpService: HttpService;

  const mockConfig: BaseProviderConfig = {
    apiKey: 'test-key',
    baseUrl: 'https://test.api',
    timeoutSecs: 5,
  };

  const mockHttpService = {
    post: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: OpenRouterProvider,
          useFactory: (http: HttpService) => new OpenRouterProvider(http, mockConfig),
          inject: [HttpService],
        },
        {
          provide: HttpService,
          useValue: mockHttpService,
        },
      ],
    }).compile();

    provider = module.get<OpenRouterProvider>(OpenRouterProvider);
    httpService = module.get<HttpService>(HttpService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(provider).toBeDefined();
  });

  describe('chatCompletion', () => {
    const mockRequest = {
      model: 'test-model',
      messages: [{ role: 'user', content: 'hello' } as any],
      temperature: 0.7,
      maxTokens: 100,
    };

    const mockResponse: AxiosResponse = {
      data: {
        id: 'test-id',
        model: 'test-model',
        choices: [
          {
            message: { role: 'assistant', content: 'response' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      },
      status: 200,
      statusText: 'OK',
      headers: {},
      config: {} as InternalAxiosRequestConfig,
    };

    it('should successfully calling chatCompletion', async () => {
      jest.spyOn(httpService, 'post').mockReturnValue(of(mockResponse));

      const result = await provider.chatCompletion(mockRequest);

      expect(httpService.post).toHaveBeenCalledWith(
        '/chat/completions',
        expect.objectContaining({
          model: 'test-model',
          messages: mockRequest.messages,
        }),
        expect.objectContaining({
          baseURL: mockConfig.baseUrl,
          headers: expect.objectContaining({
            Authorization: `Bearer ${mockConfig.apiKey}`,
          }),
        }),
      );

      expect(result).toEqual({
        id: 'test-id',
        model: 'test-model',
        content: 'response',
        finishReason: 'stop',
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
        },
      });
    });

    it('should handle JSON mode', async () => {
      const jsonResponse: AxiosResponse = {
        ...mockResponse,
        data: {
          ...mockResponse.data,
          choices: [
            {
              message: { role: 'assistant', content: '{"result":"ok"}' },
              finish_reason: 'stop',
            },
          ],
        },
      };

      jest.spyOn(httpService, 'post').mockReturnValue(of(jsonResponse));

      const result = await provider.chatCompletion({
        ...mockRequest,
        responseFormat: { type: 'json_object' },
      });

      expect(httpService.post).toHaveBeenCalledWith(
        '/chat/completions',
        expect.objectContaining({
          response_format: { type: 'json_object' },
        }),
        expect.any(Object),
      );

      expect(result.content).toBe('{"result":"ok"}');
    });

    it('should throw error in JSON mode when content does not contain valid JSON', async () => {
      const responseWithJsonInReasoning: AxiosResponse = {
        ...mockResponse,
        data: {
          ...mockResponse.data,
          choices: [
            {
              message: { role: 'assistant', content: null, reasoning: '{"ok":true}' },
              finish_reason: 'stop',
            },
          ],
        },
      };

      jest.spyOn(httpService, 'post').mockReturnValue(of(responseWithJsonInReasoning));

      await expect(
        provider.chatCompletion({
          ...mockRequest,
          responseFormat: { type: 'json_object' },
        }),
      ).rejects.toThrow(HttpException);
    });

    it('should normalize JSON extracted from content in JSON mode', async () => {
      const responseWithThinkAndJson: AxiosResponse = {
        ...mockResponse,
        data: {
          ...mockResponse.data,
          choices: [
            {
              message: {
                role: 'assistant',
                content: '<think>hidden</think>\n{\n  "value": 1\n}',
              },
              finish_reason: 'stop',
            },
          ],
        },
      };

      jest.spyOn(httpService, 'post').mockReturnValue(of(responseWithThinkAndJson));

      const result = await provider.chatCompletion({
        ...mockRequest,
        responseFormat: { type: 'json_object' },
      });

      expect(result.content).toBe('{"value":1}');
    });

    it('should use reasoning as content fallback in non-JSON mode when content is missing', async () => {
      const responseWithReasoningOnly: AxiosResponse = {
        ...mockResponse,
        data: {
          ...mockResponse.data,
          choices: [
            {
              message: { role: 'assistant', content: null, reasoning: 'plain reasoning text' },
              finish_reason: 'stop',
            },
          ],
        },
      };

      jest.spyOn(httpService, 'post').mockReturnValue(of(responseWithReasoningOnly));

      const result = await provider.chatCompletion(mockRequest);

      expect(result.content).toBe('plain reasoning text');
    });

    it('should handle HTTP errors', async () => {
      const error = new AxiosError('Rate Limit', '429', undefined, undefined, {
        status: 429,
        data: { error: { message: 'Too Many Requests' } },
      } as AxiosResponse);

      jest.spyOn(httpService, 'post').mockReturnValue(throwError(() => error));

      await expect(provider.chatCompletion(mockRequest)).rejects.toThrow(HttpException);

      try {
        await provider.chatCompletion(mockRequest);
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        const ex = e as HttpException;
        expect(ex.getStatus()).toBe(429);
        const response = ex.getResponse() as any;
        expect(response?.error?.message).toContain('OpenRouter API error: Too Many Requests');
      }
    });

    it('should include provider error message for 400 responses', async () => {
      const error = new AxiosError('Bad Request', '400', undefined, undefined, {
        status: 400,
        data: { message: 'Provider returned error' },
        headers: { 'x-request-id': 'prov-req-1' },
        statusText: 'Bad Request',
        config: {} as InternalAxiosRequestConfig,
      } as AxiosResponse);

      jest.spyOn(httpService, 'post').mockReturnValue(throwError(() => error));

      try {
        await provider.chatCompletion(mockRequest);
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        const ex = e as HttpException;
        expect(ex.getStatus()).toBe(400);
        const response = ex.getResponse() as any;
        expect(response?.error?.message).toContain('Provider returned error');
        expect(response?.error?.provider_request_id).toBe('prov-req-1');
        expect(response?.error?.provider_response).toContain('Provider returned error');
      }
    });

    it('should include detail field for 400 responses when provider returns {detail}', async () => {
      const error = new AxiosError('Bad Request', '400', undefined, undefined, {
        status: 400,
        data: { detail: 'Value error.' },
        statusText: 'Bad Request',
        config: {} as InternalAxiosRequestConfig,
      } as AxiosResponse);

      jest.spyOn(httpService, 'post').mockReturnValue(throwError(() => error));

      try {
        await provider.chatCompletion(mockRequest);
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        const ex = e as HttpException;
        expect(ex.getStatus()).toBe(400);
        const response = ex.getResponse() as any;
        expect(response?.error?.message).toContain('Value error.');
      }
    });

    it('should map unknown finish reason to stop', async () => {
      const responseWithUnknownFinish = {
        ...mockResponse,
        data: {
          ...mockResponse.data,
          choices: [
            {
              message: { content: 'test' },
              finish_reason: 'unknown',
            },
          ],
        },
      };

      jest.spyOn(httpService, 'post').mockReturnValue(of(responseWithUnknownFinish));

      const result = await provider.chatCompletion(mockRequest);
      expect(result.finishReason).toBe('stop');
    });
  });
});
