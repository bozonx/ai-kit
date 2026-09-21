import { describe, expect, it } from '@jest/globals';

import {
  findGlossaryViolations,
  glossaryRendering,
  renderGlossaryForPrompt,
  restoreKeptTerms,
  selectGlossaryForText,
} from '../src/translate/glossary.js';
import type { GlossaryEntry } from '../src/translate/glossary.js';

function entry(overrides: Partial<GlossaryEntry> & { term: string }): GlossaryEntry {
  return { use: overrides.term, doNotTranslate: false, ...overrides };
}

describe('glossary', () => {
  it('sends only the terms the text actually contains', () => {
    const entries = [entry({ term: 'BloggerDog' }), entry({ term: 'Postgres' })];

    expect(selectGlossaryForText(entries, 'We ship BloggerDog today')).toEqual([entries[0]]);
  });

  it('does not match a term inside a longer word', () => {
    expect(selectGlossaryForText([entry({ term: 'Post' })], 'We run Postgres')).toEqual([]);
  });

  it('respects the whole-word flag when it is switched off', () => {
    const entries = [entry({ term: 'Post', wholeWord: false })];

    expect(selectGlossaryForText(entries, 'We run Postgres')).toHaveLength(1);
  });

  it('matches across scripts without ASCII word boundaries', () => {
    expect(selectGlossaryForText([entry({ term: 'канал' })], 'Наш канал растёт')).toHaveLength(1);
    expect(selectGlossaryForText([entry({ term: 'канал' })], 'Наши каналы')).toEqual([]);
  });

  it('is case-insensitive unless the term says otherwise', () => {
    expect(selectGlossaryForText([entry({ term: 'api' })], 'The API is up')).toHaveLength(1);
    expect(
      selectGlossaryForText([entry({ term: 'api', caseSensitive: true })], 'The API is up'),
    ).toEqual([]);
  });

  it('picks the wording for the target language, falling back to the base tag', () => {
    const term = entry({ term: 'channel', use: 'channel', translations: { ru: 'канал' } });

    expect(glossaryRendering(term, 'ru-RU')).toBe('канал');
    expect(glossaryRendering(term, 'de-DE')).toBe('channel');
    expect(glossaryRendering(entry({ term: 'BloggerDog', doNotTranslate: true }), 'ru')).toBeNull();
  });

  it('renders a prompt block that names what must be kept', () => {
    const block = renderGlossaryForPrompt(
      [
        entry({ term: 'BloggerDog', doNotTranslate: true }),
        entry({ term: 'channel', use: 'канал' }),
      ],
      'ru-RU',
    );

    expect(block).toContain('BloggerDog: keep exactly as written');
    expect(block).toContain('channel: канал');
  });

  it('restores the source spelling of a kept term the model recased', () => {
    const result = restoreKeptTerms({
      source: 'BloggerDog ships today',
      translated: 'BLOGGERDOG выходит сегодня',
      entries: [entry({ term: 'BloggerDog', doNotTranslate: true })],
    });

    expect(result.text).toBe('BloggerDog выходит сегодня');
    expect(result.restored).toEqual([]);
  });

  it('reports a kept term the model translated away', () => {
    const result = restoreKeptTerms({
      source: 'BloggerDog ships today',
      translated: 'Блогерпёс выходит сегодня',
      entries: [entry({ term: 'BloggerDog', doNotTranslate: true })],
    });

    expect(result.restored).toEqual(['BloggerDog']);
  });

  it('does not judge a term the source never used', () => {
    expect(
      findGlossaryViolations({
        source: 'Nothing to see',
        translated: 'Ничего',
        entries: [entry({ term: 'BloggerDog', doNotTranslate: true })],
        targetLanguage: 'ru-RU',
      }),
    ).toEqual([]);
  });

  it('finds a term rendered against the glossary', () => {
    expect(
      findGlossaryViolations({
        source: 'Our channel grows',
        translated: 'Наш стрим растёт',
        entries: [entry({ term: 'channel', use: 'канал', translations: { ru: 'канал' } })],
        targetLanguage: 'ru-RU',
      }),
    ).toEqual(['channel']);
  });
});
