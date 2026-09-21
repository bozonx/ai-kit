/**
 * The deterministic layer between a translation and the person who asked for it.
 *
 * No model takes part in the detection itself. That is the point: detectors
 * have to be fast, free and explainable, because they run on every translation
 * and because their output is shown to the customer and used to justify a
 * second paid call.
 *
 * Every detector compares the translation against its own source rather than
 * against an abstract norm. A text that arrives half in English and half in
 * Russian is not a translation defect, and a repair pass launched at it would
 * be charged for fixing the customer's own input.
 *
 * Pure string work, no I/O, so a server and a browser can both run it.
 */

import { findGlossaryViolations, type GlossaryEntry } from './glossary.js';

export const TRANSLATION_PROBLEM_CODES = [
  /** Characters from a writing system the target language does not use. */
  'foreign_script',
  /** Long stretches came back exactly as they went in. */
  'untranslated',
  /** The result is implausibly shorter or longer than the source. */
  'length_gap',
  /** Headings, lists or code blocks were lost or invented. */
  'structure',
  /** A URL, placeholder, mention or hashtag changed. */
  'placeholders',
  /** The same fragment repeated over and over. */
  'looping',
  /** The text stops in the middle of a sentence. */
  'truncation',
  /** A glossary term was rendered against the glossary. */
  'glossary',
] as const;

export type TranslationProblemCode = (typeof TRANSLATION_PROBLEM_CODES)[number];

export interface TranslationProblem {
  code: TranslationProblemCode;
  /**
   * What exactly was found, in a form both the repair prompt and the UI can
   * use. Short and concrete — "https://example.com, {{name}}" — never prose.
   */
  detail?: string;
}

export interface TranslationQualityInput {
  source: string;
  translated: string;
  sourceLang?: string;
  targetLang: string;
  glossary?: GlossaryEntry[];
}

/** Thresholds live here rather than inline so they can be quoted in the docs. */
export const TRANSLATION_QUALITY_THRESHOLDS = {
  /** Share of letters from an unexpected script, above the source's own share. */
  foreignScript: 0.005,
  /** Share of the text that came back byte-identical to the source. */
  untranslated: 0.2,
  lengthGapMin: 0.5,
  lengthGapMax: 2,
  /** Shortest fragment whose threefold repetition counts as a loop. */
  loopFragment: 30,
} as const;

/**
 * The writing systems a language is written in.
 *
 * Deliberately coarse: the question is "did Chinese characters appear in a
 * Spanish translation", not "is this transliteration correct". Languages that
 * are absent fall back to accepting everything, which is the right failure —
 * a missing entry must never invent a defect.
 */
const SCRIPTS: Record<string, RegExp> = {
  latin: /\p{Script=Latin}/u,
  cyrillic: /\p{Script=Cyrillic}/u,
  greek: /\p{Script=Greek}/u,
  arabic: /\p{Script=Arabic}/u,
  hebrew: /\p{Script=Hebrew}/u,
  han: /\p{Script=Han}/u,
  kana: /\p{Script=Hiragana}|\p{Script=Katakana}/u,
  hangul: /\p{Script=Hangul}/u,
  devanagari: /\p{Script=Devanagari}/u,
  thai: /\p{Script=Thai}/u,
  armenian: /\p{Script=Armenian}/u,
  georgian: /\p{Script=Georgian}/u,
};

const LANGUAGE_SCRIPTS: Record<string, (keyof typeof SCRIPTS)[]> = {
  ru: ['cyrillic', 'latin'],
  uk: ['cyrillic', 'latin'],
  be: ['cyrillic', 'latin'],
  bg: ['cyrillic', 'latin'],
  sr: ['cyrillic', 'latin'],
  mk: ['cyrillic', 'latin'],
  kk: ['cyrillic', 'latin'],
  el: ['greek', 'latin'],
  ar: ['arabic', 'latin'],
  fa: ['arabic', 'latin'],
  ur: ['arabic', 'latin'],
  he: ['hebrew', 'latin'],
  zh: ['han', 'latin'],
  ja: ['kana', 'han', 'latin'],
  ko: ['hangul', 'han', 'latin'],
  hi: ['devanagari', 'latin'],
  mr: ['devanagari', 'latin'],
  ne: ['devanagari', 'latin'],
  th: ['thai', 'latin'],
  hy: ['armenian', 'latin'],
  ka: ['georgian', 'latin'],
};

const LATIN_LANGUAGES = new Set([
  'en',
  'de',
  'fr',
  'es',
  'pt',
  'it',
  'nl',
  'pl',
  'cs',
  'sk',
  'sl',
  'hr',
  'ro',
  'hu',
  'fi',
  'sv',
  'no',
  'nb',
  'da',
  'et',
  'lv',
  'lt',
  'tr',
  'az',
  'id',
  'ms',
  'vi',
  'sw',
  'ca',
  'gl',
  'eu',
  'af',
  'sq',
  'is',
  'tl',
]);

function baseLanguage(code: string | undefined): string | undefined {
  const trimmed = code?.trim().toLocaleLowerCase('und');
  if (!trimmed) return undefined;
  return trimmed.split(/[-_]/).at(0);
}

/** The scripts a target language may legitimately contain, or null if unknown. */
function expectedScripts(targetLang: string): RegExp[] | null {
  const base = baseLanguage(targetLang);
  if (!base) return null;
  const named = LANGUAGE_SCRIPTS[base];
  if (named) {
    return named
      .map(script => SCRIPTS[script])
      .filter((script): script is RegExp => script !== undefined);
  }
  const latin = SCRIPTS.latin;
  if (latin && LATIN_LANGUAGES.has(base)) return [latin];
  return null;
}

/** Share of letters that belong to none of the expected scripts. */
function foreignLetterShare(text: string, expected: RegExp[]): number {
  let letters = 0;
  let foreign = 0;
  for (const character of text) {
    if (!/\p{L}/u.test(character)) continue;
    letters += 1;
    if (!expected.some(script => script.test(character))) foreign += 1;
  }
  return letters === 0 ? 0 : foreign / letters;
}

function detectForeignScript(input: TranslationQualityInput): TranslationProblem | null {
  const expected = expectedScripts(input.targetLang);
  if (!expected) return null;

  const inTranslation = foreignLetterShare(input.translated, expected);
  // The source's own share is subtracted rather than ignored: a post about a
  // Japanese product legitimately keeps its name in kana, and the translation
  // keeping it too is correct behaviour, not a defect worth paying to repair.
  const inSource = foreignLetterShare(input.source, expected);
  if (inTranslation - inSource <= TRANSLATION_QUALITY_THRESHOLDS.foreignScript) return null;

  return {
    code: 'foreign_script',
    detail: `${(inTranslation * 100).toFixed(1)}% of letters are outside the writing systems of ${input.targetLang}`,
  };
}

/** Paragraph-sized pieces, which is the granularity a model leaves untouched. */
function segments(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map(part => part.trim())
    .filter(part => part.length >= 40);
}

function detectUntranslated(input: TranslationQualityInput): TranslationProblem | null {
  const source = baseLanguage(input.sourceLang);
  const target = baseLanguage(input.targetLang);
  if (source && target && source === target) return null;

  const sourceSegments = new Set(segments(input.source));
  if (sourceSegments.size === 0) return null;

  const translatedSegments = segments(input.translated);
  const untouched = translatedSegments.filter(segment => sourceSegments.has(segment));
  const untouchedLength = untouched.reduce((total, segment) => total + segment.length, 0);
  const share = input.translated.length === 0 ? 0 : untouchedLength / input.translated.length;
  if (share <= TRANSLATION_QUALITY_THRESHOLDS.untranslated) return null;

  return {
    code: 'untranslated',
    detail: `${Math.round(share * 100)}% of the result is identical to the source`,
  };
}

function detectLengthGap(input: TranslationQualityInput): TranslationProblem | null {
  // Short strings swing wildly by nature: "OK" translating to a five-word
  // phrase is a 10× ratio and perfectly correct.
  if (input.source.trim().length < 200) return null;
  const ratio = input.translated.length / input.source.length;
  if (
    ratio >= TRANSLATION_QUALITY_THRESHOLDS.lengthGapMin &&
    ratio <= TRANSLATION_QUALITY_THRESHOLDS.lengthGapMax
  ) {
    return null;
  }
  return { code: 'length_gap', detail: `the result is ${ratio.toFixed(2)}× the source in length` };
}

interface StructureCounts {
  headings: number;
  listItems: number;
  codeFences: number;
}

function structureOf(text: string): StructureCounts {
  const lines = text.split('\n');
  return {
    headings: lines.filter(line => /^\s{0,3}#{1,6}\s/.test(line)).length,
    listItems: lines.filter(line => /^\s*(?:[-*+]\s|\d+[.)]\s)/.test(line)).length,
    codeFences: lines.filter(line => /^\s*(?:```|~~~)/.test(line)).length,
  };
}

function detectStructure(input: TranslationQualityInput): TranslationProblem | null {
  const source = structureOf(input.source);
  const translated = structureOf(input.translated);
  const differences: string[] = [];
  if (source.headings !== translated.headings) {
    differences.push(`headings ${source.headings} → ${translated.headings}`);
  }
  if (source.listItems !== translated.listItems) {
    differences.push(`list items ${source.listItems} → ${translated.listItems}`);
  }
  if (source.codeFences !== translated.codeFences) {
    differences.push(`code fences ${source.codeFences} → ${translated.codeFences}`);
  }
  return differences.length ? { code: 'structure', detail: differences.join(', ') } : null;
}

const PLACEHOLDER_PATTERNS: RegExp[] = [
  /https?:\/\/[^\s)<>"'`]+/gu,
  /\{\{[^{}]+\}\}/gu,
  /(?<![\p{L}\p{N}_])@[\p{L}\p{N}_.]{2,}/gu,
  /(?<![\p{L}\p{N}_])#[\p{L}\p{N}_]{2,}/gu,
];

function placeholdersOf(text: string): string[] {
  const found: string[] = [];
  for (const pattern of PLACEHOLDER_PATTERNS) {
    found.push(...(text.match(new RegExp(pattern.source, pattern.flags)) ?? []));
  }
  return found;
}

function detectPlaceholders(input: TranslationQualityInput): TranslationProblem | null {
  const inSource = placeholdersOf(input.source);
  if (inSource.length === 0) return null;

  const remaining = new Map<string, number>();
  for (const item of placeholdersOf(input.translated)) {
    remaining.set(item, (remaining.get(item) ?? 0) + 1);
  }

  const lost: string[] = [];
  for (const item of inSource) {
    const left = remaining.get(item) ?? 0;
    if (left === 0) lost.push(item);
    else remaining.set(item, left - 1);
  }

  if (lost.length === 0) return null;
  return { code: 'placeholders', detail: [...new Set(lost)].slice(0, 10).join(', ') };
}

function loopingFragment(text: string): string | null {
  const size = TRANSLATION_QUALITY_THRESHOLDS.loopFragment;
  const match = new RegExp(`(.{${size},400}?)\\1{2,}`, 's').exec(text);
  return match?.[1] ?? null;
}

function detectLooping(input: TranslationQualityInput): TranslationProblem | null {
  const fragment = loopingFragment(input.translated);
  if (!fragment) return null;
  // A source that repeats itself — a table of identical rows, a refrain —
  // produces a repeating translation legitimately.
  if (loopingFragment(input.source)) return null;
  return { code: 'looping', detail: `${fragment.slice(0, 60).trim()}…` };
}

const SENTENCE_ENDINGS = /[.!?…。！？:;)"'»”』】\]]|\p{Emoji_Presentation}/u;

function endsCleanly(text: string): boolean {
  const trimmed = text.trimEnd();
  const last = [...trimmed].at(-1);
  if (!last) return true;
  return SENTENCE_ENDINGS.test(last);
}

function detectTruncation(input: TranslationQualityInput): TranslationProblem | null {
  // Only meaningful when the source itself ended properly: a fragment selected
  // mid-sentence in the editor is supposed to come back mid-sentence.
  if (!endsCleanly(input.source)) return null;
  if (endsCleanly(input.translated)) return null;
  return { code: 'truncation', detail: `…${input.translated.trimEnd().slice(-60)}` };
}

function detectGlossary(input: TranslationQualityInput): TranslationProblem | null {
  const entries = input.glossary ?? [];
  if (entries.length === 0) return null;
  const violations = findGlossaryViolations({
    source: input.source,
    translated: input.translated,
    entries,
    targetLanguage: input.targetLang,
  });
  return violations.length ? { code: 'glossary', detail: violations.join(', ') } : null;
}

/**
 * Everything the deterministic layer can say about one translation.
 *
 * Runs on every translation regardless of the profile's policy: detection is
 * free, and a result nobody checked is a result nobody can be warned about.
 * What the policy decides is only whether a repair pass is paid for.
 */
export function detectTranslationProblems(input: TranslationQualityInput): TranslationProblem[] {
  if (!input.translated.trim()) return [];
  const detectors = [
    detectForeignScript,
    detectUntranslated,
    detectLengthGap,
    detectStructure,
    detectPlaceholders,
    detectLooping,
    detectTruncation,
    detectGlossary,
  ];
  return detectors
    .map(detector => detector(input))
    .filter((found): found is TranslationProblem => found !== null);
}

const PROBLEM_INSTRUCTIONS: Record<TranslationProblemCode, string> = {
  foreign_script: 'characters from a writing system the target language does not use',
  untranslated: 'passages left in the source language',
  length_gap: 'content added or dropped relative to the source',
  structure: 'headings, lists or code blocks that no longer match the source',
  placeholders: 'links, placeholders, mentions or hashtags that were altered or lost',
  looping: 'a fragment repeated over and over',
  truncation: 'an ending that stops mid-sentence',
  glossary: 'terms rendered against the binding glossary',
};

/**
 * The problem list as the repair prompt receives it.
 *
 * "Fix these" and not "translate it again": the second pass is given what is
 * wrong so it can leave everything else alone, which is both cheaper and less
 * destructive than a fresh translation.
 */
export function renderProblemsForPrompt(problems: TranslationProblem[]): string {
  if (!problems.length) return '';
  const lines = problems.map(problem => {
    const what = PROBLEM_INSTRUCTIONS[problem.code];
    return problem.detail ? `- ${what} (${problem.detail})` : `- ${what}`;
  });
  return `Problems found by automatic checks:\n${lines.join('\n')}`;
}
