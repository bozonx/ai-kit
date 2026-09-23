import type { GlossaryEntry } from './glossary.js';
import { detectTranslationProblems, type TranslationProblem } from './quality.js';

/** Whether a deterministic check may trigger one paid repair pass. */
export type TranslationQualityGate = 'off' | 'on_problems' | 'always';

export interface TranslationQualityReport {
  gate: TranslationQualityGate;
  problems: TranslationProblem[];
  repaired: boolean;
  remainingProblems: TranslationProblem[];
  /** The optional repair failed, so the usable first pass was kept. */
  repairFailed?: boolean;
}

export interface TranslationPassResult {
  translation: string;
  /** A provider-detected source language, when the caller did not specify one. */
  detectedSourceLanguage?: string;
}

export interface TranslationRepairInput<TFirst extends TranslationPassResult> {
  source: string;
  translation: string;
  problems: TranslationProblem[];
  first: TFirst;
}

export interface TranslationPipelineInput<
  TFirst extends TranslationPassResult,
  TRepair extends TranslationPassResult,
> {
  source: string;
  sourceLanguage?: string;
  targetLanguage: string;
  glossary?: GlossaryEntry[];
  qualityGate: TranslationQualityGate;
  firstPass: () => Promise<TFirst>;
  repair?: (input: TranslationRepairInput<TFirst>) => Promise<TRepair>;
  /** Defaults to throwing. `keep_first` returns the checked first pass instead. */
  repairFailure?: 'throw' | 'keep_first';
}

export interface TranslationPipelineResult<
  TFirst extends TranslationPassResult,
  TRepair extends TranslationPassResult,
> {
  translation: string;
  first: TFirst;
  repair?: TRepair;
  quality: TranslationQualityReport;
}

/**
 * Runs one translation, the free deterministic checks, and at most one repair.
 *
 * The callbacks keep provider calls and product accounting outside the helper;
 * the invariant that a quality policy never starts an unbounded paid loop lives
 * here once for every consumer.
 */
export async function runTranslationPipeline<
  TFirst extends TranslationPassResult,
  TRepair extends TranslationPassResult = TranslationPassResult,
>(
  input: TranslationPipelineInput<TFirst, TRepair>,
): Promise<TranslationPipelineResult<TFirst, TRepair>> {
  const first = await input.firstPass();
  const sourceLanguage = input.sourceLanguage ?? first.detectedSourceLanguage;
  const check = (translated: string) =>
    detectTranslationProblems({
      source: input.source,
      translated,
      sourceLang: sourceLanguage,
      targetLang: input.targetLanguage,
      glossary: input.glossary,
    });
  const problems = check(first.translation);
  const shouldRepair =
    input.repair !== undefined &&
    (input.qualityGate === 'always' ||
      (input.qualityGate === 'on_problems' && problems.length > 0));

  if (!shouldRepair || !input.repair) {
    return {
      translation: first.translation,
      first,
      quality: {
        gate: input.qualityGate,
        problems,
        repaired: false,
        remainingProblems: problems,
      },
    };
  }

  let repair: TRepair;
  try {
    repair = await input.repair({
      source: input.source,
      translation: first.translation,
      problems,
      first,
    });
  } catch (error) {
    if (input.repairFailure !== 'keep_first' || isAbort(error)) throw error;
    return {
      translation: first.translation,
      first,
      quality: {
        gate: input.qualityGate,
        problems,
        repaired: false,
        remainingProblems: problems,
        repairFailed: true,
      },
    };
  }
  return {
    translation: repair.translation,
    first,
    repair,
    quality: {
      gate: input.qualityGate,
      problems,
      repaired: true,
      remainingProblems: check(repair.translation),
    },
  };
}

function isAbort(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: string; kind?: string };
  return candidate.name === 'AbortError' || candidate.kind === 'aborted';
}
