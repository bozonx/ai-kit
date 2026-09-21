/**
 * Turning stored transcript segments into a subtitle file.
 *
 * A pure function and nothing else: the same segments are rendered for a
 * download, for an upload to a video host and for a player, and the three must
 * not be allowed to disagree about where a line breaks.
 *
 * Two rules drive everything below. A cue has to stay on screen long enough to
 * be read and short enough not to outlive what is being said, and cues must
 * never overlap — a player handed overlapping cues either drops one or draws
 * both on top of each other, and which of the two it does is not our decision
 * to leave to chance.
 */
export type SubtitleFormat = 'srt' | 'vtt';

/**
 * One word with its place on the timeline, as the provider measured it.
 *
 * A `WordTiming` satisfies it, which is the point: what a speech model
 * returned is what a subtitle is rendered from, with nothing in between to
 * convert one into the other and get it subtly wrong.
 */
export interface SubtitleWord {
  startMs: number;
  endMs: number;
  text: string;
}

export interface SubtitleSegment {
  startMs: number;
  endMs: number;
  text: string;
  speaker?: string | null;
  /**
   * Word timings for this segment, when the provider returned them.
   *
   * Only used to decide where a long segment is cut. Without them a cut lands
   * proportionally to the number of words, which assumes everybody speaks at a
   * constant rate; with them it lands on the silence between two words, which
   * is where a viewer expects it.
   */
  words?: readonly SubtitleWord[] | null;
}

export interface RenderSubtitlesOptions {
  format: SubtitleFormat;
  maxCharsPerLine?: number;
  minCueDurationMs?: number;
  maxCueDurationMs?: number;
  maxLinesPerCue?: number;
  maxMergeGapMs?: number;
}

interface ResolvedOptions {
  maxCharsPerLine: number;
  minCueDurationMs: number;
  maxCueDurationMs: number;
  maxLinesPerCue: number;
  maxMergeGapMs: number;
}

const DEFAULT_OPTIONS: ResolvedOptions = {
  maxCharsPerLine: 42,
  minCueDurationMs: 1_000,
  maxCueDurationMs: 7_000,
  maxLinesPerCue: 2,
  maxMergeGapMs: 500,
};

/**
 * The shortest cue worth emitting.
 *
 * Below this a player shows a flicker rather than a subtitle, and the cue is
 * better dropped than rendered — which is what happens when clamping a cue
 * against the start of the next one leaves it with almost no room.
 */
const MIN_RENDERABLE_CUE_MS = 40;

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function resolveOptions(options: RenderSubtitlesOptions): ResolvedOptions {
  const resolved = {
    maxCharsPerLine: positiveInteger(options.maxCharsPerLine, DEFAULT_OPTIONS.maxCharsPerLine),
    minCueDurationMs: positiveInteger(options.minCueDurationMs, DEFAULT_OPTIONS.minCueDurationMs),
    maxCueDurationMs: positiveInteger(options.maxCueDurationMs, DEFAULT_OPTIONS.maxCueDurationMs),
    maxLinesPerCue: positiveInteger(options.maxLinesPerCue, DEFAULT_OPTIONS.maxLinesPerCue),
    maxMergeGapMs: positiveInteger(options.maxMergeGapMs, DEFAULT_OPTIONS.maxMergeGapMs),
  };

  if (resolved.minCueDurationMs > resolved.maxCueDurationMs) {
    resolved.minCueDurationMs = resolved.maxCueDurationMs;
  }

  return resolved;
}

function normalizeWords(
  words: readonly SubtitleWord[] | null | undefined,
  startMs: number,
  endMs: number,
): SubtitleWord[] | undefined {
  if (!words?.length) return undefined;
  const normalized = words
    .map(word => ({
      startMs: Math.round(word.startMs),
      endMs: Math.round(word.endMs),
      text: word.text.replace(/\s+/gu, ' ').trim(),
    }))
    .filter(
      word =>
        word.text.length > 0 &&
        word.endMs >= word.startMs &&
        word.startMs >= startMs &&
        word.endMs <= endMs,
    )
    .sort((left, right) => left.startMs - right.startMs);

  return normalized.length > 0 ? normalized : undefined;
}

function normalizeSegments(segments: readonly SubtitleSegment[]): SubtitleSegment[] {
  return segments
    .map(segment => {
      const startMs = Math.max(0, Math.round(segment.startMs));
      const endMs = Math.max(0, Math.round(segment.endMs));
      const words = normalizeWords(segment.words, startMs, endMs);
      return {
        ...segment,
        startMs,
        endMs,
        text: segment.text.replace(/\s+/gu, ' ').trim(),
        ...(words ? { words } : { words: undefined }),
      };
    })
    .filter(segment => segment.text.length > 0 && segment.endMs > segment.startMs)
    .sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
}

function mergeShortSegments(
  segments: readonly SubtitleSegment[],
  options: ResolvedOptions,
): SubtitleSegment[] {
  const merged: SubtitleSegment[] = [];

  for (const segment of segments) {
    const previous = merged.at(-1);
    const canMerge =
      previous !== undefined &&
      previous.endMs - previous.startMs < options.minCueDurationMs &&
      segment.startMs - previous.endMs <= options.maxMergeGapMs &&
      segment.endMs - previous.startMs <= options.maxCueDurationMs &&
      previous.speaker === segment.speaker;

    if (canMerge) {
      previous.endMs = Math.max(previous.endMs, segment.endMs);
      previous.text = `${previous.text} ${segment.text}`;
      previous.words =
        previous.words && segment.words ? [...previous.words, ...segment.words] : undefined;
    } else {
      merged.push({ ...segment });
    }
  }

  return merged;
}

function splitLongWord(word: string, maxLength: number): string[] {
  const characters = Array.from(word);
  const parts: string[] = [];
  for (let index = 0; index < characters.length; index += maxLength) {
    parts.push(characters.slice(index, index + maxLength).join(''));
  }
  return parts;
}

function wrapText(text: string, maxCharsPerLine: number): string[] {
  const words = text
    .split(' ')
    .flatMap(word =>
      Array.from(word).length > maxCharsPerLine ? splitLongWord(word, maxCharsPerLine) : [word],
    );
  const lines: string[] = [];

  for (const word of words) {
    const previous = lines.at(-1);
    if (previous === undefined || Array.from(`${previous} ${word}`).length > maxCharsPerLine) {
      lines.push(word);
    } else {
      lines[lines.length - 1] = `${previous} ${word}`;
    }
  }

  return lines;
}

/**
 * Where each chunk of a split cue begins and ends.
 *
 * With word timings the boundary is the real gap between the last word of one
 * chunk and the first word of the next, so text and picture stay together
 * through a pause. Without them the segment's duration is divided evenly,
 * which is the best guess available and is what the timings replace.
 */
function chunkBounds(
  segment: SubtitleSegment,
  groups: readonly string[][],
): { startMs: number; endMs: number }[] {
  const duration = segment.endMs - segment.startMs;
  const proportional = groups.map((_, index) => ({
    startMs: segment.startMs + Math.round((duration * index) / groups.length),
    endMs: segment.startMs + Math.round((duration * (index + 1)) / groups.length),
  }));

  const words = segment.words;
  // One timing per word or the alignment is a guess wearing a disguise: a
  // provider that dropped a word would shift every boundary after it.
  if (words?.length !== groups.reduce((total, group) => total + group.length, 0)) {
    return proportional;
  }

  const bounds: { startMs: number; endMs: number }[] = [];
  let cursor = 0;
  for (const group of groups) {
    const first = words[cursor];
    const last = words[cursor + group.length - 1];
    cursor += group.length;
    if (!first || !last) return proportional;
    bounds.push({ startMs: first.startMs, endMs: Math.max(last.endMs, first.startMs + 1) });
  }

  // The first cue keeps the segment's own start and the last its own end, so a
  // provider that trims leading silence off its word list cannot shorten the
  // stretch of time the segment as a whole claims.
  const first = bounds[0];
  const last = bounds[bounds.length - 1];
  if (!first || !last) return proportional;
  first.startMs = segment.startMs;
  last.endMs = segment.endMs;
  return bounds;
}

function splitCue(segment: SubtitleSegment, options: ResolvedOptions): SubtitleSegment[] {
  const lines = wrapText(segment.text, options.maxCharsPerLine);
  const duration = segment.endMs - segment.startMs;
  const requestedChunkCount = Math.max(
    1,
    Math.ceil(lines.length / options.maxLinesPerCue),
    Math.ceil(duration / options.maxCueDurationMs),
  );
  const words = segment.text.split(' ');
  const chunkCount = Math.min(requestedChunkCount, words.length);
  if (chunkCount === 1) {
    return [
      {
        ...segment,
        endMs: Math.min(segment.endMs, segment.startMs + options.maxCueDurationMs),
        text: lines.join('\n'),
      },
    ];
  }

  const textGroups = Array.from({ length: chunkCount }, () => [] as string[]);
  words.forEach((word, index) => {
    const group = Math.min(chunkCount - 1, Math.floor((index * chunkCount) / words.length));
    textGroups[group]?.push(word);
  });

  const bounds = chunkBounds(segment, textGroups);

  return textGroups
    .map((group, index) => ({
      ...segment,
      startMs: bounds[index]?.startMs ?? segment.startMs,
      endMs: bounds[index]?.endMs ?? segment.endMs,
      text: wrapText(group.join(' '), options.maxCharsPerLine).join('\n'),
    }))
    .filter(cue => cue.text.length > 0 && cue.endMs > cue.startMs);
}

function formatTimestamp(milliseconds: number, format: SubtitleFormat): string {
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const millis = milliseconds % 1_000;
  const separator = format === 'srt' ? ',' : '.';
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${separator}${String(millis).padStart(3, '0')}`;
}

function applyMinimumDuration(
  cues: readonly SubtitleSegment[],
  options: ResolvedOptions,
): SubtitleSegment[] {
  return cues.map((cue, index) => {
    if (cue.endMs - cue.startMs >= options.minCueDurationMs) return cue;

    const nextStartMs = cues[index + 1]?.startMs ?? Number.POSITIVE_INFINITY;
    return {
      ...cue,
      endMs: Math.min(
        cue.startMs + options.minCueDurationMs,
        cue.startMs + options.maxCueDurationMs,
        nextStartMs,
      ),
    };
  });
}

/**
 * The last word on the timeline, applied after every other rule.
 *
 * Overlaps get here honestly: diarization returns segments that overlap when
 * two people talk at once, and clamping a short cue against its neighbour can
 * leave it with no duration at all. Both are fixed the same way — a cue ends
 * no later than the next one begins, and a cue with nothing left is dropped
 * rather than written out as a zero-length line some players reject outright.
 */
function enforceTimeline(cues: readonly SubtitleSegment[]): SubtitleSegment[] {
  const result: SubtitleSegment[] = [];
  let previousEndMs = 0;

  for (const [index, cue] of cues.entries()) {
    const startMs = Math.max(cue.startMs, previousEndMs);
    const nextStartMs = cues[index + 1]?.startMs ?? Number.POSITIVE_INFINITY;
    const endMs = Math.min(cue.endMs, nextStartMs);
    if (endMs - startMs < MIN_RENDERABLE_CUE_MS) continue;

    result.push({ ...cue, startMs, endMs });
    previousEndMs = endMs;
  }

  return result;
}

export function renderSubtitles(
  segments: readonly SubtitleSegment[],
  options: RenderSubtitlesOptions,
): string {
  const resolved = resolveOptions(options);
  const cues = enforceTimeline(
    applyMinimumDuration(
      mergeShortSegments(normalizeSegments(segments), resolved).flatMap(segment =>
        splitCue(segment, resolved),
      ),
      resolved,
    ),
  );
  const blocks = cues.map((cue, index) => {
    const timing = `${formatTimestamp(cue.startMs, options.format)} --> ${formatTimestamp(cue.endMs, options.format)}`;
    return options.format === 'srt'
      ? `${String(index + 1)}\n${timing}\n${cue.text}`
      : `${timing}\n${cue.text}`;
  });

  const body = blocks.length > 0 ? `${blocks.join('\n\n')}\n` : '';
  return options.format === 'vtt' ? `WEBVTT\n\n${body}` : body;
}
