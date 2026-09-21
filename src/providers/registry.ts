import type { EmbeddingModel, LanguageModel } from 'ai';

import type { ResolvedRoute } from '../catalog/catalog.js';
import type { ModelDefinition } from '../catalog/schema.js';
import { AiError } from '../errors.js';
import type { FetchFunction, KeyProvider, Transport } from '../ports.js';
import { ClientCache, keyFor, type KeyOverrides } from './client-cache.js';

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
  /** The kit's `fetch`, for the SDK to send every request through. */
  fetch?: FetchFunction;
}) => LanguageModel | Promise<LanguageModel>;

/** The same, for embedding models. */
export type EmbeddingProviderFactory = (params: {
  apiKey: string;
  modelId: string;
  baseUrl?: string;
  fetch?: FetchFunction;
}) => EmbeddingModel | Promise<EmbeddingModel>;

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

type FactoryParams = Parameters<ProviderFactory>[0];

/** What every SDK provider's `create…` function accepts, from our params. */
function settings({ apiKey, baseUrl, fetch }: FactoryParams): {
  apiKey: string;
  baseURL?: string;
  fetch?: FetchFunction;
} {
  return {
    apiKey,
    ...(baseUrl === undefined ? {} : { baseURL: baseUrl }),
    ...(fetch === undefined ? {} : { fetch }),
  };
}

/**
 * A server that speaks OpenAI's chat completions and is not OpenAI.
 *
 * Ollama, LM Studio, vLLM or a company proxy — reached only through the
 * catalog's `baseUrl`, which is therefore required. The key is optional
 * because a local server usually has none, and an empty bearer token is a
 * refusal at the ones that check.
 */
async function openAiCompatible(params: FactoryParams) {
  if (params.baseUrl === undefined) {
    throw new AiError(
      'invalid_request',
      'Provider "openai-compatible" has no default endpoint; set `baseUrl` in the catalog',
      { provider: 'openai-compatible', model: params.modelId },
    );
  }
  const { createOpenAICompatible } = await load(
    '@ai-sdk/openai-compatible',
    () => import('@ai-sdk/openai-compatible'),
  );
  return createOpenAICompatible({
    name: 'openai-compatible',
    baseURL: params.baseUrl,
    ...(params.apiKey.length > 0 ? { apiKey: params.apiKey } : {}),
    ...(params.fetch === undefined ? {} : { fetch: params.fetch }),
    // Without it a streamed answer carries no token counts, and a call nobody
    // can count is a call nobody can price.
    includeUsage: true,
  });
}

const BUILTIN_FACTORIES: Readonly<Record<string, ProviderFactory>> = {
  google: async params => {
    const { createGoogleGenerativeAI } = await load(
      '@ai-sdk/google',
      () => import('@ai-sdk/google'),
    );
    return createGoogleGenerativeAI(settings(params))(params.modelId);
  },
  openrouter: async params => {
    const { createOpenRouter } = await load(
      '@openrouter/ai-sdk-provider',
      () => import('@openrouter/ai-sdk-provider'),
    );
    return createOpenRouter(settings(params))(params.modelId);
  },
  openai: async params => {
    const { createOpenAI } = await load('@ai-sdk/openai', () => import('@ai-sdk/openai'));
    return createOpenAI(settings(params))(params.modelId);
  },
  anthropic: async params => {
    const { createAnthropic } = await load('@ai-sdk/anthropic', () => import('@ai-sdk/anthropic'));
    return createAnthropic(settings(params))(params.modelId);
  },
  deepseek: async params => {
    const { createDeepSeek } = await load('@ai-sdk/deepseek', () => import('@ai-sdk/deepseek'));
    return createDeepSeek(settings(params))(params.modelId);
  },
  'openai-compatible': async params => (await openAiCompatible(params)).chatModel(params.modelId),
};

const BUILTIN_EMBEDDING_FACTORIES: Readonly<Record<string, EmbeddingProviderFactory>> = {
  google: async params => {
    const { createGoogleGenerativeAI } = await load(
      '@ai-sdk/google',
      () => import('@ai-sdk/google'),
    );
    return createGoogleGenerativeAI(settings(params)).embedding(params.modelId);
  },
  openrouter: async params => {
    const { createOpenRouter } = await load(
      '@openrouter/ai-sdk-provider',
      () => import('@openrouter/ai-sdk-provider'),
    );
    return createOpenRouter(settings(params)).embedding(params.modelId);
  },
  openai: async params => {
    const { createOpenAI } = await load('@ai-sdk/openai', () => import('@ai-sdk/openai'));
    return createOpenAI(settings(params)).embedding(params.modelId);
  },
  'openai-compatible': async params =>
    (await openAiCompatible(params)).embeddingModel(params.modelId),
};

export interface ProviderRegistryOptions {
  keys: KeyProvider;
  /** Its `fetch` is handed to every adapter. Omitted means the SDK's default. */
  transport?: Transport;
  /**
   * Extra or replacement adapters, by provider id.
   *
   * The way a consumer adds a provider the package does not ship, or points an
   * existing one at a proxy, without waiting for a release.
   */
  factories?: Record<string, ProviderFactory>;
  /** Extra or replacement embedding adapters, by provider id. */
  embeddingFactories?: Record<string, EmbeddingProviderFactory>;
}

/**
 * Resolves a route into something the AI SDK can call.
 *
 * Instances are cached per provider, endpoint, model and key, because every provider
 * object carries an HTTP client and building one per request throws away
 * connection reuse — measurable on a chat where the model is called once per
 * keystroke burst.
 */
export class ProviderRegistry {
  private readonly keys: KeyProvider;
  private readonly fetch: FetchFunction | undefined;
  private readonly factories: Readonly<Record<string, ProviderFactory>>;
  private readonly embeddingFactories: Readonly<Record<string, EmbeddingProviderFactory>>;
  private readonly cache = new ClientCache<LanguageModel>();
  private readonly embeddingCache = new ClientCache<EmbeddingModel>();

  constructor(options: ProviderRegistryOptions) {
    this.keys = options.keys;
    this.fetch = options.transport?.fetch;
    this.factories = { ...BUILTIN_FACTORIES, ...options.factories };
    this.embeddingFactories = { ...BUILTIN_EMBEDDING_FACTORIES, ...options.embeddingFactories };
  }

  /**
   * An embedding model for a route, cached like a language model.
   *
   * @throws AiError('invalid_request') when no embedding adapter is registered
   *   for the provider, and AiError('auth') when there is no key for it.
   */
  public async embeddingModel(
    model: ModelDefinition,
    route: ResolvedRoute,
    overrides?: KeyOverrides,
  ): Promise<EmbeddingModel> {
    const factory = this.embeddingFactories[route.provider];
    if (!factory) {
      throw new AiError(
        'invalid_request',
        `No embedding adapter registered for provider "${route.provider}"`,
        { provider: route.provider, model: model.name },
      );
    }

    const apiKey = await keyFor(this.keys, model, route, overrides);
    const baseUrl = route.baseUrl === undefined ? {} : { baseUrl: route.baseUrl };
    return this.embeddingCache.resolve(
      { provider: route.provider, model: route.model, apiKey, ...baseUrl },
      () => factory({ apiKey, modelId: route.model, ...baseUrl, ...this.fetchParam() }),
    );
  }

  public has(provider: string): boolean {
    return provider in this.factories;
  }

  public get providers(): readonly string[] {
    return Object.keys(this.factories);
  }

  /**
   * @param overrides Credentials this one call brought, applied over `keys`.
   * @throws AiError('invalid_request') when no adapter is registered for the
   *   provider, and AiError('auth') when neither the call nor the deployment
   *   has a key for it.
   */
  public async languageModel(
    model: ModelDefinition,
    route: ResolvedRoute,
    overrides?: KeyOverrides,
  ): Promise<LanguageModel> {
    const factory = this.factories[route.provider];
    if (!factory) {
      throw new AiError(
        'invalid_request',
        `No adapter registered for provider "${route.provider}"`,
        { provider: route.provider, model: model.name },
      );
    }

    const apiKey = await keyFor(this.keys, model, route, overrides);
    return this.cache.resolve(
      {
        provider: route.provider,
        model: route.model,
        apiKey,
        ...(route.baseUrl === undefined ? {} : { baseUrl: route.baseUrl }),
      },
      () =>
        factory({
          apiKey,
          modelId: route.model,
          ...(route.baseUrl === undefined ? {} : { baseUrl: route.baseUrl }),
          ...this.fetchParam(),
        }),
    );
  }

  private fetchParam(): { fetch?: FetchFunction } {
    return this.fetch === undefined ? {} : { fetch: this.fetch };
  }
}
