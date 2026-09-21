import type { WordTiming } from './types.js';

/** A word timing as it belongs to one segment. Milliseconds, like everything else. */
export interface SegmentWord {
  startMs: number;
  endMs: number;
  text: string;
}

/**
 * Hand each segment the words that fall inside it.
 *
 * Providers return one flat word list for the whole recording and segments
 * separately, so somebody has to put the two together. Doing it once, when the
 * transcript is stored, is what lets `renderSubtitles` cut a long cue on a real
 * pause rather than proportionally to the word count — and doing it then rather
 * than at render time means an edited segment can simply drop its words instead
 * of having to re-derive which ones no longer apply.
 *
 * A word is assigned by its midpoint, so a word straddling a boundary lands in
 * exactly one segment instead of both or neither.
 */
export function segmentWords(
  segments: readonly { startMs: number; endMs: number }[],
  words: readonly WordTiming[] | undefined,
): (SegmentWord[] | undefined)[] {
  if (!words?.length) return segments.map(() => undefined);

  const sorted = [...words].sort((left, right) => left.startMs - right.startMs);
  const buckets: SegmentWord[][] = segments.map(() => []);
  let cursor = 0;

  for (const word of sorted) {
    const midpoint = (word.startMs + word.endMs) / 2;
    // Segments arrive in order, so the search only ever moves forwards.
    while (cursor < segments.length && (segments[cursor]?.endMs ?? 0) < midpoint) cursor += 1;
    const segment = segments[cursor];
    const bucket = buckets[cursor];
    if (!segment || !bucket || midpoint < segment.startMs) continue;
    bucket.push({
      startMs: Math.round(word.startMs),
      endMs: Math.round(word.endMs),
      text: word.text,
    });
  }

  return buckets.map(bucket => (bucket.length > 0 ? bucket : undefined));
}
