import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';

import type { ModelDefinition } from '../catalog/schema.js';
import { AiError } from '../errors.js';
import type { KeyProvider } from '../ports.js';

/**
 * Which SDK adapter runs a model.
 *
 * This is the only file in the package that names a provider, and the only one
 * that has to change when a new one is added. Everything above it addresses
 * models by catalog name, which is what makes "switch the model behind this
 * feature" an edit to a YAML file.
 */

/** Builds a language model for one provider, given a credential and a model id. */
export type ProviderFactory = (params: { apiKey: string; modelId: string }) => LanguageModel;

const BUILTIN_FACTORIES: Readonly<Record<string, ProviderFactory>> = {
  google: ({ apiKey, modelId }) => createGoogleGenerativeAI({ apiKey })(modelId),
  openrouter: ({ apiKey, modelId }) => createOpenRouter({ apiKey })(modelId),
  openai: ({ apiKey, modelId }) => createOpenAI({ apiKey })(modelId),
};

export interface ProviderRegistryOptions {
  keys: KeyProvider;
  /**
   * Extra or replacement adapters, by provider id.
   *
   * The way a consumer adds a provider the package does not ship, or points an
   * existing one at a proxy, without waiting for a release.
   */
  factories?: Record<string, ProviderFactory>;
}

/**
 * Resolves a catalog entry into something the AI SDK can call.
 *
 * Instances are cached per provider and key, because every provider object
 * carries an HTTP client and building one per request throws away connection
 * reuse — measurable on a chat where the model is called once per keystroke
 * burst.
 */
export class ProviderRegistry {
  private readonly keys: KeyProvider;
  private readonly factories: Readonly<Record<string, ProviderFactory>>;
  private readonly cache = new Map<string, LanguageModel>();

  constructor(options: ProviderRegistryOptions) {
    this.keys = options.keys;
    this.factories = { ...BUILTIN_FACTORIES, ...options.factories };
  }

  public has(provider: string): boolean {
    return provider in this.factories;
  }

  public get providers(): readonly string[] {
    return Object.keys(this.factories);
  }

  /**
   * @throws AiError('invalid_request') when no adapter is registered for the
   *   provider, and AiError('auth') when the deployment has no key for it.
   */
  public async languageModel(model: ModelDefinition): Promise<LanguageModel> {
    const factory = this.factories[model.provider];
    if (!factory) {
      throw new AiError(
        'invalid_request',
        `No adapter registered for provider "${model.provider}"`,
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
    const cacheKey = `${model.provider}:${model.model}:${apiKey.slice(-8)}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const instance = factory({ apiKey, modelId: model.model });
    this.cache.set(cacheKey, instance);
    return instance;
  }
}
