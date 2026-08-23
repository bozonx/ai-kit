import type { RoutedBy, TokenUsage } from '../ports.js';
import type { AiErrorKind } from '../errors.js';

/**
 * The vocabulary a streamed answer is made of.
 *
 * Exported as types precisely so the consumer's frontend imports these instead
 * of describing them a second time. Two hand-written copies of a wire format,
 * one on each side of an SSE connection, drift the first time a field is added
 * — and the symptom is a chat that silently stops showing tool activity.
 */

/** Which model is answering. Sent first, so the UI can show it before any text. */
export interface ModelPart {
  type: 'model';
  provider: string;
  model: string;
  routedBy: RoutedBy;
}

/** A chunk of the answer. */
export interface TextDeltaPart {
  type: 'text-delta';
  text: string;
}

/**
 * Thinking, where the provider exposes it separately.
 *
 * Kept apart from `text-delta` because it is not the answer and must not be
 * pasted into a document as if it were.
 */
export interface ReasoningDeltaPart {
  type: 'reasoning-delta';
  text: string;
}

/** A tool is about to run. Showing which one is half of perceived quality. */
export interface ToolCallPart {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface ToolResultPart {
  type: 'tool-result';
  toolCallId: string;
  toolName: string;
  result: unknown;
  /** A failed tool is a result, not an exception: the model can react to it. */
  isError?: boolean;
}

/** Where the claims came from, for attribution under the answer. */
export interface SourcesPart {
  type: 'sources';
  sources: Array<{ title?: string; url: string; snippet?: string }>;
}

/** Final accounting. Arrives once, at the end of a successful stream. */
export interface UsagePart {
  type: 'usage';
  usage: TokenUsage;
  costMicros: number;
  priceVersion: string;
}

/**
 * The stream ended badly.
 *
 * `recoverable` distinguishes "press retry" from "this will not work" — the
 * only thing the UI actually needs to decide which button to show.
 */
export interface ErrorPart {
  type: 'error';
  kind: AiErrorKind;
  message: string;
  recoverable: boolean;
}

/** Clean end of stream. */
export interface FinishPart {
  type: 'finish';
  /** Provider's stop reason, normalised: 'stop' | 'length' | 'tool-calls' | 'content-filter'. */
  finishReason: string;
}

export type StreamPart =
  | ModelPart
  | TextDeltaPart
  | ReasoningDeltaPart
  | ToolCallPart
  | ToolResultPart
  | SourcesPart
  | UsagePart
  | ErrorPart
  | FinishPart;

export type StreamPartType = StreamPart['type'];
