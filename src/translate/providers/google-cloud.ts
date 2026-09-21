import { AiError } from '../../errors.js';
import { kindFromStatus } from '../../execute/classify.js';
import type { FetchFunction } from '../../ports.js';
import { platformFetch } from '../../transport/platform.js';
import type {
  ProviderTranslateRequest,
  TranslationProvider,
  TranslationProviderFactory,
  TranslationResult,
} from '../types.js';

/** Google Cloud Translation Basic (v2). */

interface GoogleCloudTranslation {
  translatedText?: string;
  detectedSourceLanguage?: string;
}

interface GoogleCloudResponse {
  data?: { translations?: GoogleCloudTranslation[] };
  error?: { message?: string };
}

const DEFAULT_ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';
const PROVIDER = 'google';

export const googleCloudTranslationProvider: TranslationProviderFactory = ({
  apiKey,
  baseUrl,
  fetch,
}) =>
  new GoogleCloudTranslationProvider(apiKey, baseUrl ?? DEFAULT_ENDPOINT, fetch ?? platformFetch);

class GoogleCloudTranslationProvider implements TranslationProvider {
  constructor(
    private readonly apiKey: string,
    private readonly endpoint: string,
    private readonly send: FetchFunction,
  ) {}

  public async translate(request: ProviderTranslateRequest): Promise<TranslationResult> {
    if (request.texts.length === 0) return { translations: [] };

    const context = { provider: PROVIDER, model: request.modelId };

    let response: Response;
    try {
      response = await this.send(`${this.endpoint}?key=${encodeURIComponent(this.apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          q: request.texts,
          target: primaryLanguage(request.targetLanguage),
          ...(request.sourceLanguage && request.sourceLanguage !== 'auto'
            ? { source: primaryLanguage(request.sourceLanguage) }
            : {}),
          format: request.format ?? 'text',
        }),
        signal: request.signal,
      });
    } catch (cause) {
      const name = (cause as { name?: string } | null)?.name;
      if (name === 'AbortError' || name === 'TimeoutError') throw cause;
      throw new AiError('provider_unavailable', 'Google Cloud Translation is unreachable', {
        ...context,
        cause,
      });
    }

    const body = await response.text();
    const payload = parse(body);

    if (!response.ok) {
      throw new AiError(
        kindFromStatus(response.status, body),
        payload?.error?.message ?? `Google Cloud Translation returned ${String(response.status)}`,
        { ...context, status: response.status },
      );
    }

    const translations = payload?.data?.translations ?? [];
    // A short list is worse than an error: the caller would pair translations
    // with the wrong sources and never notice, because every string is
    // plausible on its own.
    if (
      translations.length !== request.texts.length ||
      translations.some(item => item.translatedText === undefined)
    ) {
      throw new AiError(
        'invalid_output',
        `Google Cloud Translation returned ${String(translations.length)} translations for ${String(request.texts.length)} strings`,
        context,
      );
    }

    return {
      translations: translations.map(item => decodeHtmlEntities(item.translatedText ?? '')),
      ...(translations[0]?.detectedSourceLanguage === undefined
        ? {}
        : { detectedSourceLanguage: translations[0].detectedSourceLanguage }),
    };
  }
}

function parse(body: string): GoogleCloudResponse | null {
  try {
    return JSON.parse(body) as GoogleCloudResponse;
  } catch {
    return null;
  }
}

function primaryLanguage(language: string): string {
  return language.trim().split('-')[0]?.toLowerCase() ?? language;
}

/**
 * The v2 API HTML-escapes its output even in `text` mode.
 *
 * Undoing it here rather than in the caller because it is a property of this
 * endpoint and of nothing else: a consumer that had to know about it would be
 * a consumer that knows which engine answered.
 */
function decodeHtmlEntities(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}
