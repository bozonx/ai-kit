import { describe, expect, it } from '@jest/globals';

import { compactHistory } from '../src/chat/compaction.js';

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

function message(id: string, text: string) {
  return { id, text, role: 'user' };
}

const base = { maxMessages: 10, tokenBudget: 100, estimateTokens };

describe('compactHistory', () => {
  it('keeps everything that fits', () => {
    const result = compactHistory({
      ...base,
      messages: [message('1', 'a'), message('2', 'b')],
      summary: null,
    });

    expect(result.kept.map(m => m.id)).toEqual(['1', '2']);
    expect(result.dropped).toEqual([]);
    expect(result.summaryStale).toBe(false);
  });

  it('keeps the caller’s own message shape', () => {
    const result = compactHistory({ ...base, messages: [message('1', 'a')], summary: null });

    expect(result.kept[0]?.role).toBe('user');
  });

  it('drops the oldest messages when the token budget runs out', () => {
    const messages = [
      message('1', 'x'.repeat(300)),
      message('2', 'y'.repeat(100)),
      message('3', 'z'.repeat(40)),
    ];

    const result = compactHistory({ ...base, messages, summary: null });

    expect(result.kept.map(m => m.id)).toEqual(['2', '3']);
    expect(result.dropped.map(m => m.id)).toEqual(['1']);
  });

  it('drops the oldest messages when there are simply too many of them', () => {
    const messages = Array.from({ length: 8 }, (_, index) => message(String(index + 1), 'short'));

    const result = compactHistory({ ...base, messages, summary: null, maxMessages: 3 });

    expect(result.kept.map(m => m.id)).toEqual(['6', '7', '8']);
    expect(result.dropped).toHaveLength(5);
  });

  it('always keeps the newest message, however long it is', () => {
    const result = compactHistory({
      ...base,
      messages: [message('1', 'a'), message('2', 'x'.repeat(10_000))],
      summary: null,
    });

    expect(result.kept.map(m => m.id)).toEqual(['2']);
  });

  it('counts the summary against the same budget', () => {
    const messages = [message('1', 'a'.repeat(200)), message('2', 'b'.repeat(200))];

    const withSummary = compactHistory({
      ...base,
      messages,
      summary: 's'.repeat(200),
      tokenBudget: 110,
    });
    const withoutSummary = compactHistory({ ...base, messages, summary: null, tokenBudget: 110 });

    expect(withSummary.kept).toHaveLength(1);
    expect(withoutSummary.kept).toHaveLength(2);
  });

  it('sends no summary when nothing has fallen off', () => {
    const result = compactHistory({ ...base, messages: [message('1', 'a')], summary: 'old' });

    expect(result.summary).toBeNull();
  });

  it('reports what the summary does not cover yet', () => {
    const messages = [
      message('1', 'x'.repeat(400)),
      message('2', 'x'.repeat(400)),
      message('3', 'y'),
    ];

    const stale = compactHistory({ ...base, messages, summary: 'old summary' });
    const partly = compactHistory({
      ...base,
      messages,
      summary: 'old summary',
      summaryCoversThrough: '1',
    });
    const fully = compactHistory({
      ...base,
      messages,
      summary: 'old summary',
      summaryCoversThrough: '2',
    });

    expect(stale.unsummarized.map(m => m.id)).toEqual(['1', '2']);
    expect(stale.summary).toBe('old summary');
    expect(partly.unsummarized.map(m => m.id)).toEqual(['2']);
    expect(partly.summaryStale).toBe(true);
    expect(fully.unsummarized).toEqual([]);
    expect(fully.summaryStale).toBe(false);
  });

  it('uses the package estimate when none is given', () => {
    const result = compactHistory({
      messages: [message('1', 'x'.repeat(4000)), message('2', 'y')],
      summary: null,
      maxMessages: 10,
      tokenBudget: 100,
    });

    expect(result.kept.map(m => m.id)).toEqual(['2']);
  });

  it('handles an empty conversation', () => {
    const result = compactHistory({ ...base, messages: [], summary: null });

    expect(result.kept).toEqual([]);
    expect(result.summaryStale).toBe(false);
  });
});
