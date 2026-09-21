import { describe, it, expect } from '@jest/globals';
import { MockLanguageModelV4 } from 'ai/test';

import { Catalog } from '../src/catalog/catalog.js';
import { createAiKit } from '../src/kit.js';
import { quoteCandidates } from '../src/policy/quote.js';
import type { UsageEvent } from '../src/ports.js';

/**
 * A catalog without prices.
 *
 * Allowed only when the catalog says so, and never silently: an unpriced call
 * is recorded at zero *and* marked unpriced, because a zero on its own is what
 * a free call looks like, and a billing product that cannot tell the two apart
 * gives its models away.
 */

const unpricedModels = `
models:
  - name: local
    provider: fake
    model: llama3
    tier: standard
    contextSize: 8192
    maxOutputTokens: 1024
  - name: ears
    kind: stt
    provider: fake
    model: whisper
    tier: standard
  - name: words
    kind: mt
    provider: fake
    model: nmt
    tier: standard
  - name: vectors
    kind: embedding
    provider: fake
    model: embed
    tier: standard
    contextSize: 8192
taskClasses:
  chat: [local]
  transcription: [ears]
  translation: [words]
  search: [vectors]
`;

const catalog = Catalog.fromYaml(`${unpricedModels}requirePricing: false\n`);

const keys = { get: () => Promise.resolve('') };

describe('requirePricing', () => {
  it('is on by default, and names every model that has no price', () => {
    expect(() => Catalog.fromYaml(unpricedModels)).toThrow(
      /local: a language model needs `pricing`.*ears: a speech model needs `sttPricing`.*words: a translation model needs `mtPricing`.*vectors: an embedding model needs `pricing`/,
    );
  });

  it('can be turned off, and the catalog says it was', () => {
    expect(catalog.requiresPricing).toBe(false);
    expect(Catalog.fromObject(catalog.toData()).requiresPricing).toBe(false);
  });

  it('still checks the surcharges of a price block that exists', () => {
    expect(() =>
      Catalog.fromYaml(`
requirePricing: false
models:
  - name: ears
    kind: stt
    provider: fake
    model: whisper
    tier: standard
    sttCapabilities:
      diarization: true
    sttPricing:
      version: 'test'
      perAudioHourMicros: 1000
taskClasses:
  transcription: [ears]
`),
    ).toThrow(/diarizationPerAudioHourMicros/);
  });
});

describe('an unpriced call', () => {
  it('is recorded at zero and marked unpriced, in the result and in the usage event', async () => {
    const events: UsageEvent[] = [];
    const kit = createAiKit({
      catalog,
      keys,
      usage: { record: event => Promise.resolve(void events.push(event)) },
      providers: {
        fake: ({ modelId }) =>
          new MockLanguageModelV4({
            provider: 'fake',
            modelId,
            doGenerate: () =>
              Promise.resolve({
                content: [{ type: 'text' as const, text: 'hi' }],
                finishReason: 'stop' as const,
                usage: {
                  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 5, text: 5, reasoning: 0 },
                },
                warnings: [],
              } as never),
          }),
      },
    });

    const result = await kit.generate({
      policy: { mode: 'auto', taskClass: 'chat', signals: { estimatedInputTokens: 10 } },
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(result).toMatchObject({ costMicros: 0, priceVersion: 'unpriced', priced: false });
    expect(result.usage.inputTokens).toBe(10);
    expect(events[0]).toMatchObject({ costMicros: 0, priceVersion: 'unpriced', priced: false });
  });

  it('keeps the audio seconds the provider measured, unrounded by any price', async () => {
    const kit = createAiKit({
      catalog,
      keys,
      sttProviders: {
        fake: () => ({
          transcribe: () => Promise.resolve({ text: 'x', segments: [], audioSeconds: 1.5 }),
        }),
      },
    });

    const result = await kit.transcribe({
      policy: { mode: 'auto', taskClass: 'transcription' },
      options: { language: 'en' },
      source: { url: 'https://storage.test/a.opus' },
    });

    expect(result).toMatchObject({ audioSeconds: 1.5, costMicros: 0, priced: false });
  });

  it('is quoted at zero and marked unpriced, and never excluded by a budget', () => {
    const quotes = quoteCandidates(
      {
        mode: 'auto',
        taskClass: 'chat',
        signals: { estimatedInputTokens: 10, maxOutputTokens: 100 },
        budget: { remainingMicros: 0 },
      },
      catalog,
    );

    expect(quotes).toHaveLength(1);
    expect(quotes[0]).toMatchObject({ costMicros: 0, priced: false });
  });
});
