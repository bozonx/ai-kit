import type { ResolvedRoute } from '../catalog/catalog.js';
import type { ModelDefinition } from '../catalog/schema.js';
import { AiError } from '../errors.js';
import type { KeyProvider, Transport } from '../ports.js';
import { ClientCache, keyFor, type KeyOverrides } from '../providers/client-cache.js';
import { assemblyAiSttProvider } from './providers/assemblyai.js';
import { deepgramSttProvider } from './providers/deepgram.js';
import { groqSttProvider } from './providers/groq.js';
import { openAiCompatibleSttProvider } from './providers/openai-compatible.js';
import type { SttProvider, SttProviderFactory } from './types.js';

/**
 * Which adapter transcribes for a provider.
 *
 * A twin of the language-model registry rather than a branch inside it: the two
 * resolve different clients from the same catalog entry, and the only thing a
 * shared version would share is the word "registry".
 */

const BUILTIN_FACTORIES: Readonly<Record<string, SttProviderFactory>> = {
  assemblyai: assemblyAiSttProvider,
  deepgram: deepgramSttProvider,
  groq: groqSttProvider,
  'openai-compatible': openAiCompatibleSttProvider,
};

export interface SttRegistryOptions {
  keys: KeyProvider;
  /** Handed to every adapter. Omitted means the platform's own network. */
  transport?: Transport;
  /** Extra or replacement adapters, by provider id. */
  factories?: Record<string, SttProviderFactory>;
}

export class SttProviderRegistry {
  private readonly keys: KeyProvider;
  private readonly transport: Transport | undefined;
  private readonly factories: Readonly<Record<string, SttProviderFactory>>;
  private readonly cache = new ClientCache<SttProvider>();

  constructor(options: SttRegistryOptions) {
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
  ): Promise<SttProvider> {
    const factory = this.factories[route.provider];
    if (!factory) {
      throw new AiError(
        'invalid_request',
        `No speech adapter registered for provider "${route.provider}"`,
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
          ...(this.transport === undefined
            ? {}
            : { fetch: this.transport.fetch, openSocket: this.transport.openSocket }),
        }),
    );
  }
}
