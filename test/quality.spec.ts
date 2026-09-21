import { describe, expect, it } from '@jest/globals';

import { detectTranslationProblems, renderProblemsForPrompt } from '../src/translate/quality.js';

const codes = (input: Parameters<typeof detectTranslationProblems>[0]) =>
  detectTranslationProblems(input).map(problem => problem.code);

describe('detectTranslationProblems', () => {
  it('says nothing about a clean translation', () => {
    expect(
      codes({
        source: 'The release is out. Read the notes at https://example.com/notes.',
        translated: 'Релиз вышел. Читайте заметки на https://example.com/notes.',
        sourceLang: 'en',
        targetLang: 'ru',
      }),
    ).toEqual([]);
  });

  it('catches a writing system the target language does not use', () => {
    expect(
      codes({
        source: 'The release is out and everyone can try it today.',
        translated: 'Релиз вышел и 每个人都可以今天试用 его сегодня.',
        sourceLang: 'en',
        targetLang: 'ru',
      }),
    ).toContain('foreign_script');
  });

  it('leaves a foreign script alone when the source already had it', () => {
    expect(
      codes({
        source: 'Our partner 株式会社ドッグ ships the device worldwide today.',
        translated: 'Наш партнёр 株式会社ドッグ отгружает устройство по всему миру.',
        sourceLang: 'en',
        targetLang: 'ru',
      }),
    ).not.toContain('foreign_script');
  });

  it('catches paragraphs that came back untouched', () => {
    const paragraph = 'The release is out and everyone can try it today without paying.';
    expect(
      codes({
        source: `${paragraph}\n\nSecond paragraph that is long enough to count as one.`,
        translated: `${paragraph}\n\nВторой абзац, достаточно длинный, чтобы попасть в выборку.`,
        sourceLang: 'en',
        targetLang: 'ru',
      }),
    ).toContain('untranslated');
  });

  it('catches a lost link', () => {
    expect(
      codes({
        source: 'Read the notes at https://example.com/notes before upgrading.',
        translated: 'Читайте заметки перед обновлением.',
        sourceLang: 'en',
        targetLang: 'ru',
      }),
    ).toContain('placeholders');
  });

  it('catches lost structure', () => {
    expect(
      codes({
        source: '# Title\n\n- one\n- two',
        translated: 'Заголовок\n\nодин, два',
        sourceLang: 'en',
        targetLang: 'ru',
      }),
    ).toContain('structure');
  });

  it('catches a loop the source did not have', () => {
    const line = 'Это предложение повторяется снова и снова без всякой причины. ';
    expect(
      codes({
        source: 'A sentence that appears exactly once in the source text.',
        translated: line.repeat(3),
        sourceLang: 'en',
        targetLang: 'ru',
      }),
    ).toContain('looping');
  });

  it('catches an ending cut mid-sentence', () => {
    expect(
      codes({
        source: 'The release is out and everyone can try it today.',
        translated: 'Релиз вышел и каждый может',
        sourceLang: 'en',
        targetLang: 'ru',
      }),
    ).toContain('truncation');
  });

  it('catches a glossary term rendered against the glossary', () => {
    expect(
      codes({
        source: 'BloggerDog ships today.',
        translated: 'БлоггерДог выходит сегодня.',
        sourceLang: 'en',
        targetLang: 'ru',
        glossary: [{ term: 'BloggerDog', use: 'BloggerDog', doNotTranslate: true }],
      }),
    ).toContain('glossary');
  });

  it('says nothing at all about an unknown target language', () => {
    expect(
      codes({
        source: 'The release is out.',
        translated: '릴리스가 나왔습니다.',
        sourceLang: 'en',
        targetLang: 'xx',
      }),
    ).not.toContain('foreign_script');
  });
});

describe('renderProblemsForPrompt', () => {
  it('is empty when there is nothing to fix', () => {
    expect(renderProblemsForPrompt([])).toBe('');
  });

  it('lists what to fix and what was found', () => {
    expect(renderProblemsForPrompt([{ code: 'glossary', detail: 'BloggerDog' }])).toContain(
      'binding glossary (BloggerDog)',
    );
  });
});
