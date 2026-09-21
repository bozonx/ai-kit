import type { ResolvedRoute } from '../catalog/catalog.js';
import type { ModelDefinition } from '../catalog/schema.js';
import { AiError } from '../errors.js';
import type { KeyProvider, Transport } from '../ports.js';
import { ClientCache, keyFor, type KeyOverrides } from '../providers/client-cache.js';
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
  'google-translate': googleCloudTranslationProvider,
};

export interface MtRegistryOptions {
  keys: KeyProvider;
  /** Handed to every adapter. Omitted means the platform's own network. */
  transport?: Transport;
  /** Extra or replacement adapters, by provider id. */
  factories?: Record<string, TranslationProviderFactory>;
}

export class MtProviderRegistry {
  private readonly keys: KeyProvider;
  private readonly transport: Transport | undefined;
  private readonly factories: Readonly<Record<string, TranslationProviderFactory>>;
  private readonly cache = new ClientCache<TranslationProvider>();

  constructor(options: MtRegistryOptions) {
    this.keys = options.keys;
    this.transport = options.transport;
    this.factories = { ...BUILTIN_FACTORIES, ...options.factories };
  }

  public has(provider: string): boolean {
    return provider in this.factories;
  }

  /** Resolves a route into a client, cached per provider, key and endpoint. */
  public async provider(
    model: ModelDefinition,
    route: ResolvedRoute,
    overrides?: KeyOverrides,
  ): Promise<TranslationProvider> {
    const factory = this.factories[route.provider];
    if (!factory) {
      throw new AiError(
        'invalid_request',
        `No translation adapter registered for provider "${route.provider}"`,
        { provider: route.provider, model: model.name },
      );
    }

    const apiKey = await keyFor(this.keys, model, route, overrides);
    return this.cache.resolve(
      {
        provider: route.provider,
        apiKey,
        ...(route.baseUrl === undefined ? {} : { baseUrl: route.baseUrl }),
      },
      () =>
        factory({
          apiKey,
          ...(route.baseUrl === undefined ? {} : { baseUrl: route.baseUrl }),
          ...(this.transport === undefined ? {} : { fetch: this.transport.fetch }),
        }),
    );
  }
}
