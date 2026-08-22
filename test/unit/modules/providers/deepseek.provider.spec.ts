import { Test, type TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { jest } from '@jest/globals';
import { DeepSeekProvider } from '../../../../src/modules/providers/deepseek.provider.js';
import type { BaseProviderConfig } from '../../../../src/modules/providers/base.provider.js';

describe('DeepSeekProvider', () => {
  let provider: DeepSeekProvider;
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
          provide: DeepSeekProvider,
          useFactory: (http: HttpService) => new DeepSeekProvider(http, mockConfig),
          inject: [HttpService],
        },
        {
          provide: HttpService,
          useValue: mockHttpService,
        },
      ],
    }).compile();

    provider = module.get<DeepSeekProvider>(DeepSeekProvider);
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
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hello' } as any],
      temperature: 0.7,
    };

    const mockResponse: AxiosResponse = {
      data: {
        id: 'test-id',
        model: 'deepseek-chat',
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

    it('should successfully call chatCompletion', async () => {
      jest.spyOn(httpService, 'post').mockReturnValue(of(mockResponse));

      const result = await provider.chatCompletion(mockRequest);

      expect(httpService.post).toHaveBeenCalledWith(
        '/chat/completions',
        expect.objectContaining({
          model: 'deepseek-chat',
          messages: mockRequest.messages,
        }),
        expect.objectContaining({
          baseURL: mockConfig.baseUrl,
          headers: expect.objectContaining({
            Authorization: `Bearer ${mockConfig.apiKey}`,
            'Content-Type': 'application/json',
          }),
        }),
      );

      expect(result).toEqual({
        id: 'test-id',
        model: 'deepseek-chat',
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
      jest.spyOn(httpService, 'post').mockReturnValue(of(mockResponse));

      await provider.chatCompletion({
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
    });

    it('should handle HTTP errors', async () => {
      const error = new AxiosError('Server Error', '500', undefined, undefined, {
        status: 500,
        data: { error: { message: 'Internal Server Error' } },
        statusText: 'Server Error',
        config: {} as InternalAxiosRequestConfig,
      } as AxiosResponse);

      jest.spyOn(httpService, 'post').mockReturnValue(throwError(() => error));

      await expect(provider.chatCompletion(mockRequest)).rejects.toThrow(HttpException);

      try {
        await provider.chatCompletion(mockRequest);
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        const ex = e as HttpException;
        expect(ex.getStatus()).toBe(500);
        const response = ex.getResponse() as any;
        expect(response?.error?.message).toContain('DeepSeek API error: Internal Server Error');
        expect(response?.error?.provider_response).toContain('Internal Server Error');
      }
    });
  });
});
