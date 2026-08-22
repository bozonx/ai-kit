/**
 * Robustly parses JSON from a string, handling common LLM pitfalls like markdown code blocks.
 */
export class JsonParser {
  /**
   * Parse JSON from a string, stripping markdown backticks if present.
   *
   * @param text The string to parse
   * @returns The parsed object or undefined if parsing failed
   */
  public static safeParse(text: string | null | undefined): any | undefined {
    if (!text) {
      return undefined;
    }

    const cleanedText = this.cleanJsonString(text);
    if (!cleanedText) {
      return undefined;
    }

    try {
      return JSON.parse(cleanedText);
    } catch {
      // If direct parse fails, try to extract first block that looks like JSON
      try {
        const extracted = this.extractJson(cleanedText);
        if (extracted) {
          return JSON.parse(extracted);
        }
      } catch {
        // Ignore second failure
      }
      return undefined;
    }
  }

  /**
   * Strips markdown code blocks and trims the string.
   */
  private static cleanJsonString(text: string): string {
    let cleaned = text.trim();

    // Remove markdown code blocks (e.g., ```json\n...\n``` or ```\n...\n```)
    const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)\s*```/i;
    const match = cleaned.match(codeBlockRegex);

    if (match && match[1]) {
      cleaned = match[1].trim();
    }

    return cleaned;
  }

  /**
   * Attempts to extract a JSON block from a string if it contains extra text.
   * Finds the first { or [ and the last } or ].
   */
  private static extractJson(text: string): string | undefined {
    const firstBrace = text.indexOf('{');
    const firstBracket = text.indexOf('[');

    let start = -1;
    let endChar = '';

    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
      start = firstBrace;
      endChar = '}';
    } else if (firstBracket !== -1) {
      start = firstBracket;
      endChar = ']';
    }

    if (start === -1) {
      return undefined;
    }

    const lastEnd = text.lastIndexOf(endChar);
    if (lastEnd === -1 || lastEnd < start) {
      return undefined;
    }

    return text.substring(start, lastEnd + 1);
  }
}
