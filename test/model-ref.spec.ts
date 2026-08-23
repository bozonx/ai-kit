import { describe, it, expect } from '@jest/globals';

import { formatModelRef, parseModelInput } from '../src/utils/model-ref.js';

describe('parseModelInput', () => {
  it('treats nothing and "auto" as "you choose"', () => {
    expect(parseModelInput(undefined)).toEqual({ refs: [], allowAuto: true });
    expect(parseModelInput('auto')).toEqual({ refs: [], allowAuto: true });
  });

  it('reads a bare name as a name and a slashed one as provider plus name', () => {
    expect(parseModelInput('gemini-2.5-flash').refs).toEqual([{ name: 'gemini-2.5-flash' }]);
    expect(parseModelInput('google/gemini-2.5-flash').refs).toEqual([
      { provider: 'google', name: 'gemini-2.5-flash' },
    ]);
  });

  it('pins the model when one is named explicitly', () => {
    expect(parseModelInput('gemini-2.5-flash').allowAuto).toBe(false);
  });

  it('keeps a list in the order it was written', () => {
    const { refs, allowAuto } = parseModelInput(['a', 'openrouter/b']);

    expect(refs).toEqual([{ name: 'a' }, { provider: 'openrouter', name: 'b' }]);
    expect(allowAuto).toBe(false);
  });

  it('stops at "auto": nothing written after "anything you like" can mean something', () => {
    const { refs, allowAuto } = parseModelInput(['a', 'auto', 'b']);

    expect(refs).toEqual([{ name: 'a' }]);
    expect(allowAuto).toBe(true);
  });

  it('ignores empty entries and leading or trailing slashes', () => {
    expect(parseModelInput(['', '  ', '/x', 'y/']).refs).toEqual([{ name: '/x' }, { name: 'y/' }]);
  });
});

describe('formatModelRef', () => {
  it('round-trips a reference', () => {
    expect(formatModelRef({ provider: 'google', name: 'x' })).toBe('google/x');
    expect(formatModelRef({ name: 'x' })).toBe('x');
  });
});
