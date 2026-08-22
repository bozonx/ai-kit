import { Injectable } from '@nestjs/common';
import type { ChatCompletionRequestDto } from '../dto/chat-completion.request.dto.js';
import type { ChatCompletionParams } from '../../providers/interfaces/provider.interface.js';

@Injectable()
export class RequestBuilderService {
  /**
   * Check if request contains image content (multimodal)
   */
  public hasImageContent(messages: ChatCompletionRequestDto['messages']): boolean {
    return messages.some(
      msg => Array.isArray(msg.content) && msg.content.some(part => part.type === 'image_url'),
    );
  }

  public buildChatCompletionParams(
    request: ChatCompletionRequestDto,
    modelId: string,
    abortSignal?: AbortSignal,
  ): ChatCompletionParams {
    return {
      model: modelId,
      messages: request.messages.map(msg => ({
        role: msg.role,
        content: msg.content,
        name: msg.name,
        tool_calls: msg.tool_calls,
        tool_call_id: msg.tool_call_id,
      })),
      tools: request.tools,
      toolChoice: request.tool_choice,
      temperature: request.temperature,
      maxTokens: request.max_tokens,
      topP: request.top_p,
      frequencyPenalty: request.frequency_penalty,
      presencePenalty: request.presence_penalty,
      stop: request.stop,
      responseFormat: request.response_format,
      timeoutSecs: request.timeout_secs,
      abortSignal,
    };
  }
}
