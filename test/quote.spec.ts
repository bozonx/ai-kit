import { describe, it, expect } from '@jest/globals';

import { Catalog } from '../src/catalog/catalog.js';
import { quoteCandidates } from '../src/policy/quote.js';

/**
 * A hold has to cover the dearest candidate that could end up answering, so
 * every candidate is quoted — including a backup route dearer than the first.
 */

const catalog = Catalog.fromYaml(`
models:
  - name: writer
    provider: cheap
    model: writer
    routeId: writer-cheap
    tier: standard
    contextSize: 2000000
    maxOutputTokens: 1000
    pricing: { version: 'c', inputPerMTok: 1000000, outputPerMTok: 1000000 }
    routes:
      - id: writer-dear
        provider: dear
        model: writer
        pricing: { version: 'd', inputPerMTok: 10000000, outputPerMTok: 10000000 }
  - name: engine
    kind: mt
    provider: mt
    model: engine
    tier: standard
    mtPricing: { version: 'm', perMillionCharsMicros: 20000000 }
  - name: ears
    kind: stt
    provider: stt
    model: ears
    tier: standard
    sttPricing: { version: 's', perAudioHourMicros: 360000 }
taskClasses:
  write: [writer]
  translate: [engine]
  listen: [ears]
`);

describe('quoteCandidates', () => {
  it('quotes every route of a language model at its full output allowance', () => {
    const quotes = quoteCandidates(
      {
        mode: 'auto',
        taskClass: 'write',
        signals: { estimatedInputTokens: 1_000_000, maxOutputTokens: 5_000 },
      },
      catalog,
    );

    // Output is capped at the model's own 1000 tokens.
    expect(quotes.map(quote => [quote.candidate.route.id, quote.costMicros])).toEqual([
      ['writer-cheap', 1_001_000],
      ['writer-dear', 10_010_000],
    ]);
  });

  it('quotes a translation engine by the character', () => {
    const [quote] = quoteCandidates(
      { mode: 'auto', taskClass: 'translate', signals: { estimatedInputTokens: 0 } },
      catalog,
      { characters: 1_000 },
    );

    expect(quote?.costMicros).toBe(20_000);
  });

  it('quotes a speech model by the second', () => {
    const [quote] = quoteCandidates(
      { mode: 'auto', taskClass: 'listen', signals: { estimatedInputTokens: 0 } },
      catalog,
      { audioSeconds: 3_600 },
    );

    expect(quote?.costMicros).toBe(360_000);
  });
});
