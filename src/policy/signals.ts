import type { ModelMessage } from 'ai';

import { estimateTokens } from '../catalog/pricing.js';
import type { PolicySignals } from './policy.js';

/**
 * What an image costs in input tokens, for the estimate.
 *
 * Providers disagree — a few hundred at one, over a thousand at another for a
 * large picture — and the estimate feeds a context check and a spend hold, both
 * of which are safer too high than too low.
 */
const IMAGE_TOKENS = 1_000;

/**
 * The signals a request carries by its shape alone.
 *
 * Every consumer otherwise writes this next to its call and gets it slightly
 * wrong: counting only string contents misses every multi-part message, and a
 * request whose images nobody noticed is routed to a model that cannot see
 * them. What the shape cannot tell — the language, whether streaming or tools
 * are wanted — stays the caller's to add.
 */
export function signalsFor(input: {
  system?: string;
  messages: readonly ModelMessage[];
}): Pick<PolicySignals, 'estimatedInputTokens' | 'hasImages'> {
  let text = input.system ?? '';
  let images = 0;

  for (const message of input.messages) {
    if (typeof message.content === 'string') {
      text += `\n${message.content}`;
      continue;
    }
    for (const part of message.content) {
      switch (part.type) {
        case 'text':
        case 'reasoning':
          text += `\n${part.text}`;
          break;
        case 'image':
          images += 1;
          break;
        case 'file':
          if (part.mediaType.startsWith('image/')) images += 1;
          break;
        case 'tool-call':
          text += `\n${JSON.stringify(part.input)}`;
          break;
        case 'tool-result':
          text += `\n${JSON.stringify(part.output)}`;
          break;
        default:
          break;
      }
    }
  }

  return {
    estimatedInputTokens: estimateTokens(text) + images * IMAGE_TOKENS,
    ...(images > 0 ? { hasImages: true } : {}),
  };
}
