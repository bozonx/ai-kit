import { describe, expect, it, jest } from '@jest/globals';

import { runTranslationPipeline } from '../src/translate/pipeline.js';

describe('translation quality pipeline', () => {
  it('repairs once when deterministic checks find a problem', async () => {
    const repair = jest.fn(() => Promise.resolve({ translation: 'Привет, {{name}}.' }));
    const result = await runTranslationPipeline({
      source: 'Hello, {{name}}.',
      sourceLanguage: 'en',
      targetLanguage: 'ru',
      qualityGate: 'on_problems',
      firstPass: () => Promise.resolve({ translation: 'Привет.' }),
      repair,
    });

    expect(repair).toHaveBeenCalledTimes(1);
    expect(result.translation).toBe('Привет, {{name}}.');
    expect(result.quality.problems.map(problem => problem.code)).toContain('placeholders');
    expect(result.quality.repaired).toBe(true);
    expect(result.quality.remainingProblems).toEqual([]);
  });

  it('does not pay for a repair when the result is clean', async () => {
    const repair = jest.fn(() => Promise.resolve({ translation: 'Исправлено.' }));
    const result = await runTranslationPipeline({
      source: 'Hello.',
      sourceLanguage: 'en',
      targetLanguage: 'ru',
      qualityGate: 'on_problems',
      firstPass: () => Promise.resolve({ translation: 'Привет.' }),
      repair,
    });

    expect(repair).not.toHaveBeenCalled();
    expect(result.quality.repaired).toBe(false);
  });

  it('runs exactly one repair when the gate is always', async () => {
    const repair = jest.fn(() => Promise.resolve({ translation: 'Hola.' }));
    await runTranslationPipeline({
      source: 'Hello.',
      targetLanguage: 'es',
      qualityGate: 'always',
      firstPass: () => Promise.resolve({ translation: 'Hola.' }),
      repair,
    });
    expect(repair).toHaveBeenCalledTimes(1);
  });

  it('can keep the checked first pass when an optional repair fails', async () => {
    const result = await runTranslationPipeline({
      source: 'Hello {{name}}.',
      targetLanguage: 'ru',
      qualityGate: 'on_problems',
      repairFailure: 'keep_first',
      firstPass: () => Promise.resolve({ translation: 'Привет.' }),
      repair: () => Promise.reject(new Error('provider down')),
    });

    expect(result.translation).toBe('Привет.');
    expect(result.quality.repairFailed).toBe(true);
  });

  it('uses a source language detected by the first pass', async () => {
    const repair = jest.fn(() => Promise.resolve({ translation: 'Still English.' }));
    const result = await runTranslationPipeline({
      source: 'A long English paragraph that is deliberately more than forty characters.',
      targetLanguage: 'en',
      qualityGate: 'on_problems',
      firstPass: () =>
        Promise.resolve({
          translation: 'A long English paragraph that is deliberately more than forty characters.',
          detectedSourceLanguage: 'en',
        }),
      repair,
    });

    expect(repair).not.toHaveBeenCalled();
    expect(result.quality.problems).toEqual([]);
  });
});
