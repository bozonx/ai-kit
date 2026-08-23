import { describe, it, expect } from '@jest/globals';

import { calculateCost, estimateCost, estimateTokens } from '../src/catalog/pricing.js';
import type { ModelDefinition } from '../src/catalog/schema.js';

const model = (overrides: Partial<ModelDefinition['pricing']> = {}): ModelDefinition => ({
  name: 'test-model',
  provider: 'test',
  model: 'test/model',
  tier: 'standard',
  contextSize: 100_000,
  maxOutputTokens: 4_000,
  modalities: { input: ['text'], output: ['text'] },
  capabilities: {
    tools: true,
    structuredOutput: true,
    promptCaching: true,
    reasoning: false,
    streaming: true,
  },
  pricing: {
    version: '2026-08',
    inputPerMTok: 300_000,
    outputPerMTok: 2_500_000,
    ...overrides,
  },
  weight: 1,
  available: true,
  tags: [],
});

describe('calculateCost', () => {
  it('prices a plain call from the per-million rates', () => {
    const cost = calculateCost(model(), {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    });

    expect(cost.inputMicros).toBe(300_000);
    expect(cost.outputMicros).toBe(2_500_000);
    expect(cost.totalMicros).toBe(2_800_000);
    expect(cost.priceVersion).toBe('2026-08');
  });

  it('charges cached input once, at the cached rate', () => {
    const cost = calculateCost(model({ cachedInputPerMTok: 75_000 }), {
      inputTokens: 1_000_000,
      cachedInputTokens: 400_000,
      outputTokens: 0,
      reasoningTokens: 0,
    });

    // 600k at full price, 400k at the cached price — not 1M plus 400k.
    expect(cost.inputMicros).toBe(180_000);
    expect(cost.cachedInputMicros).toBe(30_000);
    expect(cost.totalMicros).toBe(210_000);
  });

  it('falls back to the full input rate when the model has no cached price', () => {
    const cost = calculateCost(model(), {
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      outputTokens: 0,
      reasoningTokens: 0,
    });

    expect(cost.totalMicros).toBe(300_000);
  });

  it('leaves reasoning tokens inside output when they are not priced apart', () => {
    const cost = calculateCost(model(), {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
      reasoningTokens: 400_000,
    });

    expect(cost.reasoningMicros).toBe(0);
    expect(cost.outputMicros).toBe(2_500_000);
  });

  it('splits reasoning out of output when it has its own price', () => {
    const cost = calculateCost(model({ reasoningPerMTok: 5_000_000 }), {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 1_000_000,
      reasoningTokens: 400_000,
    });

    expect(cost.outputMicros).toBe(1_500_000);
    expect(cost.reasoningMicros).toBe(2_000_000);
    expect(cost.totalMicros).toBe(3_500_000);
  });

  it('never reports a cached count larger than the input count', () => {
    const cost = calculateCost(model({ cachedInputPerMTok: 0 }), {
      inputTokens: 1_000,
      cachedInputTokens: 9_999_999,
      outputTokens: 0,
      reasoningTokens: 0,
    });

    expect(cost.totalMicros).toBe(0);
  });

  it('rounds up, so a million tiny calls do not leak money', () => {
    const cost = calculateCost(model(), {
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      reasoningTokens: 0,
    });

    expect(cost.inputMicros).toBe(1);
    expect(cost.outputMicros).toBe(3);
  });

  it('adds flat charges for images and video', () => {
    const cost = calculateCost(
      model({ perImage: 40_000, perVideoSecond: 500_000 }),
      { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
      { images: 3, videoSeconds: 2 },
    );

    expect(cost.flatMicros).toBe(1_120_000);
    expect(cost.totalMicros).toBe(1_120_000);
  });
});

describe('estimateCost', () => {
  it('assumes the model writes to its output limit', () => {
    expect(estimateCost(model(), 1_000_000)).toBe(300_000 + 10_000);
  });

  it('never estimates beyond what the model can emit', () => {
    expect(estimateCost(model(), 0, 999_999)).toBe(10_000);
  });
});

describe('estimateTokens', () => {
  it('is a heuristic, not a tokenizer', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});
