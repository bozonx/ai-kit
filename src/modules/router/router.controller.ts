import {
  Controller,
  Post,
  Get,
  Body,
  HttpCode,
  HttpStatus,
  Logger,
  Inject,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { RouterService } from './router.service.js';
import { ModelsService } from '../models/models.service.js';
import { ChatCompletionRequestDto } from './dto/chat-completion.request.dto.js';
import { ROUTER_CONFIG } from '../../config/router-config.provider.js';
import type { RouterConfig } from '../../config/router-config.interface.js';
import type {
  ChatCompletionResponseDto,
  ModelsResponseDto,
} from './dto/chat-completion.response.dto.js';

/**
 * Controller for router endpoints
 */
@Controller()
export class RouterController {
  private readonly logger = new Logger(RouterController.name);

  constructor(
    private readonly routerService: RouterService,
    private readonly modelsService: ModelsService,
    @Inject(ROUTER_CONFIG) private readonly config: RouterConfig,
  ) {}

  /**
   * Chat completion endpoint (OpenAI compatible)
   * POST /api/v1/chat/completions
   * Supports both streaming (SSE) and non-streaming modes
   */
  @Post('chat/completions')
  @HttpCode(HttpStatus.OK)
  public async chatCompletion(
    @Body() request: ChatCompletionRequestDto,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ): Promise<ChatCompletionResponseDto | void> {
    const abortController = new AbortController();
    const signal = abortController.signal;

    const abortRequest = (reason: string) => {
      try {
        if (!signal.aborted) {
          this.logger.debug(`Request cancelled: ${reason}`);
          abortController.abort();
        }
      } catch {
        // Ignore abort errors - request may have already completed
      }
    };

    const closeListener = () => abortRequest('client disconnected (req.close)');
    const abortedListener = () => abortRequest('client aborted request (req.aborted)');
    const responseCloseListener = () => abortRequest('response closed (res.close)');

    req.raw.on('close', closeListener);
    req.raw.on('aborted', abortedListener);
    res.raw.on('close', responseCloseListener);

    try {
      // Check if streaming is requested
      if (request.stream) {
        const timeoutSecs = request.timeout_secs ?? this.config.routing.timeoutSecs;
        const timeoutMs = timeoutSecs * 1000;

        const onTimeout = () => {
          abortRequest(`stream timeout (${timeoutSecs}s)`);
          if (!res.raw.destroyed) {
            res.raw.destroy(new Error('Stream timeout'));
          }
        };

        res.raw.setTimeout(timeoutMs, onTimeout);
        if (res.raw.socket) {
          res.raw.socket.setTimeout(timeoutMs, onTimeout);
        }

        // Set SSE headers
        res.raw.setHeader('Content-Type', 'text/event-stream');
        res.raw.setHeader('Cache-Control', 'no-cache');
        res.raw.setHeader('Connection', 'keep-alive');

        const waitForDrain = async (): Promise<void> => {
          if (signal.aborted) {
            abortRequest('client disconnected');
            return;
          }

          await new Promise<void>((resolve, reject) => {
            const timeoutId = setTimeout(() => {
              reject(new Error(`Backpressure timeout (${timeoutSecs}s)`));
            }, timeoutMs);

            const onDrain = () => {
              clearTimeout(timeoutId);
              resolve();
            };

            const onAbort = () => {
              clearTimeout(timeoutId);
              reject(new Error('Aborted'));
            };

            res.raw.once('drain', onDrain);
            signal.addEventListener('abort', onAbort, { once: true });
          });
        };

        const writeSse = async (payload: string): Promise<void> => {
          if (signal.aborted || res.raw.writableEnded || res.raw.destroyed) {
            return;
          }

          const ok = res.raw.write(payload);
          if (!ok) {
            await waitForDrain();
          }
        };

        // Stream chunks
        try {
          for await (const chunk of this.routerService.chatCompletionStream(request, signal)) {
            // Format as SSE event
            const sseData: Record<string, unknown> = {
              id: chunk.id,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: chunk.model,
              choices: [
                {
                  index: 0,
                  delta: chunk.delta,
                  finish_reason: chunk.finishReason ?? null,
                },
              ],
            };

            // Include router metadata if present (usually in first chunk)
            if (chunk._router) {
              sseData._router = chunk._router;
            }

            await writeSse(`data: ${JSON.stringify(sseData)}\n\n`);
          }

          // Send [DONE] message
          await writeSse('data: [DONE]\n\n');
          if (!res.raw.writableEnded) {
            res.raw.end();
          }
        } catch (error) {
          if (signal.aborted) {
            this.logger.debug('Streaming request cancelled due to client disconnection');
            return;
          } else {
            this.logger.error(
              `Streaming chat completion failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          // Try to send error as SSE if stream not ended
          if (!res.raw.writableEnded) {
            await writeSse(
              `data: ${JSON.stringify({ error: { message: error instanceof Error ? error.message : 'Unknown error' } })}\n\n`,
            );
            if (!res.raw.writableEnded) {
              res.raw.end();
            }
          }
          throw error;
        }
      } else {
        // Non-streaming mode
        const response = await this.routerService.chatCompletion(request, signal);
        res.send(response);
        return response;
      }
    } catch (error) {
      if (!request.stream) {
        if (signal.aborted) {
          this.logger.debug('Request cancelled due to client disconnection');
        } else {
          this.logger.error(
            `Chat completion failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        throw error;
      }
      // For streaming, error already handled above
    } finally {
      req.raw.off('close', closeListener);
      req.raw.off('aborted', abortedListener);
      res.raw.off('close', responseCloseListener);
    }
  }

  /**
   * Get available models
   * GET /api/v1/models
   */
  @Get('models')
  public getModels(): ModelsResponseDto {
    const models = this.modelsService.getAvailable();

    return {
      models: models.map(model => ({
        name: model.name,
        provider: model.provider,
        model: model.model,
        type: model.type,
        contextSize: model.contextSize,
        maxOutputTokens: model.maxOutputTokens,
        tags: model.tags,
        jsonResponse: model.jsonResponse,
        available: model.available,
        weight: model.weight,

        // Multimodal support fields
        supportsImage: model.supportsImage,
        supportsVideo: model.supportsVideo,
        supportsAudio: model.supportsAudio,
        supportsFile: model.supportsFile,
      })),
    };
  }
}
