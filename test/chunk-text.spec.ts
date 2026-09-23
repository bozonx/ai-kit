import { describe, it, expect } from '@jest/globals';

import { chunkText } from '../src/utils/chunk-text.js';

describe('chunkText', () => {
  it('never returns a chunk longer than the requested maximum', () => {
    const chunks = chunkText(`${'word '.repeat(1_000)}tail`, 100);

    expect(chunks.every(chunk => chunk.length <= 100)).toBe(true);
    expect(chunks.join('')).toBe(`${'word '.repeat(1_000)}tail`);
  });
  it('leaves short text alone', () => {
    expect(chunkText('short', 10)).toEqual(['short']);
  });

  it('cuts between words, keeping the boundary with the first piece', () => {
    const chunks = chunkText('One sentence here. Another one follows.', 25);
    expect(chunks[0]).toBe('One sentence here. ');
    expect(chunks.join('')).toBe('One sentence here. Another one follows.');
  });

  it('cuts at a line break', () => {
    const text = `${'a'.repeat(15)}\n${'b'.repeat(15)}`;
    expect(chunkText(text, 20)[0]).toBe(`${'a'.repeat(15)}\n`);
  });

  it('cuts hard when no boundary is late enough', () => {
    const chunks = chunkText('x'.repeat(25), 10);
    expect(chunks).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
  });

  it('never loses or reorders text', () => {
    const text = 'Lorem ipsum dolor sit amet. '.repeat(40);
    const chunks = chunkText(text, 100);
    expect(chunks.join('')).toBe(text);
    expect(chunks.every(chunk => chunk.length <= 100)).toBe(true);
  });

  it('refuses a limit that cannot make progress', () => {
    expect(() => chunkText('text', 0)).toThrow(RangeError);
  });
});
