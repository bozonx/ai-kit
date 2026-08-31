import type { ModelDefinition } from '../catalog/schema.js';
import { AiError } from '../errors.js';
import type { KeyProvider } from '../ports.js';
import { assemblyAiSttProvider } from './providers/assemblyai.js';
import { deepgramSttProvider } from './providers/deepgram.js';
import { groqSttProvider } from './providers/groq.js';
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
};

export interface SttRegistryOptions {
  keys: KeyProvider;
  /** Extra or replacement adapters, by provider id. */
  factories?: Record<string, SttProviderFactory>;
}

export class SttProviderRegistry {
  private readonly keys: KeyProvider;
  private readonly factories: Readonly<Record<string, SttProviderFactory>>;
  private readonly cache = new Map<string, SttProvider>();

  constructor(options: SttRegistryOptions) {
    this.keys = options.keys;
    this.factories = { ...BUILTIN_FACTORIES, ...options.factories };
  }

  public has(provider: string): boolean {
    return provider in this.factories;
  }

  /** Resolves a catalog entry into a client, cached per provider, key and endpoint. */
  public async provider(model: ModelDefinition): Promise<SttProvider> {
    const factory = this.factories[model.provider];
    if (!factory) {
      throw new AiError(
        'invalid_request',
        `No speech adapter registered for provider "${model.provider}"`,
        { provider: model.provider, model: model.name },
      );
    }

    let apiKey: string;
    try {
      apiKey = await this.keys.get(model.provider);
    } catch (cause) {
      throw new AiError('auth', `No API key configured for provider "${model.provider}"`, {
        provider: model.provider,
        model: model.name,
        cause,
      });
    }

    // Keyed by the credential too: rotating a key must not keep serving the
    // client built with the old one.
    const cacheKey = `${model.provider}:${model.baseUrl ?? ''}:${apiKey.slice(-8)}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const instance = factory({ apiKey, baseUrl: model.baseUrl });
    this.cache.set(cacheKey, instance);
    return instance;
  }
}
