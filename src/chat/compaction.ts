import { estimateTokens as defaultEstimate } from '../catalog/pricing.js';

/**
 * How much of a conversation is sent back to the model.
 *
 * Without a window, a chat's cost per turn grows with its length until a long
 * session costs more than everything else in the product put together — and
 * nobody notices, because every individual turn still works.
 */

/** The least a message has to carry to be windowed. */
export interface CompactableMessage {
  id: string;
  text: string;
}

export interface CompactionInput<M extends CompactableMessage> {
  /** Oldest first. */
  messages: readonly M[];
  /** The rolling summary of what has already been dropped, if any. */
  summary: string | null;
  /**
   * Id of the newest message the summary already covers. Everything dropped
   * after it is what a rebuilt summary has to take in.
   */
  summaryCoversThrough?: string | null;
  maxMessages: number;
  tokenBudget: number;
  /** Defaults to the package's own estimate, the one pricing uses. */
  estimateTokens?: (text: string) => number;
}

export interface CompactionResult<M extends CompactableMessage> {
  /** Messages to send verbatim, oldest first. */
  kept: M[];
  /** Messages that fell outside the window, oldest first. */
  dropped: M[];
  /** Dropped messages the summary does not cover yet, oldest first. */
  unsummarized: M[];
  /** The summary to send, or null when nothing older than the window exists. */
  summary: string | null;
  /**
   * True when the summary no longer covers everything that was dropped, so the
   * caller should rebuild it. Separate from `dropped` because dropping is
   * normal and rebuilding costs a model call.
   */
  summaryStale: boolean;
}

/**
 * Keeps the last messages that fit, and reports what fell off.
 *
 * The window is counted backwards from the newest message, because that is the
 * one the answer is about. Both bounds apply: the token budget is what protects
 * cost, and the message count keeps a chat of very short turns from sending two
 * hundred of them. The summary is counted against the same budget.
 */
export function compactHistory<M extends CompactableMessage>(
  input: CompactionInput<M>,
): CompactionResult<M> {
  const estimate = input.estimateTokens ?? defaultEstimate;
  const kept: M[] = [];
  let used = estimate(input.summary ?? '');

  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (!message) continue;

    const cost = estimate(message.text);
    const wouldExceed = used + cost > input.tokenBudget || kept.length >= input.maxMessages;

    // The newest message is always kept: refusing to send what the user just
    // typed because it is long is worse than an expensive turn.
    if (wouldExceed && kept.length > 0) break;

    used += cost;
    kept.unshift(message);
  }

  const dropped = input.messages.slice(0, input.messages.length - kept.length);
  const covered = input.summaryCoversThrough
    ? dropped.findIndex(message => message.id === input.summaryCoversThrough)
    : -1;
  const unsummarized = dropped.slice(covered + 1);

  return {
    kept,
    dropped,
    unsummarized,
    summary: dropped.length > 0 ? input.summary : null,
    summaryStale: unsummarized.length > 0,
  };
}
