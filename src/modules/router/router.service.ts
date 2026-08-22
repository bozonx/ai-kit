import { Injectable, Logger, Inject } from '@nestjs/common';
import { SelectorService } from '../selector/selector.service.js';
import { StateService } from '../state/state.service.js';
import { CircuitBreakerService } from '../state/circuit-breaker.service.js';
import { ShutdownService } from '../shutdown/shutdown.service.js';
import { ROUTER_CONFIG } from '../../config/router-config.provider.js';
import type { ProvidersMap } from '../providers/providers.module.js';
import { PROVIDERS_MAP } from '../providers/providers.module.js';
import type { ChatCompletionRequestDto } from './dto/chat-completion.request.dto.js';
import type { ChatCompletionResponseDto } from './dto/chat-completion.response.dto.js';
import type {
  ChatCompletionResult,
  ChatCompletionStreamChunk,
} from '../providers/interfaces/provider.interface.js';
import type { RouterConfig } from '../../config/router-config.interface.js';
import type { ModelDefinition } from '../models/interfaces/model.interface.js';
import { parseModelInput } from '../selector/utils/model-parser.js';
import { RetryHandlerService } from './services/retry-handler.service.js';
import { RequestBuilderService } from './services/request-builder.service.js';
import { ErrorExtractor, type ErrorInfo } from '../../common/utils/error-extractor.util.js';
import {
  AllModelsFailedError,
  ProviderNotFoundError,
  RequestCancelledError,
} from '../../common/errors/router.errors.js';
import { RateLimiterService } from '../rate-limiter/rate-limiter.service.js';
import { JsonParser } from '../../common/utils/json-parser.util.js';
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Router service for handling chat completion requests with fallback logic
 */
@Injectable()
export class RouterService {
  private readonly logger = new Logger(RouterService.name);

  constructor(
    private readonly selectorService: SelectorService,
    private readonly stateService: StateService,
    private readonly circuitBreaker: CircuitBreakerService,
    private readonly shutdownService: ShutdownService,
    private readonly retryHandler: RetryHandlerService,
    private readonly requestBuilder: RequestBuilderService,
    @Inject(PROVIDERS_MAP) private readonly providersMap: ProvidersMap,
    @Inject(ROUTER_CONFIG) private readonly config: RouterConfig,
    private readonly rateLimiterService: RateLimiterService,
  ) {}

  /**
   * Handle chat completion request with retry and fallback logic
   */
  public async chatCompletion(
    request: ChatCompletionRequestDto,
    clientSignal?: AbortSignal,
  ): Promise<ChatCompletionResponseDto> {
    // Register request for graceful shutdown tracking
    this.shutdownService.registerRequest();

    try {
      // Use per-request overrides or fall back to config
      const maxModelSwitches = request.max_model_switches ?? this.config.routing.maxModelSwitches;
      const maxSameModelRetries =
        request.max_same_model_retries ?? this.config.routing.maxSameModelRetries;
      const retryDelay = request.retry_delay ?? this.config.routing.retryDelay;

      return await this.executeWithShutdownHandling(request, clientSignal, {
        maxModelSwitches,
        maxSameModelRetries,
        retryDelay,
      });
    } finally {
      // Always unregister request when done
      this.shutdownService.unregisterRequest();
    }
  }

  private shouldRequestJsonResponse(request: ChatCompletionRequestDto): boolean {
    return (
      request.response_format?.type === 'json_object' ||
      request.response_format?.type === 'json_schema'
    );
  }

  /**
   * Handle chat completion with streaming (Server-Sent Events)
   * Implements retry/fallback logic similar to non-streaming mode
   */
  public async *chatCompletionStream(
    request: ChatCompletionRequestDto,
    clientSignal?: AbortSignal,
  ): AsyncGenerator<ChatCompletionStreamChunk, void, unknown> {
    // Register request for graceful shutdown tracking
    this.shutdownService.registerRequest();

    try {
      // Use per-request overrides or fall back to config
      const maxModelSwitches = request.max_model_switches ?? this.config.routing.maxModelSwitches;
      const maxSameModelRetries =
        request.max_same_model_retries ?? this.config.routing.maxSameModelRetries;
      const retryDelay = request.retry_delay ?? this.config.routing.retryDelay;

      // Combine client signal with shutdown signal
      const abortSignal = this.createCombinedAbortSignal(clientSignal);
      const parsedModel = parseModelInput(request.model);
      const excludedModels: string[] = [];
      let attemptCount = 0;
      let isFirstChunk = true;

      // Try up to maxModelSwitches models
      for (let i = 0; i < maxModelSwitches; i++) {
        attemptCount++;

        const model = this.selectModel(request, parsedModel, excludedModels);
        if (!model) {
          this.logger.warn('No suitable model found for streaming');
          break;
        }

        this.logger.debug(
          `Streaming attempt ${attemptCount}: Using model ${model.name} (${model.provider})`,
        );

        // Get provider
        const provider = this.providersMap.get(model.provider);
        if (!provider) {
          throw new ProviderNotFoundError(model.provider);
        }

        // Build completion params
        const completionParams = this.requestBuilder.buildChatCompletionParams(
          request,
          model.model,
          abortSignal,
        );

        // Stream chunks from provider
        const startTime = Date.now();

        try {
          for await (const chunk of provider.chatCompletionStream(completionParams)) {
            this.checkAbortSignal(abortSignal);

            // Add router metadata to first chunk
            if (isFirstChunk) {
              chunk._router = {
                provider: model.provider,
                model_name: model.name,
                attempts: attemptCount,
                fallback_used: false,
              };
              isFirstChunk = false;
            }

            yield chunk;
          }

          // Record success
          const latencyMs = Date.now() - startTime;
          this.circuitBreaker.onSuccess(model.name, latencyMs);

          this.logger.debug(
            `Streaming successful: ${model.name} (${model.provider}) in ${attemptCount} attempt(s)`,
          );

          return; // Success - exit generator
        } catch (error) {
          const latencyMs = Date.now() - startTime;
          const errorInfo = ErrorExtractor.extractErrorInfo(error, model);

          if (!ErrorExtractor.isClientError(errorInfo.code)) {
            this.circuitBreaker.onFailure(model.name, errorInfo.code, latencyMs);
          }

          if (ErrorExtractor.isAbortError(error)) {
            throw this.handleAbortError();
          }

          // Track failed model and try next one
          excludedModels.push(`${model.provider}/${model.name}`);

          this.logger.warn(
            `Streaming model ${model.name} (${model.provider}) failed: ${errorInfo.error} (code: ${errorInfo.code ?? 'N/A'})`,
          );

          // If client error (4xx except 429), don't retry
          if (ErrorExtractor.isClientError(errorInfo.code)) {
            this.logger.error('Client error detected in streaming, not retrying');
            throw error;
          }

          // Continue to next model
        }
      }

      // If all free models failed, try fallback to paid model
      // Use per-request fallback settings if provided, otherwise use config
      const fallbackEnabled = this.config.routing.fallback?.enabled !== false;
      if (fallbackEnabled) {
        this.logger.warn('All free models failed in streaming, attempting fallback to paid model');

        try {
          const fallbackProviderName =
            request.fallback_provider ?? this.config.routing.fallback.provider;
          const fallbackModelName = request.fallback_model ?? this.config.routing.fallback.model;

          const fallbackProvider = this.providersMap.get(fallbackProviderName);
          if (!fallbackProvider) {
            throw new ProviderNotFoundError(fallbackProviderName);
          }

          const completionParams = this.requestBuilder.buildChatCompletionParams(
            request,
            fallbackModelName,
            abortSignal,
          );

          this.stateService.recordFallbackUsage();

          for await (const chunk of fallbackProvider.chatCompletionStream(completionParams)) {
            this.checkAbortSignal(abortSignal);

            // Add router metadata to first chunk
            if (isFirstChunk) {
              chunk._router = {
                provider: fallbackProviderName,
                model_name: fallbackModelName,
                attempts: attemptCount + 1,
                fallback_used: true,
              };
              isFirstChunk = false;
            }

            yield chunk;
          }

          this.logger.debug('Fallback streaming successful');
          return; // Success
        } catch (error) {
          this.logger.error(
            `Fallback streaming failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          throw error;
        }
      }

      // All models failed
      throw new AllModelsFailedError(attemptCount, []);
    } finally {
      // Always unregister request when done
      this.shutdownService.unregisterRequest();
    }
  }

  /**
   * Execute chat completion with shutdown abort signal support.
   * This method orchestrates the model selection, retry loop, and fallback logic.
   *
   * @param request The chat completion request
   * @param clientSignal Optional abort signal from the client
   */
  private async executeWithShutdownHandling(
    request: ChatCompletionRequestDto,
    clientSignal?: AbortSignal,
    routingOverrides?: {
      maxModelSwitches: number;
      maxSameModelRetries: number;
      retryDelay: number;
    },
  ): Promise<ChatCompletionResponseDto> {
    // Combine client signal with shutdown signal to handle both cases
    const abortSignal = this.createCombinedAbortSignal(clientSignal);
    const errors: ErrorInfo[] = [];
    const excludedModels: string[] = [];
    let attemptCount = 0;

    const parsedModel = parseModelInput(request.model);
    const maxModelSwitches =
      routingOverrides?.maxModelSwitches ?? this.config.routing.maxModelSwitches;

    for (let i = 0; i < maxModelSwitches; i++) {
      attemptCount++;

      const model = this.selectModel(request, parsedModel, excludedModels);
      if (!model) {
        this.logger.warn('No suitable model found');
        break;
      }

      this.logger.debug(`Attempt ${attemptCount}: Using model ${model.name} (${model.provider})`);

      try {
        const result = await this.executeWithRateLimitRetry({
          model,
          request,
          abortSignal,
          maxSameModelRetries: routingOverrides?.maxSameModelRetries,
          retryDelay: routingOverrides?.retryDelay,
        });

        this.logger.debug(
          `Request successful: ${model.name} (${model.provider}) in ${attemptCount} attempt(s)`,
        );

        // Log tool calls if present
        if (result.toolCalls && result.toolCalls.length > 0) {
          this.logger.debug(
            `Model ${model.name} called ${result.toolCalls.length} tool(s): ${result.toolCalls.map(t => t.function.name).join(', ')}`,
          );
        }

        return this.buildSuccessResponse({
          result,
          model,
          attemptCount,
          errors,
          fallbackUsed: false,
          parseJson: this.shouldRequestJsonResponse(request),
        });
      } catch (error) {
        if (abortSignal.aborted) {
          throw this.handleAbortError();
        }

        // Track models that failed to avoid selecting them again in the next retry
        excludedModels.push(`${model.provider}/${model.name}`);
        const errorInfo = ErrorExtractor.extractErrorInfo(error, model);
        errors.push(errorInfo);

        this.logger.warn(
          `Model ${model.name} (${model.provider}) failed: ${errorInfo.error} (code: ${errorInfo.code ?? 'N/A'})`,
        );

        if (ErrorExtractor.isClientError(errorInfo.code)) {
          const jsonRequested = this.shouldRequestJsonResponse(request);
          const isUnsupportedResponseFormat =
            ErrorExtractor.isUnsupportedResponseFormatError(error);

          if (jsonRequested && isUnsupportedResponseFormat) {
            this.logger.warn(
              `Model ${model.name} does not support requested response_format, switching to next model`,
            );
            continue;
          }

          this.logger.error('Client error detected, not retrying');
          throw error;
        }
      }
    }

    // If all retries failed, check if fallback is enabled
    // Use per-request fallback settings if provided, otherwise use config
    const fallbackEnabled = this.config.routing.fallback?.enabled !== false;
    if (fallbackEnabled) {
      const fallbackResponse = await this.tryFallback(request, abortSignal, errors, attemptCount);
      if (fallbackResponse) {
        return fallbackResponse;
      }
    }

    throw new AllModelsFailedError(attemptCount, errors);
  }

  private async executeWithRateLimitRetry(params: {
    model: ModelDefinition;
    request: ChatCompletionRequestDto;
    abortSignal: AbortSignal;
    maxSameModelRetries?: number;
    retryDelay?: number;
  }): Promise<ChatCompletionResult> {
    const { model, request, abortSignal, maxSameModelRetries, retryDelay } = params;

    const effectiveMaxRetries = maxSameModelRetries ?? this.config.routing.maxSameModelRetries;
    const effectiveRetryDelay = retryDelay ?? this.config.routing.retryDelay;

    return await this.retryHandler.executeWithRetry({
      operation: async () => this.executeSingleRequest(model, request, abortSignal),
      maxRetries: effectiveMaxRetries,
      retryDelay: effectiveRetryDelay,
      abortSignal,
      shouldRetry: error => {
        const errorInfo = ErrorExtractor.extractErrorInfo(error, model);
        // Retry on rate limit (429) or retryable network errors (ENETUNREACH, ECONNRESET)
        return (
          ErrorExtractor.isRateLimitError(errorInfo.code) ||
          ErrorExtractor.isRetryableNetworkError(error)
        );
      },
      onRetry: (attempt, error) => {
        const isNetworkError = ErrorExtractor.isRetryableNetworkError(error);
        const errorType = isNetworkError ? 'Network error' : 'Rate limit';
        this.logger.debug(
          `${errorType} for ${model.name}, retrying (attempt ${attempt}/${effectiveMaxRetries})`,
        );
      },
    });
  }

  private async executeFallback(
    request: ChatCompletionRequestDto,
    abortSignal: AbortSignal,
  ): Promise<{ result: ChatCompletionResult; model: ModelDefinition }> {
    // Use per-request fallback settings if provided, otherwise use config
    const fallbackProviderName = request.fallback_provider ?? this.config.routing.fallback.provider;
    const fallbackModelName = request.fallback_model ?? this.config.routing.fallback.model;

    this.logger.debug(`Executing fallback: ${fallbackProviderName}/${fallbackModelName}`);

    const fallbackProvider = this.providersMap.get(fallbackProviderName);
    if (!fallbackProvider) {
      throw new ProviderNotFoundError(fallbackProviderName);
    }

    const completionParams = this.requestBuilder.buildChatCompletionParams(
      request,
      fallbackModelName,
      abortSignal,
    );

    const result = await fallbackProvider.chatCompletion(completionParams);
    this.stateService.recordFallbackUsage();

    this.logger.debug('Fallback request successful');

    return {
      result,
      model: {
        name: fallbackModelName,
        provider: fallbackProviderName,
      } as ModelDefinition,
    };
  }

  /**
   * Build success response with metadata
   */
  private buildSuccessResponse(params: {
    result: ChatCompletionResult;
    model: ModelDefinition;
    attemptCount: number;
    errors: ErrorInfo[];
    fallbackUsed: boolean;
    parseJson: boolean;
  }): ChatCompletionResponseDto {
    const { result, model, attemptCount, errors, fallbackUsed, parseJson } = params;

    // Parse JSON only when JSON response format is requested and content is present
    // Uses JsonParser to handle markdown code blocks that LLMs often wrap JSON in
    let parsedData: unknown | undefined;
    if (parseJson && result.content) {
      parsedData = JsonParser.safeParse(result.content);
    }

    return {
      id: result.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: result.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: result.content,
            tool_calls: result.toolCalls,
          },
          finish_reason: result.finishReason,
        },
      ],
      usage: {
        prompt_tokens: result.usage.promptTokens,
        completion_tokens: result.usage.completionTokens,
        total_tokens: result.usage.totalTokens,
      },
      _router: {
        provider: model.provider,
        model_name: model.name,
        attempts: attemptCount,
        fallback_used: fallbackUsed,
        errors: errors.length > 0 ? errors : undefined,
        data: parsedData,
      },
    };
  }

  private createCombinedAbortSignal(clientSignal?: AbortSignal): AbortSignal {
    const shutdownSignal = this.shutdownService.createRequestSignal();
    // If client provides a signal, we want to abort if EITHER the client cancels OR the server shuts down
    return clientSignal ? AbortSignal.any([shutdownSignal, clientSignal]) : shutdownSignal;
  }

  private selectModel(
    request: ChatCompletionRequestDto,
    parsedModel: ReturnType<typeof parseModelInput>,
    excludedModels: string[],
  ): ModelDefinition | null {
    // Check if request contains images
    const needsVision = this.requestBuilder.hasImageContent(request.messages);

    const model = this.selectorService.selectNextModel(
      {
        models: parsedModel.models,
        allowAutoFallback: parsedModel.allowAutoFallback,
        tags: request.tags,
        type: request.type,
        minContextSize: request.min_context_size,
        minMaxOutputTokens: request.min_max_output_tokens,
        jsonResponse: this.shouldRequestJsonResponse(request) ? true : undefined,
        preferFast: request.prefer_fast,
        minSuccessRate: request.min_success_rate,
        selectionMode: request.selection_mode,
        supportsImage: needsVision || request.supports_image ? true : undefined,
        supportsVideo: request.supports_video ? true : undefined,
        supportsAudio: request.supports_audio ? true : undefined,
        supportsFile: request.supports_file ? true : undefined,
        supportsTools: request.supports_tools ? true : undefined,
      },
      excludedModels,
    );

    // Validate vision capability if request contains images
    if (needsVision && model && !model.supportsImage) {
      this.logger.warn(
        `Model ${model.name} does not support image input, but request contains images`,
      );
      throw new Error(
        `Selected model '${model.name}' does not support image analysis. ` +
          `Please use a vision-capable model (e.g., gemini-2.0-flash-exp, nemotron-nano-12b-v2-vl) ` +
          `or filter by tag 'vision'`,
      );
    }

    return model;
  }

  private async executeSingleRequest(
    model: ModelDefinition,
    request: ChatCompletionRequestDto,
    abortSignal: AbortSignal,
  ): Promise<ChatCompletionResult> {
    this.checkAbortSignal(abortSignal);

    // Check rate limit for this model
    if (!this.rateLimiterService.checkModel(model.name)) {
      throw new HttpException(
        {
          error: {
            message: 'Model rate limit exceeded',
            type: 'rate_limit_error',
            code: 'rate_limit_exceeded',
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const provider = this.providersMap.get(model.provider);
    if (!provider) {
      throw new ProviderNotFoundError(model.provider);
    }

    const completionParams = this.requestBuilder.buildChatCompletionParams(
      request,
      model.model,
      abortSignal,
    );

    const startTime = Date.now();

    try {
      const result = await provider.chatCompletion(completionParams);
      const latencyMs = Date.now() - startTime;
      this.circuitBreaker.onSuccess(model.name, latencyMs);
      return result;
    } catch (error) {
      if (ErrorExtractor.isAbortError(error)) {
        throw this.handleAbortError();
      }

      const latencyMs = Date.now() - startTime;
      const errorInfo = ErrorExtractor.extractErrorInfo(error, model);

      // Only record in Circuit Breaker if NOT a client error (4xx except 429)
      // Client errors (400, 401, 403, etc.) are problems with the request/config,
      // not with the model itself, so they should not affect the circuit breaker
      if (!ErrorExtractor.isClientError(errorInfo.code)) {
        this.circuitBreaker.onFailure(model.name, errorInfo.code, latencyMs);
      }

      throw error;
    }
  }

  private checkAbortSignal(abortSignal: AbortSignal): void {
    if (abortSignal.aborted) {
      throw this.handleAbortError();
    }
  }

  private handleAbortError(): Error {
    const reason = this.shutdownService.shuttingDown ? 'shutdown' : 'client';
    return new RequestCancelledError(reason);
  }

  private async tryFallback(
    request: ChatCompletionRequestDto,
    abortSignal: AbortSignal,
    errors: ErrorInfo[],
    attemptCount: number,
  ): Promise<ChatCompletionResponseDto | null> {
    this.logger.warn('All free models failed, attempting fallback to paid model');

    try {
      const fallbackResult = await this.executeFallback(request, abortSignal);
      return this.buildSuccessResponse({
        result: fallbackResult.result,
        model: fallbackResult.model,
        attemptCount: attemptCount + 1,
        errors,
        fallbackUsed: true,
        parseJson: this.shouldRequestJsonResponse(request),
      });
    } catch (error) {
      const fallbackProviderName =
        request.fallback_provider ?? this.config.routing.fallback.provider;
      const fallbackModelName = request.fallback_model ?? this.config.routing.fallback.model;
      const fallbackError = ErrorExtractor.extractErrorInfo(error, {
        name: fallbackModelName,
        provider: fallbackProviderName,
      } as ModelDefinition);

      this.logger.error(`Fallback model failed: ${fallbackError.error}`);
      return null;
    }
  }
}
