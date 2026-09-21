import { describe, expect, it } from '@jest/globals';

import { splitParallelText } from '../src/translate/parallel.js';

function joined(pairs: { source: string; translated: string }[]) {
  return {
    source: pairs.map(pair => pair.source).join(''),
    translated: pairs.map(pair => pair.translated).join(''),
  };
}

describe('splitParallelText', () => {
  it('leaves a pair that fits alone', () => {
    expect(splitParallelText('a', 'b', 10)).toEqual([{ source: 'a', translated: 'b' }]);
  });

  it('cuts at paragraphs when both sides have the same number', () => {
    const source = ['Short one.', 'A much longer second paragraph here.', 'Third.'].join('\n\n');
    const translated = ['Короче один.', 'Второй абзац, намного длиннее первого.', 'Третий.'].join(
      '\n\n',
    );

    const pairs = splitParallelText(source, translated, 60);

    expect(joined(pairs)).toEqual({ source, translated });
    for (const pair of pairs) {
      expect(pair.source.split('\n\n').filter(Boolean)).toHaveLength(
        pair.translated.split('\n\n').filter(Boolean).length,
      );
    }
    expect(pairs[1]?.source).toContain('longer second');
    expect(pairs[1]?.translated).toContain('Второй абзац');
  });

  it('falls back to sentences inside a paragraph that is too long', () => {
    const source = 'One sentence here. Two sentence here. Three sentence here.';
    const translated = 'Первое предложение. Второе предложение. Третье предложение.';

    const pairs = splitParallelText(source, translated, 50);

    expect(joined(pairs)).toEqual({ source, translated });
    expect(pairs.length).toBeGreaterThan(1);
    expect(pairs[0]?.source).toBe('One sentence here. ');
    expect(pairs[0]?.translated).toBe('Первое предложение. ');
  });

  it('never cuts a word when the structure does not match', () => {
    const source = 'alpha beta gamma delta epsilon zeta eta theta iota kappa';
    const translated = 'альфа бета гамма дельта эпсилон дзета эта тета йота каппа лямбда';

    const pairs = splitParallelText(source, translated, 60);

    expect(joined(pairs)).toEqual({ source, translated });
    for (const pair of pairs.slice(0, -1)) {
      expect(pair.source.endsWith(' ')).toBe(true);
      expect(pair.translated.endsWith(' ')).toBe(true);
    }
  });

  it('refuses a meaningless limit', () => {
    expect(() => splitParallelText('a', 'b', 0)).toThrow(RangeError);
  });
});
