import type { LanguageModel } from 'ai';

import type { ResolvedRoute } from '../catalog/catalog.js';
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
 *
 * The provider SDKs are optional peer dependencies, loaded when a route first
 * asks for one. A product that only ever calls OpenAI has no reason to install
 * Google's SDK, and a bundler has no reason to resolve it.
 */

/** Builds a language model for one provider, given a credential and a model id. */
export type ProviderFactory = (params: {
  apiKey: string;
  modelId: string;
  /** Set when the catalog points the route at a non-default endpoint. */
  baseUrl?: string;
}) => LanguageModel | Promise<LanguageModel>;

/**
 * Turns a missing optional peer into a sentence that says what to install.
 *
 * The alternative is a module-resolution stack trace, which is the same
 * information written for somebody who already knows the answer.
 */
async function load<T>(specifier: string, importer: () => Promise<T>): Promise<T> {
  try {
    return await importer();
  } catch (cause) {
    throw new AiError(
      'invalid_request',
      `The catalog uses a provider served by "${specifier}", which is not installed. Add it as a dependency, or register your own adapter through \`providers\`.`,
      { cause },
    );
  }
}

const BUILTIN_FACTORIES: Readonly<Record<string, ProviderFactory>> = {
  google: async ({ apiKey, modelId, baseUrl }) => {
    const { createGoogleGenerativeAI } = await load(
      '@ai-sdk/google',
      () => import('@ai-sdk/google'),
    );
    return createGoogleGenerativeAI({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) })(modelId);
  },
  openrouter: async ({ apiKey, modelId, baseUrl }) => {
    const { createOpenRouter } = await load(
      '@openrouter/ai-sdk-provider',
      () => import('@openrouter/ai-sdk-provider'),
    );
    return createOpenRouter({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) })(modelId);
  },
  openai: async ({ apiKey, modelId, baseUrl }) => {
    const { createOpenAI } = await load('@ai-sdk/openai', () => import('@ai-sdk/openai'));
    return createOpenAI({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) })(modelId);
  },
  anthropic: async ({ apiKey, modelId, baseUrl }) => {
    const { createAnthropic } = await load('@ai-sdk/anthropic', () => import('@ai-sdk/anthropic'));
    return createAnthropic({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) })(modelId);
  },
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
 * Resolves a route into something the AI SDK can call.
 *
 * Instances are cached per provider, endpoint and key, because every provider
 * object carries an HTTP client and building one per request throws away
 * connection reuse — measurable on a chat where the model is called once per
 * keystroke burst.
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
  public async languageModel(model: ModelDefinition, route: ResolvedRoute): Promise<LanguageModel> {
    const factory = this.factories[route.provider];
    if (!factory) {
      throw new AiError(
        'invalid_request',
        `No adapter registered for provider "${route.provider}"`,
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

    // Keyed by the credential too: rotating a key must not keep serving the
    // client built with the old one.
    const cacheKey = `${route.provider}:${route.model}:${route.baseUrl ?? ''}:${apiKey.slice(-8)}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const instance = await factory({
      apiKey,
      modelId: route.model,
      ...(route.baseUrl === undefined ? {} : { baseUrl: route.baseUrl }),
    });
    this.cache.set(cacheKey, instance);
    return instance;
  }
}
