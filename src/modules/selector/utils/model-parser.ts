/**
 * Parsed model reference from user input
 */
export interface ModelReference {
  /**
   * Model name (without provider prefix)
   */
  name: string;

  /**
   * Provider name (optional, extracted from "provider/model" format)
   */
  provider?: string;
}

/**
 * Result of parsing model input
 */
export interface ParsedModelInput {
  /**
   * List of model references in priority order
   */
  models: ModelReference[];

  /**
   * If true, fall back to Smart Strategy after exhausting explicit models.
   * Set when "auto" is present in the input array.
   */
  allowAutoFallback: boolean;
}

/**
 * Parse a single model string in format "model" or "provider/model"
 */
function parseModelString(input: string): ModelReference | null {
  const trimmed = input.trim();

  if (!trimmed || trimmed === 'auto') {
    return null;
  }

  // Check for provider/model format
  const slashIndex = trimmed.indexOf('/');

  if (slashIndex > 0 && slashIndex < trimmed.length - 1) {
    return {
      provider: trimmed.substring(0, slashIndex),
      name: trimmed.substring(slashIndex + 1),
    };
  }

  return { name: trimmed };
}

/**
 * Parse model input from request.
 *
 * Supported formats:
 * - `"model-name"` — single model, any provider
 * - `"provider/model-name"` — single model from specific provider
 * - `["model1", "provider/model2"]` — priority list
 * - `["model1", "model2", "auto"]` — priority list with auto fallback to Smart Strategy
 *
 * @param input - Model field from request (string | string[] | undefined)
 * @returns Parsed model input with models array and allowAutoFallback flag
 */
export function parseModelInput(input: string | string[] | undefined): ParsedModelInput {
  // No input or "auto" — use Smart Strategy
  if (!input || input === 'auto') {
    return { models: [], allowAutoFallback: true };
  }

  // Single string
  if (typeof input === 'string') {
    const ref = parseModelString(input);
    return {
      models: ref ? [ref] : [],
      allowAutoFallback: !ref,
    };
  }

  // Array
  if (Array.isArray(input)) {
    const models: ModelReference[] = [];
    let allowAutoFallback = false;

    for (const item of input) {
      if (typeof item !== 'string') {
        continue;
      }

      const trimmed = item.trim().toLowerCase();

      if (trimmed === 'auto') {
        allowAutoFallback = true;
        // "auto" should be at the end, ignore anything after
        break;
      }

      const ref = parseModelString(item);
      if (ref) {
        models.push(ref);
      }
    }

    return { models, allowAutoFallback };
  }

  // Unknown format — fall back to Smart Strategy
  return { models: [], allowAutoFallback: true };
}

/**
 * Check if input contains multiple models (array with length > 1)
 */
export function hasMultipleModels(input: string | string[] | undefined): boolean {
  return Array.isArray(input) && input.filter(m => m !== 'auto').length > 1;
}
