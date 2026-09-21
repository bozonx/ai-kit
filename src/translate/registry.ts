import type { ResolvedRoute } from '../catalog/catalog.js';
import type { ModelDefinition } from '../catalog/schema.js';
import { AiError } from '../errors.js';
import type { KeyProvider } from '../ports.js';
import { googleCloudTranslationProvider } from './providers/google-cloud.js';
import type { TranslationProvider, TranslationProviderFactory } from './types.js';

/**
 * Which adapter translates for a provider.
 *
 * A third sibling of the language-model and speech registries. They resolve
 * different clients from the same catalog entry, and the only thing a shared
 * version would share is the word "registry".
 */

const BUILTIN_FACTORIES: Readonly<Record<string, TranslationProviderFactory>> = {
  google: googleCloudTranslationProvider,
};

export interface MtRegistryOptions {
  keys: KeyProvider;
  /** Extra or replacement adapters, by provider id. */
  factories?: Record<string, TranslationProviderFactory>;
}

export class MtProviderRegistry {
  private readonly keys: KeyProvider;
  private readonly factories: Readonly<Record<string, TranslationProviderFactory>>;
  private readonly cache = new Map<string, TranslationProvider>();

  constructor(options: MtRegistryOptions) {
    this.keys = options.keys;
    this.factories = { ...BUILTIN_FACTORIES, ...options.factories };
  }

  public has(provider: string): boolean {
    return provider in this.factories;
  }

  /** Resolves a route into a client, cached per provider, key and endpoint. */
  public async provider(
    model: ModelDefinition,
    route: ResolvedRoute,
  ): Promise<TranslationProvider> {
    const factory = this.factories[route.provider];
    if (!factory) {
      throw new AiError(
        'invalid_request',
        `No translation adapter registered for provider "${route.provider}"`,
        { provider: route.provider, model: model.name },
      );
    }

    let apiKey: string;
    try {
      apiKey = await this.keys.get(route.provider);
    } catch (cause) {
      throw new AiError('auth', `No API key configured for provider "${route.provider}"`, {
        provider: route.provider,
        model: model.name,
        cause,
      });
    }

    const cacheKey = `${route.provider}:${route.baseUrl ?? ''}:${apiKey.slice(-8)}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const instance = factory({
      apiKey,
      ...(route.baseUrl === undefined ? {} : { baseUrl: route.baseUrl }),
    });
    this.cache.set(cacheKey, instance);
    return instance;
  }
}
