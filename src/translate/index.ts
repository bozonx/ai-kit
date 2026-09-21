/**
 * `@bozonx/ai-kit/translate` — translation extras.
 *
 * Translating itself is `AiKit.translate` from the main entry point. What is
 * here is the engine adapter, the interfaces a new one implements, the binding
 * glossary and the deterministic quality detectors — which apply just as well
 * to a translation a language model produced.
 */

export { googleCloudTranslationProvider } from './providers/google-cloud.js';

export type {
  TranslationProvider,
  TranslationProviderFactory,
  TranslationRequest,
  ProviderTranslateRequest,
} from './types.js';

export {
  glossaryEntryOccurs,
  glossaryRendering,
  selectGlossaryForText,
  renderGlossaryForPrompt,
  restoreKeptTerms,
  findGlossaryViolations,
} from './glossary.js';
export type { GlossaryEntry } from './glossary.js';

export { splitParallelText } from './parallel.js';
export type { ParallelPair } from './parallel.js';

export {
  TRANSLATION_PROBLEM_CODES,
  TRANSLATION_QUALITY_THRESHOLDS,
  detectTranslationProblems,
  renderProblemsForPrompt,
} from './quality.js';
export type {
  TranslationProblem,
  TranslationProblemCode,
  TranslationQualityInput,
} from './quality.js';
