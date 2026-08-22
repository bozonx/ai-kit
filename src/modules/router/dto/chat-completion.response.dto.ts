import type { ToolCall } from '../../providers/interfaces/tools.interface.js';

/**
 * Router metadata included in responses
 */
export interface RouterMetadata {
  /**
   * Provider that handled the request
   */
  provider: string;

  /**
   * Model name used
   */
  model_name: string;

  /**
   * Number of attempts made
   */
  attempts: number;

  /**
   * Whether fallback model was used
   */
  fallback_used: boolean;

  /**
   * Errors from previous attempts (if any)
   */
  errors?: RouterErrorInfo[];

  /**
   * Parsed JSON data (only present when response_format requests JSON and content is valid JSON)
   */
  data?: unknown;
}

/**
 * Error information for failed attempts
 */
export interface RouterErrorInfo {
  /**
   * Provider that returned the error
   */
  provider: string;

  /**
   * Model that returned the error
   */
  model: string;

  /**
   * Error message
   */
  error: string;

  /**
   * HTTP status code (if available)
   */
  code?: number;
}

/**
 * Chat completion choice
 */
export interface ChatCompletionChoice {
  index: number;
  message: ChatCompletionMessage;
  finish_reason: 'stop' | 'length' | 'content_filter' | 'tool_calls';
}

/**
 * Chat completion message in response
 */
export interface ChatCompletionMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: ToolCall[];
}

/**
 * Token usage statistics
 */
export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

/**
 * Chat completion response DTO
 */
export interface ChatCompletionResponseDto {
  // Standard OpenAI fields
  /**
   * Unique completion ID
   */
  id: string;

  /**
   * Object type (always 'chat.completion')
   */
  object: 'chat.completion';

  /**
   * Unix timestamp of creation
   */
  created: number;

  /**
   * Model used for completion
   */
  model: string;

  /**
   * Completion choices
   */
  choices: ChatCompletionChoice[];

  /**
   * Token usage statistics
   */
  usage: ChatCompletionUsage;

  /**
   * Router-specific metadata
   */
  _router: RouterMetadata;
}

/**
 * Model info in models list response
 */
export interface ModelInfo {
  name: string;
  provider: string;
  model: string;
  type: 'fast' | 'reasoning';
  contextSize: number;
  maxOutputTokens: number;
  tags: string[];
  jsonResponse: boolean;
  available: boolean;
  weight?: number;

  supportsImage?: boolean;
  supportsVideo?: boolean;
  supportsAudio?: boolean;
  supportsFile?: boolean;
}

/**
 * Models list response DTO
 */
export interface ModelsResponseDto {
  models: ModelInfo[];
}
