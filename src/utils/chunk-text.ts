/**
 * Splits text into pieces no longer than `maxChars`, cutting between words.
 *
 * Every engine and every model has a request limit, and a cut in the middle of
 * a word is translated or summarized as two broken halves. Each piece ends
 * just after the last line break, sentence end or space in its window, which
 * keeps the piece as long as the limit allows. A boundary is only accepted in
 * the last 40% of the window, so a stray early one does not produce a run of
 * tiny pieces; failing that, the cut is hard.
 *
 * Joining the pieces gives the original text back exactly.
 */
export function chunkText(text: string, maxChars: number): string[] {
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new RangeError('maxChars must be a positive integer');
  }
  if (text.length <= maxChars) return [text];

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const boundary = Math.max(
      window.lastIndexOf('\n\n'),
      window.lastIndexOf('\n'),
      window.lastIndexOf('. '),
      window.lastIndexOf('! '),
      window.lastIndexOf('? '),
      window.lastIndexOf(' '),
    );
    const end = boundary >= Math.floor(maxChars * 0.6) ? boundary + 1 : maxChars;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end);
  }
  if (rest) chunks.push(rest);
  return chunks;
}
