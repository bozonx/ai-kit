/**
 * A source text and its translation, cut into pairs that still correspond.
 *
 * A repair pass over a long translation has to be sent in pieces, and a piece
 * is only useful if its translation half says what its source half says. Cutting
 * both at the same proportion of their length does not achieve that — languages
 * differ in length sentence by sentence — and cuts through the middle of words.
 * So the texts are cut where they have the same structure: at paragraphs when
 * both have the same number of them, then lines, then sentences. Only when no
 * level agrees is the cut proportional, and even then it lands on a boundary.
 */

export interface ParallelPair {
  source: string;
  translated: string;
}

/** Separators, coarsest first. Each unit keeps the separator that ends it. */
const LEVELS: readonly RegExp[] = [/\n[^\S\n]*\n\s*/g, /\n/g, /[.!?…。！？]+\s+/g];

/** Boundaries a proportional cut may snap to, best first. */
const SNAP: readonly RegExp[] = [/\n/g, /[.!?…。！？]+\s+/g, /\s+/g];

/**
 * Splits two texts into corresponding pairs whose combined length stays near
 * `combinedLimit`.
 *
 * Joining every `source` gives the source back exactly, and joining every
 * `translated` gives the translation back, so the pieces of a repaired
 * translation can simply be concatenated. The limit is a target, not a hard
 * ceiling: a cut moved to the nearest boundary may overshoot it slightly.
 */
export function splitParallelText(
  source: string,
  translated: string,
  combinedLimit: number,
): ParallelPair[] {
  if (!Number.isInteger(combinedLimit) || combinedLimit < 1) {
    throw new RangeError('combinedLimit must be a positive integer');
  }
  return split({ source, translated }, combinedLimit, 0);
}

function split(pair: ParallelPair, limit: number, level: number): ParallelPair[] {
  if (size(pair) <= limit) return [pair];

  for (let depth = level; depth < LEVELS.length; depth += 1) {
    const separator = LEVELS[depth] as RegExp;
    const sources = segment(pair.source, separator);
    const translations = segment(pair.translated, separator);
    if (sources.length < 2 || sources.length !== translations.length) continue;

    const units = sources.map((unit, index) => ({
      source: unit,
      translated: translations[index] ?? '',
    }));
    return group(units, limit).flatMap(grouped =>
      size(grouped) > limit ? split(grouped, limit, depth + 1) : [grouped],
    );
  }

  return proportional(pair, limit);
}

/** Consecutive units merged while they fit together. */
function group(units: readonly ParallelPair[], limit: number): ParallelPair[] {
  const groups: ParallelPair[] = [];
  let current: ParallelPair | null = null;
  for (const unit of units) {
    if (current && size(current) + size(unit) <= limit) {
      current = {
        source: current.source + unit.source,
        translated: current.translated + unit.translated,
      };
      continue;
    }
    if (current) groups.push(current);
    current = unit;
  }
  if (current) groups.push(current);
  return groups;
}

function proportional(pair: ParallelPair, limit: number): ParallelPair[] {
  const parts = Math.ceil(size(pair) / limit);
  const sourceCuts = cuts(pair.source, parts);
  const translatedCuts = cuts(pair.translated, parts);
  const result: ParallelPair[] = [];
  for (let index = 0; index < parts; index += 1) {
    result.push({
      source: pair.source.slice(sourceCuts[index], sourceCuts[index + 1]),
      translated: pair.translated.slice(translatedCuts[index], translatedCuts[index + 1]),
    });
  }
  return result.filter(item => item.source || item.translated);
}

/** Cut positions for `parts` pieces, each moved to the best nearby boundary. */
function cuts(text: string, parts: number): number[] {
  const positions = [0];
  const reach = Math.floor(text.length / parts / 4);
  for (let index = 1; index < parts; index += 1) {
    const target = Math.floor((text.length * index) / parts);
    const previous = positions[positions.length - 1] ?? 0;
    positions.push(Math.max(previous, snap(text, target, reach)));
  }
  positions.push(text.length);
  return positions;
}

function snap(text: string, target: number, reach: number): number {
  const from = Math.max(0, target - reach);
  const window = text.slice(from, target + reach);
  for (const boundary of SNAP) {
    let best: number | null = null;
    for (const match of window.matchAll(boundary)) {
      const end = from + match.index + match[0].length;
      if (best === null || Math.abs(end - target) < Math.abs(best - target)) best = end;
    }
    if (best !== null) return best;
  }
  return target;
}

function segment(text: string, separator: RegExp): string[] {
  const units: string[] = [];
  let last = 0;
  for (const match of text.matchAll(separator)) {
    const end = match.index + match[0].length;
    if (end === text.length) break;
    units.push(text.slice(last, end));
    last = end;
  }
  units.push(text.slice(last));
  return units;
}

function size(pair: ParallelPair): number {
  return pair.source.length + pair.translated.length;
}
