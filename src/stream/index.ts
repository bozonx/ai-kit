/**
 * `@bozonx/ai-kit/stream` — what a browser needs to read a streamed answer.
 *
 * The part types and the SSE codec, and nothing that resolves Node or the AI
 * SDK: a frontend imports this entry point, never the main one.
 */

export type {
  StreamPart,
  StreamPartType,
  ModelPart,
  TextDeltaPart,
  ReasoningDeltaPart,
  ToolCallPart,
  ToolResultPart,
  SourcesPart,
  UsagePart,
  ErrorPart,
  FinishPart,
} from './stream-parts.js';

export type { CallAccounting, RoutedBy, TokenUsage } from '../ports.js';
export type { AiErrorKind } from '../errors.js';

export { encodeSse, SseDecoder } from './sse.js';
export type { SseMessage } from './sse.js';
