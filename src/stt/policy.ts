import type { ModelDefinition } from '../catalog/schema.js';
import { AiError } from '../errors.js';
import type { TranscriptionOptions } from './types.js';

/**
 * Options a model cannot honour are refused, not ignored.
 *
 * At one provider this looks like bureaucracy. At five it is the whole
 * difference between being multi-provider and having diarization that silently
 * stops working depending on who answered — a defect nobody reports, because
 * from the outside it looks like the feature was never on.
 *
 * `keyterms` is deliberately absent: biasing towards a word list is an
 * improvement, and a model without it should still transcribe.
 */
export function assertSttCapabilities(
  model: ModelDefinition,
  options: TranscriptionOptions,
  realtime = false,
): void {
  const capabilities = model.sttCapabilities;
  const unsupported: string[] = [];

  if (realtime && !capabilities?.realtime) unsupported.push('realtime');
  if (options.diarization && !capabilities?.diarization) unsupported.push('diarization');
  if (options.wordTimings && !capabilities?.wordTimings) unsupported.push('wordTimings');
  if (options.punctuation !== undefined && !capabilities?.punctuation) {
    unsupported.push('punctuation');
  }
  if (!options.language && !capabilities?.languageDetection) {
    unsupported.push('languageDetection');
  }

  if (unsupported.length > 0) {
    throw new AiError(
      'invalid_request',
      `Model "${model.name}" does not support: ${unsupported.join(', ')}`,
      { provider: model.provider, model: model.name },
    );
  }
}
