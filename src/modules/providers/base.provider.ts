import { Logger } from '@nestjs/common';
import type { HttpService } from '@nestjs/axios';
import { isAxiosError } from 'axios';
import type {
  LlmProvider,
  ChatCompletionParams,
  ChatCompletionResult,
  ChatCompletionStreamChunk,
} from './interfaces/provider.interface.js';

/**
 * Provider configuration
 */
export interface BaseProviderConfig {
  /**
   * API key
   */
  apiKey: string;

  /**
   * Base URL
   */
  baseUrl: string;

  /**
   * Request timeout in seconds
   */
  timeoutSecs: number;
}

/**
 * HTTP error response
 */
export interface HttpErrorResponse {
  /**
   * HTTP status code
   */
  statusCode: number;

  /**
   * Error message
   */
  message: string;

  /**
   * Error code (if available)
   */
  code?: string;

  /**
   * Provider-specific details (if available)
   */
  details?: string;

  /**
   * Provider request id / correlation id returned in response headers (if available)
   */
  providerRequestId?: string;

  /**
   * Truncated provider response body (if available)
   */
  providerResponse?: string;
}

/**
 * Abstract base class for LLM providers
 */
export abstract class BaseProvider implements LlmProvider {
  protected readonly logger: Logger;

  constructor(
    protected readonly httpService: HttpService,
    protected readonly config: BaseProviderConfig,
  ) {
    this.logger = new Logger(this.constructor.name);
  }

  public abstract get name(): string;

  public abstract chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResult>;

  public abstract chatCompletionStream(
    params: ChatCompletionParams,
  ): AsyncGenerator<ChatCompletionStreamChunk, void, unknown>;

  /**
   * Handle HTTP errors and convert to standard error response
   */
  protected handleHttpError(error: unknown): HttpErrorResponse {
    if (isAxiosError(error)) {
      const statusCode = error.response?.status ?? 500;

      const truncate = (value: string, maxLen = 500): string =>
        value.length > maxLen ? `${value.slice(0, maxLen)}...` : value;

      const normalizeText = (value: string): string => value.replace(/\s+/g, ' ').trim();

      const safeStringify = (value: unknown): string | undefined => {
        try {
          return JSON.stringify(value);
        } catch {
          return undefined;
        }
      };

      const extractText = (value: unknown, maxLen = 500): string | undefined => {
        if (value === null || value === undefined) {
          return undefined;
        }

        if (typeof value === 'string') {
          const normalized = normalizeText(value);
          return normalized ? truncate(normalized, maxLen) : undefined;
        }

        if (typeof value === 'number' || typeof value === 'boolean') {
          return truncate(String(value), maxLen);
        }

        if (typeof value === 'object') {
          const serialized = safeStringify(value);
          if (!serialized) {
            return undefined;
          }
          const normalized = normalizeText(serialized);
          return normalized ? truncate(normalized, maxLen) : undefined;
        }

        return undefined;
      };

      const parseJsonIfPossible = (value: string): Record<string, unknown> | undefined => {
        const trimmed = value.trim();
        if (!trimmed) {
          return undefined;
        }

        if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
          return undefined;
        }

        if (trimmed.length > 10_000) {
          return undefined;
        }

        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
          }
          return undefined;
        } catch {
          return undefined;
        }
      };

      const responseData = error.response?.data as unknown;

      const providerRequestId = extractText(
        error.response?.headers?.['x-request-id'] ??
          error.response?.headers?.['request-id'] ??
          error.response?.headers?.['x-amzn-requestid'] ??
          error.response?.headers?.['cf-ray'],
        200,
      );

      const providerResponse = extractText(
        typeof responseData === 'string'
          ? responseData
          : typeof responseData === 'object'
            ? safeStringify(responseData)
            : responseData,
        1000,
      );

      const responseDataObj =
        responseData && typeof responseData === 'object'
          ? (responseData as Record<string, unknown>)
          : typeof responseData === 'string'
            ? parseJsonIfPossible(responseData)
            : undefined;

      const errorObj =
        responseDataObj?.error && typeof responseDataObj.error === 'object'
          ? (responseDataObj.error as Record<string, unknown>)
          : undefined;

      const metadataObj =
        errorObj?.metadata && typeof errorObj.metadata === 'object'
          ? (errorObj.metadata as Record<string, unknown>)
          : undefined;

      const extractedMessage =
        extractText(errorObj?.message) ??
        extractText(responseDataObj?.message) ??
        extractText(responseDataObj?.error_description) ??
        extractText(responseDataObj?.title) ??
        extractText(responseDataObj?.detail) ??
        extractText(responseDataObj?.error) ??
        extractText(responseData) ??
        extractText(error.message) ??
        'Unknown error';

      const extractedDetails =
        extractText(metadataObj?.raw) ??
        extractText(metadataObj?.details) ??
        extractText(errorObj?.details) ??
        extractText(responseDataObj?.detail) ??
        extractText(responseDataObj?.details) ??
        (providerResponse && providerResponse !== extractedMessage ? providerResponse : undefined);

      const message =
        extractedDetails && extractedDetails !== extractedMessage
          ? `${extractedMessage} - ${extractedDetails}`
          : extractedMessage;

      const code = (typeof errorObj?.code === 'string' ? errorObj.code : undefined) ?? error.code;

      if (statusCode >= 500) {
        this.logger.error(
          `HTTP error: ${statusCode} - ${message}`,
          error.response?.data ?? error.message,
        );
      } else {
        const requestIdSuffix = providerRequestId
          ? ` (provider_request_id: ${providerRequestId})`
          : '';
        const responseSuffix = providerResponse ? ` (provider_response: ${providerResponse})` : '';
        this.logger.warn(
          `HTTP error: ${statusCode} - ${message}${requestIdSuffix}${responseSuffix}`,
        );
      }

      return {
        statusCode,
        message,
        code,
        details: extractedDetails,
        providerRequestId,
        providerResponse,
      };
    }

    this.logger.error('Unknown error type', error);
    return {
      statusCode: 500,
      message: String(error),
    };
  }

  /**
   * Check if error is a rate limit error (429)
   */
  protected isRateLimitError(error: HttpErrorResponse): boolean {
    return error.statusCode === 429;
  }

  /**
   * Check if error is a server error (5xx)
   */
  protected isServerError(error: HttpErrorResponse): boolean {
    return error.statusCode >= 500 && error.statusCode < 600;
  }

  /**
   * Check if error is a timeout error
   */
  protected isTimeoutError(error: HttpErrorResponse): boolean {
    return error.code === 'ETIMEDOUT' || error.code === 'ECONNABORTED';
  }

  /**
   * Check if error is retryable (rate limit, server error, or timeout)
   */
  protected isRetryableError(error: HttpErrorResponse): boolean {
    return this.isRateLimitError(error) || this.isServerError(error) || this.isTimeoutError(error);
  }

  /**
   * Map finish reason to standard format
   * Common implementation for all providers
   */
  protected mapFinishReason(reason: string): 'stop' | 'length' | 'content_filter' | 'tool_calls' {
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'length':
        return 'length';
      case 'content_filter':
        return 'content_filter';
      case 'tool_calls':
        return 'tool_calls';
      default:
        this.logger.warn(`Unknown finish reason: ${reason}, defaulting to 'stop'`);
        return 'stop';
    }
  }

  /**
   * Handle content field when tool calls are present
   * According to OpenAI spec, content should be null when tool_calls are present
   */
  protected handleContentWithToolCalls(content: string | null, toolCalls?: any[]): string | null {
    if (toolCalls && toolCalls.length > 0) {
      return null;
    }
    return content || '';
  }
}
