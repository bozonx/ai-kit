import { describe, it, expect, afterEach } from '@jest/globals';

import { Catalog } from '../src/catalog/catalog.js';
import { CatalogError, isAiError } from '../src/errors.js';
import { createAiKit } from '../src/kit.js';
import { calculateMtCost, estimateMtCost } from '../src/catalog/pricing.js';
import type { UsageEvent } from '../src/ports.js';
import { googleCloudTranslationProvider } from '../src/translate/providers/google-cloud.js';
import { deeplTranslationProvider } from '../src/translate/providers/deepl.js';
import type { TranslationProvider, TranslationProviderFactory } from '../src/translate/types.js';

/**
 * Machine translation: the third kind of model in the catalog.
 *
 * It is here for the reason speech is: it is chosen from the same catalog,
 * priced with the same arithmetic and retried by the same loop. What it does
 * not share with either is the unit — an engine bills the characters it was
 * handed, before it has produced anything.
 */

const catalog = Catalog.fromYaml(`
models:
  - name: engine
    kind: mt
    provider: fake
    model: nmt
    tier: economy
    mtCapabilities:
      html: true
      languageDetection: true
    mtPricing:
      version: '2026-09'
      perMillionCharsMicros: 20000000
  - name: engine-plain
    kind: mt
    provider: fake
    model: nmt-plain
    tier: economy
    mtCapabilities:
      html: false
    mtPricing:
      version: '2026-09'
      perMillionCharsMicros: 10000000
  - name: writer
    provider: fake
    model: writer-id
    tier: standard
    contextSize: 100000
    maxOutputTokens: 4096
    pricing:
      version: 'test'
      inputPerMTok: 1000000
      outputPerMTok: 2000000
taskClasses:
  translate_fast: [engine-plain, engine]
  translate: [writer]
`);

const engine = catalog.require('engine');

function fakeEngine(translate: TranslationProvider['translate']): TranslationProviderFactory {
  return () => ({ translate });
}

function kitWith(factory: TranslationProviderFactory, events: UsageEvent[] = []) {
  return createAiKit({
    catalog,
    keys: { get: () => Promise.resolve('key') },
    usage: {
      record: event => {
        events.push(event);
        return Promise.resolve();
      },
    },
    mtProviders: { fake: factory },
  });
}

describe('pricing a translation', () => {
  it('charges by the characters handed to the engine', () => {
    // 20 currency-units per million characters: 500 characters is 10_000 micros.
    expect(calculateMtCost(engine, { characters: 500 })).toMatchObject({
      billedCharacters: 500,
      totalMicros: 10_000,
      priceVersion: '2026-09',
    });
  });

  it('estimates exactly, because the characters are in hand before the call', () => {
    expect(estimateMtCost(engine, { characters: 1_000_000 })).toBe(20_000_000);
  });

  it('refuses to price a translation engine as if it had token prices', () => {
    expect(() => calculateMtCost(catalog.require('writer'), { characters: 10 })).toThrow(
      CatalogError,
    );
  });

  it('refuses a translation model priced per token', () => {
    expect(() =>
      Catalog.fromObject({
        models: [
          {
            name: 'wrong',
            kind: 'mt',
            provider: 'fake',
            model: 'x',
            tier: 'economy',
            pricing: { version: 't', inputPerMTok: 1, outputPerMTok: 1 },
            mtPricing: { version: 't', perMillionCharsMicros: 1 },
          },
        ],
        taskClasses: { translate_fast: ['wrong'] },
      }),
    ).toThrow(CatalogError);
  });
});

describe('planning a translation', () => {
  it('quotes every engine exactly and runs the one it planned', async () => {
    const events: UsageEvent[] = [];
    const kit = kitWith(
      fakeEngine(() => Promise.resolve({ translations: ['привет'] })),
      events,
    );
    const request = {
      policy: { taskClass: 'translate_fast', demotedRoutes: new Set<string>() },
      texts: ['hello'],
      targetLanguage: 'ru',
    };

    const plan = kit.planTranslation(request);
    expect(plan.quotes.map(quote => [quote.candidate.model.name, quote.costMicros])).toEqual([
      ['engine-plain', 50],
      ['engine', 100],
    ]);

    const result = await kit.translate({
      ...request,
      plan: { ...plan, candidates: plan.candidates.slice(1) },
    });
    expect(result.model).toBe('engine');
  });
});

describe('running a translation', () => {
  it('records the characters and the cost of what was sent', async () => {
    const events: UsageEvent[] = [];
    const kit = kitWith(
      fakeEngine(() => Promise.resolve({ translations: ['привет', 'мир'] })),
      events,
    );

    const result = await kit.translate({
      policy: { mode: 'auto', taskClass: 'translate_fast' },
      texts: ['hello', 'world'],
      targetLanguage: 'ru',
    });

    expect(result.translations).toEqual(['привет', 'мир']);
    expect(result.model).toBe('engine-plain');
    expect(result.characters).toBe(10);
    expect(result.costMicros).toBe(100);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ characters: 10, audioSeconds: 0, status: 'ok' });
  });

  it('drops an engine that cannot keep markup intact', async () => {
    const kit = kitWith(fakeEngine(() => Promise.resolve({ translations: ['<p>привет</p>'] })));

    const result = await kit.translate({
      policy: { mode: 'auto', taskClass: 'translate_fast' },
      texts: ['<p>hello</p>'],
      targetLanguage: 'ru',
      format: 'html',
    });

    expect(result.model).toBe('engine');
  });

  it('refuses a task class that is served by language models', async () => {
    const kit = kitWith(fakeEngine(() => Promise.resolve({ translations: [] })));

    await expect(
      kit.translate({
        policy: { mode: 'auto', taskClass: 'translate' },
        texts: ['hello'],
        targetLanguage: 'ru',
      }),
    ).rejects.toThrow(/not a machine translation task/);
  });

  it('falls back to the next engine when the first one is down', async () => {
    let calls = 0;
    const kit = kitWith(
      fakeEngine(request => {
        calls += 1;
        if (request.modelId === 'nmt-plain') {
          return Promise.reject(
            Object.assign(new Error('boom'), { name: 'Error' }) as unknown as never,
          );
        }
        return Promise.resolve({ translations: ['привет'] });
      }),
    );

    const result = await kit.translate({
      policy: { mode: 'auto', taskClass: 'translate_fast' },
      texts: ['hello'],
      targetLanguage: 'ru',
    });

    expect(result.model).toBe('engine');
    expect(calls).toBeGreaterThan(1);
  });
});

describe('the Google Cloud Translation adapter', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  function respond(status: number, body: unknown) {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify(body), { status }),
      )) as unknown as typeof globalThis.fetch;
  }

  const provider = googleCloudTranslationProvider({ apiKey: 'k' });
  const request = {
    modelId: 'nmt',
    texts: ['hello'],
    targetLanguage: 'ru-RU',
    signal: AbortSignal.timeout(5_000),
  };

  it('undoes the HTML escaping the v2 endpoint applies even in text mode', async () => {
    respond(200, {
      data: {
        translations: [
          { translatedText: '&quot;привет&quot; &amp; пока', detectedSourceLanguage: 'en' },
        ],
      },
    });

    const result = await provider.translate(request);

    expect(result.translations).toEqual(['"привет" & пока']);
    expect(result.detectedSourceLanguage).toBe('en');
  });

  it('sends the primary subtag, because the endpoint does not take a region', async () => {
    let body = '';
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      body = String(init.body);
      return Promise.resolve(
        new Response(JSON.stringify({ data: { translations: [{ translatedText: 'x' }] } })),
      );
    }) as unknown as typeof globalThis.fetch;

    await provider.translate(request);

    expect(JSON.parse(body)).toMatchObject({ target: 'ru' });
  });

  it('refuses a short list rather than pairing the wrong strings', async () => {
    respond(200, { data: { translations: [] } });

    await expect(provider.translate(request)).rejects.toThrow(/0 translations for 1 strings/);
  });

  it('classifies a quota refusal as retryable and a bad request as not', async () => {
    respond(429, { error: { message: 'quota' } });
    const rateLimited = await provider.translate(request).catch((error: unknown) => error);
    expect(isAiError(rateLimited) && rateLimited.retryable).toBe(true);

    respond(400, { error: { message: 'bad language' } });
    const invalid = await provider.translate(request).catch((error: unknown) => error);
    expect(isAiError(invalid) && invalid.kind).toBe('invalid_request');
  });

  it('never calls the endpoint for an empty batch', async () => {
    let called = false;
    globalThis.fetch = (() => {
      called = true;
      return Promise.resolve(new Response('{}'));
    }) as unknown as typeof globalThis.fetch;

    expect(await provider.translate({ ...request, texts: [] })).toEqual({ translations: [] });
    expect(called).toBe(false);
  });
});

describe('the DeepL translation adapter', () => {
  const original = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = original;
  });

  const request = {
    modelId: 'quality_optimized',
    texts: ['hello'],
    targetLanguage: 'en_US',
    sourceLanguage: 'auto',
    format: 'html' as const,
    signal: AbortSignal.timeout(5_000),
  };

  it('uses header authentication and DeepL language and markup fields', async () => {
    let url = '';
    let init: RequestInit | undefined;
    globalThis.fetch = ((nextUrl: string, nextInit: RequestInit) => {
      url = nextUrl;
      init = nextInit;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            translations: [{ text: '<p>Hello</p>', detected_source_language: 'ES' }],
          }),
        ),
      );
    }) as unknown as typeof globalThis.fetch;

    const result = await deeplTranslationProvider({
      apiKey: 'secret',
      baseUrl: 'https://api-free.deepl.com/v2/translate',
    }).translate(request);

    expect(url).toBe('https://api-free.deepl.com/v2/translate');
    expect(new Headers(init?.headers).get('Authorization')).toBe('DeepL-Auth-Key secret');
    expect(JSON.parse(String(init?.body))).toEqual({
      text: ['hello'],
      target_lang: 'EN-US',
      tag_handling: 'html',
      model_type: 'quality_optimized',
    });
    expect(result).toEqual({
      translations: ['<p>Hello</p>'],
      detectedSourceLanguage: 'es',
    });
  });

  it('refuses a short result and reports provider errors', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ translations: [] })),
      )) as unknown as typeof fetch;
    const provider = deeplTranslationProvider({ apiKey: 'secret' });
    await expect(provider.translate(request)).rejects.toThrow(/0 translations for 1 strings/);

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ message: 'Quota exceeded' }), { status: 456 }),
      )) as unknown as typeof fetch;
    const error = await provider.translate(request).catch((caught: unknown) => caught);
    expect(isAiError(error)).toBe(true);
  });
});
