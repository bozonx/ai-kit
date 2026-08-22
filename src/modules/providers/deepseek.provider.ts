import { Injectable, HttpException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { Readable } from 'stream';
import { BaseProvider, type BaseProviderConfig } from './base.provider.js';
import type {
  ChatCompletionParams,
  ChatCompletionResult,
  ChatCompletionStreamChunk,
} from './interfaces/provider.interface.js';
import type { Tool, ToolCall, ToolChoice } from './interfaces/tools.interface.js';

/**
 * DeepSeek API request format (OpenAI-compatible)
 */
interface DeepSeekRequest {
  model: string;
  messages: Array<{
    role: string;
    content:
      | string
      | Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }>
      | null;
    name?: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
  }>;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stop?: string | string[];
  response_format?: {
    type: 'text' | 'json_object' | 'json_schema';
    json_schema?: Record<string, any>;
  };
  tools?: Tool[];
  tool_choice?: ToolChoice;
  stream?: boolean;
}

/**
 * DeepSeek API response format (OpenAI-compatible)
 */
interface DeepSeekResponse {
  id: string;
  model: string;
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/**
 * DeepSeek API streaming response format (SSE chunks)
 */
interface DeepSeekStreamChunk {
  id: string;
  model: string;
  choices: Array<{
    delta: {
      role?: 'assistant';
      content?: string;
      tool_calls?: ToolCall[];
    };
    finish_reason?: string;
  }>;
}

/**
 * DeepSeek LLM provider implementation
 */
@Injectable()
export class DeepSeekProvider extends BaseProvider {
  constructor(httpService: HttpService, config: BaseProviderConfig) {
    super(httpService, config);
  }

  public get name(): string {
    return 'deepseek';
  }

  /**
   * Perform chat completion using DeepSeek API
   */
  public async chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResult> {
    const request: DeepSeekRequest = {
      model: params.model,
      messages: params.messages,
      temperature: params.temperature,
      max_tokens: params.maxTokens,
      top_p: params.topP,
      frequency_penalty: params.frequencyPenalty,
      presence_penalty: params.presencePenalty,
      stop: params.stop,
      tools: params.tools,
      tool_choice: params.toolChoice,
    };

    if (params.responseFormat) {
      request.response_format = params.responseFormat;
    }

    try {
      const response = await firstValueFrom(
        this.httpService.post<DeepSeekResponse>('/chat/completions', request, {
          baseURL: this.config.baseUrl,
          timeout: (params.timeoutSecs || this.config.timeoutSecs) * 1000,
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
          signal: params.abortSignal,
        }),
      );

      return this.mapResponse(response.data);
    } catch (error) {
      const httpError = this.handleHttpError(error);

      throw new HttpException(
        {
          error: {
            message: `DeepSeek API error: ${httpError.message}`,
            type: 'provider_error',
            code: httpError.code,
            details: httpError.details,
            provider_request_id: httpError.providerRequestId,
            provider_response: httpError.providerResponse,
          },
        },
        httpError.statusCode,
      );
    }
  }

  /**
   * Perform chat completion with streaming using DeepSeek API
   */
  public async *chatCompletionStream(
    params: ChatCompletionParams,
  ): AsyncGenerator<ChatCompletionStreamChunk, void, unknown> {
    const request: DeepSeekRequest = {
      model: params.model,
      messages: params.messages,
      temperature: params.temperature,
      max_tokens: params.maxTokens,
      top_p: params.topP,
      frequency_penalty: params.frequencyPenalty,
      presence_penalty: params.presencePenalty,
      stop: params.stop,
      tools: params.tools,
      tool_choice: params.toolChoice,
      stream: true,
    };

    if (params.responseFormat) {
      request.response_format = params.responseFormat;
    }

    try {
      const response = await firstValueFrom(
        this.httpService.post('/chat/completions', request, {
          baseURL: this.config.baseUrl,
          timeout: (params.timeoutSecs || this.config.timeoutSecs) * 1000,
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
          signal: params.abortSignal,
          responseType: 'stream',
        }),
      );

      const stream = response.data as Readable;

      // Parse SSE stream
      let buffer = '';
      for await (const chunk of stream) {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine || trimmedLine.startsWith(':')) {
            continue; // Skip empty lines and comments
          }

          if (trimmedLine === 'data: [DONE]') {
            return; // Stream completed
          }

          if (trimmedLine.startsWith('data: ')) {
            try {
              const jsonData = trimmedLine.slice(6); // Remove "data: " prefix
              const sseChunk = JSON.parse(jsonData) as DeepSeekStreamChunk;

              const choice = sseChunk.choices[0];
              if (!choice) {
                continue;
              }

              yield {
                id: sseChunk.id,
                model: sseChunk.model,
                delta: {
                  role: choice.delta.role,
                  content: choice.delta.content,
                  tool_calls: choice.delta.tool_calls,
                },
                finishReason: choice.finish_reason
                  ? this.mapFinishReason(choice.finish_reason)
                  : undefined,
              };
            } catch (parseError) {
              this.logger.warn(`Failed to parse SSE chunk: ${trimmedLine}`, parseError);
            }
          }
        }
      }
    } catch (error) {
      const httpError = this.handleHttpError(error);

      throw new HttpException(
        {
          error: {
            message: `DeepSeek streaming API error: ${httpError.message}`,
            type: 'provider_error',
            code: httpError.code,
            details: httpError.details,
            provider_request_id: httpError.providerRequestId,
            provider_response: httpError.providerResponse,
          },
        },
        httpError.statusCode,
      );
    }
  }

  /**
   * Map DeepSeek response to standard format
   */
  private mapResponse(response: DeepSeekResponse): ChatCompletionResult {
    const choice = response.choices[0];
    if (!choice) {
      throw new Error('No choices in DeepSeek response');
    }

    return {
      id: response.id,
      model: response.model,
      content: this.handleContentWithToolCalls(choice.message.content, choice.message.tool_calls),
      toolCalls: choice.message.tool_calls,
      finishReason: this.mapFinishReason(choice.finish_reason),
      usage: {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      },
    };
  }
}
