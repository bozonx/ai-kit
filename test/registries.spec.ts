import { describe, it, expect } from '@jest/globals';

import { Catalog } from '../src/catalog/catalog.js';
import { isAiError } from '../src/errors.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { SttProviderRegistry } from '../src/stt/registry.js';
import { MtProviderRegistry } from '../src/translate/registry.js';

/**
 * Resolving a route into a client.
 *
 * Three registries with one shape, and the same two failures worth being
 * precise about: a provider nobody wrote an adapter for is a mistake in the
 * catalog, and a provider with no key is a mistake in the deployment. Calling
 * both of them "unavailable" is how an afternoon goes into reading logs.
 */

const catalog = Catalog.fromYaml(`
models:
  - name: writer
    provider: custom
    model: writer-id
    tier: standard
    contextSize: 100000
    maxOutputTokens: 4096
    pricing:
      version: 'test'
      inputPerMTok: 1
      outputPerMTok: 1
    routes:
      - provider: proxied
        model: writer-compat
        baseUrl: https://proxy.test/v1
      - provider: nobody
        model: writer-elsewhere
taskClasses:
  writing: [writer]
`);

const model = catalog.require('writer');

/** The nth way to reach the model, as a value rather than as a maybe. */
function routeAt(index: number) {
  const route = catalog.routesOf('writer')[index];
  if (!route) throw new Error(`The test catalog has no route ${String(index)}`);
  return route;
}

const own = routeAt(0);
const proxied = routeAt(1);
const unknown = routeAt(2);

const keys = {
  get: (provider: string) =>
    provider === 'custom' || provider === 'proxied'
      ? Promise.resolve('secret-key')
      : Promise.reject(new Error('no key')),
};

describe('the language model registry', () => {
  const built: Array<{ modelId: string; baseUrl?: string }> = [];
  const registry = new ProviderRegistry({
    keys,
    factories: {
      custom: params => {
        built.push(params);
        return `custom:${params.modelId}` as never;
      },
      proxied: params => {
        built.push(params);
        return `proxied:${params.modelId}` as never;
      },
    },
  });

  it('builds the client for the route, not for the model', async () => {
    expect(await registry.languageModel(model, own)).toBe('custom:writer-id');
    expect(await registry.languageModel(model, proxied)).toBe('proxied:writer-compat');
  });

  it('hands the endpoint of the route to the adapter', async () => {
    await registry.languageModel(model, proxied);

    expect(built.find(params => params.modelId === 'writer-compat')?.baseUrl).toBe(
      'https://proxy.test/v1',
    );
  });

  it('builds one client per provider, endpoint and key', async () => {
    const before = built.length;
    await registry.languageModel(model, own);
    await registry.languageModel(model, own);

    expect(built).toHaveLength(before);
  });

  it('says a provider has no adapter rather than that it is unavailable', async () => {
    const error = await registry.languageModel(model, unknown).catch((caught: unknown) => caught);

    expect(isAiError(error) && error.kind).toBe('invalid_request');
    expect(String(error)).toContain('nobody');
  });

  it('says a deployment has no key rather than that the request was wrong', async () => {
    const withoutKeys = new ProviderRegistry({
      keys: { get: () => Promise.reject(new Error('nothing configured')) },
      factories: { custom: () => 'x' as never },
    });

    const error = await withoutKeys.languageModel(model, own).catch((caught: unknown) => caught);

    expect(isAiError(error) && error.kind).toBe('auth');
  });

  it('names the package to install for a provider it ships but nobody added', () => {
    const builtin = new ProviderRegistry({ keys: { get: () => Promise.resolve('k') } });

    expect(builtin.has('google')).toBe(true);
    expect(builtin.has('nobody')).toBe(false);
    expect(builtin.providers).toContain('anthropic');
  });
});

describe('the speech and translation registries', () => {
  it('refuse an unknown provider in their own words', async () => {
    const stt = new SttProviderRegistry({ keys });
    const mt = new MtProviderRegistry({ keys });

    await expect(stt.provider(model, unknown)).rejects.toThrow(/No speech adapter/);
    await expect(mt.provider(model, unknown)).rejects.toThrow(/No translation adapter/);
  });

  it('cache a client per provider, endpoint and key, like the other one', async () => {
    let built = 0;
    const registry = new SttProviderRegistry({
      keys,
      factories: {
        custom: () => {
          built += 1;
          return { transcribe: () => Promise.reject(new Error('unused')) };
        },
      },
    });

    await registry.provider(model, own);
    await registry.provider(model, own);

    expect(built).toBe(1);
  });

  it('ship the adapters the package knows about', () => {
    expect(new SttProviderRegistry({ keys }).has('deepgram')).toBe(true);
    // Not `google`: that id is Gemini's, and the key provider is asked for a
    // key by provider id — Cloud Translation is a different credential.
    expect(new MtProviderRegistry({ keys }).has('google-translate')).toBe(true);
    expect(new MtProviderRegistry({ keys }).has('google')).toBe(false);
  });
});
