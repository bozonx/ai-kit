/**
 * The vocabulary of machine translation.
 *
 * A dedicated translation engine is not a language model and is not reached
 * through the AI SDK: it is a plain HTTP API that takes strings and a target
 * language and gives strings back. It is in this package for the same reason
 * speech is — it is selected from the same catalog, priced with the same
 * arithmetic and retried by the same loop — and it knows as little about
 * anybody's domain as the rest of it.
 */

import type { FetchFunction } from '../ports.js';

/** Whether the strings carry markup the engine has to preserve. */
export type TranslationFormat = 'text' | 'html';

export interface TranslationRequest {
  /** The strings to translate, in order. The result comes back in that order. */
  texts: string[];
  /** BCP-47 tag of the language to translate into. */
  targetLanguage: string;
  /** Omitted asks the engine to detect it. */
  sourceLanguage?: string;
  format?: TranslationFormat;
  signal?: AbortSignal;
}

export interface TranslationResult {
  translations: string[];
  /** Detected, or echoed back from the request. */
  detectedSourceLanguage?: string;
  /** The engine's own id for the job, for support requests. */
  providerRequestId?: string;
}

export interface ProviderTranslateRequest extends TranslationRequest {
  /** The provider's own model id, from the catalog. */
  modelId: string;
  signal: AbortSignal;
}

/** The port every translation engine implements. */
export interface TranslationProvider {
  translate(request: ProviderTranslateRequest): Promise<TranslationResult>;
}

/** How a translation adapter is built. Mirrors the other two registries. */
export type TranslationProviderFactory = (init: {
  apiKey: string;
  /** Set when the catalog points the model at a non-default endpoint. */
  baseUrl?: string;
  /** The kit's `fetch`. Absent when an adapter is built by hand: use the platform's. */
  fetch?: FetchFunction;
}) => TranslationProvider;
