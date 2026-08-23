import { describe, it, expect } from '@jest/globals';

import { Catalog } from '../src/catalog/catalog.js';
import { NoSuitableModelError } from '../src/errors.js';
import { selectCandidates } from '../src/policy/policy.js';

const yaml = `
models:
  - name: cheap
    provider: google
    model: flash-lite
    tier: economy
    contextSize: 100000
    maxOutputTokens: 4096
    capabilities:
      tools: false
      structuredOutput: true
    pricing:
      version: '2026-08'
      inputPerMTok: 100000
      outputPerMTok: 400000
  - name: standard
    provider: google
    model: flash
    tier: standard
    contextSize: 200000
    maxOutputTokens: 8192
    modalities:
      input: [text, image]
      output: [text]
    capabilities:
      tools: true
      structuredOutput: true
    pricing:
      version: '2026-08'
      inputPerMTok: 300000
      outputPerMTok: 2500000
  - name: standard-alt
    provider: openrouter
    model: vendor/standard
    tier: standard
    contextSize: 200000
    maxOutputTokens: 8192
    capabilities:
      tools: true
      structuredOutput: true
    pricing:
      version: '2026-08'
      inputPerMTok: 400000
      outputPerMTok: 1600000
  - name: fancy
    provider: openrouter
    model: vendor/fancy
    tier: premium
    contextSize: 200000
    maxOutputTokens: 8192
    capabilities:
      tools: true
      structuredOutput: true
    pricing:
      version: '2026-08'
      inputPerMTok: 3000000
      outputPerMTok: 15000000
  - name: retired
    provider: google
    model: old
    tier: standard
    contextSize: 200000
    maxOutputTokens: 8192
    available: false
    pricing:
      version: '2026-08'
      inputPerMTok: 1
      outputPerMTok: 1
taskClasses:
  chat_simple: [cheap, standard, standard-alt, fancy, retired]
  vision: [cheap, standard]
`;

const catalog = Catalog.fromYaml(yaml);
const signals = { estimatedInputTokens: 1000 };

describe('selectCandidates, auto mode', () => {
  it('keeps the catalog order and marks only the first as chosen', () => {
    const result = selectCandidates({ mode: 'auto', taskClass: 'chat_simple', signals }, catalog);

    expect(result.map(c => c.model.name)).toEqual(['cheap', 'standard', 'standard-alt', 'fancy']);
    expect(result.map(c => c.routedBy)).toEqual(['auto', 'fallback', 'fallback', 'fallback']);
  });

  it('drops a model that cannot read images when the prompt has them', () => {
    const result = selectCandidates(
      { mode: 'auto', taskClass: 'vision', signals: { ...signals, hasImages: true } },
      catalog,
    );

    expect(result.map(c => c.model.name)).toEqual(['standard']);
  });

  it('drops a model without tool calling when tools are needed', () => {
    const result = selectCandidates(
      { mode: 'auto', taskClass: 'chat_simple', signals: { ...signals, needsTools: true } },
      catalog,
    );

    expect(result.map(c => c.model.name)).not.toContain('cheap');
  });

  it('drops a model the prompt does not fit into', () => {
    const result = selectCandidates(
      {
        mode: 'auto',
        taskClass: 'chat_simple',
        signals: { estimatedInputTokens: 150_000, maxOutputTokens: 4096 },
      },
      catalog,
    );

    expect(result.map(c => c.model.name)).not.toContain('cheap');
  });

  it('refuses rather than inventing a candidate when nothing fits', () => {
    expect(() =>
      selectCandidates(
        { mode: 'auto', taskClass: 'chat_simple', signals: { estimatedInputTokens: 5_000_000 } },
        catalog,
      ),
    ).toThrow(NoSuitableModelError);
  });

  it('never nominates a model taken out of rotation', () => {
    const result = selectCandidates({ mode: 'auto', taskClass: 'chat_simple', signals }, catalog);

    expect(result.map(c => c.model.name)).not.toContain('retired');
  });

  it('drops a candidate whose worst case exceeds the budget', () => {
    const result = selectCandidates(
      {
        mode: 'auto',
        taskClass: 'chat_simple',
        signals: { ...signals, maxOutputTokens: 4096 },
        budget: { remainingMicros: 5_000 },
      },
      catalog,
    );

    expect(result.map(c => c.model.name)).toEqual(['cheap']);
  });
});

describe('selectCandidates, manual mode', () => {
  it('returns exactly the pinned model and nothing else', () => {
    const result = selectCandidates(
      { mode: 'manual', taskClass: 'chat_simple', requestedModel: 'fancy', signals },
      catalog,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.model.name).toBe('fancy');
    expect(result[0]?.routedBy).toBe('user');
  });

  it('honours a pinned model that the signals would have filtered out', () => {
    const result = selectCandidates(
      {
        mode: 'manual',
        taskClass: 'chat_simple',
        requestedModel: 'cheap',
        signals: { ...signals, needsTools: true },
      },
      catalog,
    );

    expect(result.map(c => c.model.name)).toEqual(['cheap']);
  });

  it('falls back only inside the same tier when the caller allows auto', () => {
    const result = selectCandidates(
      {
        mode: 'manual',
        taskClass: 'chat_simple',
        requestedModel: ['standard', 'auto'],
        signals,
      },
      catalog,
    );

    expect(result.map(c => c.model.name)).toEqual(['standard', 'standard-alt']);
    expect(result.map(c => c.routedBy)).toEqual(['user', 'fallback']);
  });

  it('respects a provider-qualified reference', () => {
    const result = selectCandidates(
      {
        mode: 'manual',
        taskClass: 'chat_simple',
        requestedModel: 'openrouter/standard-alt',
        signals,
      },
      catalog,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.model.name).toBe('standard-alt');
  });

  it('refuses a provider-qualified reference that does not match', () => {
    expect(() =>
      selectCandidates(
        { mode: 'manual', taskClass: 'chat_simple', requestedModel: 'google/fancy', signals },
        catalog,
      ),
    ).toThrow(NoSuitableModelError);
  });

  it('falls through to auto when the caller pinned nothing', () => {
    const result = selectCandidates({ mode: 'manual', taskClass: 'chat_simple', signals }, catalog);

    expect(result[0]?.routedBy).toBe('auto');
  });
});
