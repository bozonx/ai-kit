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

/** DeepL text translation API v2. */

interface DeepLTranslation {
  text?: string;
  detected_source_language?: string;
}

interface DeepLResponse {
  translations?: DeepLTranslation[];
  message?: string;
}

const DEFAULT_ENDPOINT = 'https://api.deepl.com/v2/translate';
const PROVIDER = 'deepl';

export const deeplTranslationProvider: TranslationProviderFactory = ({ apiKey, baseUrl, fetch }) =>
  new DeepLTranslationProvider(apiKey, baseUrl ?? DEFAULT_ENDPOINT, fetch ?? platformFetch);

class DeepLTranslationProvider implements TranslationProvider {
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
      response = await this.send(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `DeepL-Auth-Key ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: request.texts,
          target_lang: deeplLanguage(request.targetLanguage),
          ...(request.sourceLanguage && request.sourceLanguage !== 'auto'
            ? { source_lang: deeplLanguage(request.sourceLanguage) }
            : {}),
          ...(request.format === 'html' ? { tag_handling: 'html' } : {}),
          ...(isModelType(request.modelId) ? { model_type: request.modelId } : {}),
        }),
        signal: request.signal,
      });
    } catch (cause) {
      const name = (cause as { name?: string } | null)?.name;
      if (name === 'AbortError' || name === 'TimeoutError') throw cause;
      throw new AiError('provider_unavailable', 'DeepL is unreachable', { ...context, cause });
    }

    const body = await response.text();
    const payload = parse(body);
    if (!response.ok) {
      const kind = response.status === 456 ? 'rate_limit' : kindFromStatus(response.status, body);
      throw new AiError(kind, payload?.message ?? `DeepL returned ${String(response.status)}`, {
        ...context,
        status: response.status,
      });
    }

    const translations = payload?.translations ?? [];
    if (
      translations.length !== request.texts.length ||
      translations.some(item => item.text === undefined)
    ) {
      throw new AiError(
        'invalid_output',
        `DeepL returned ${String(translations.length)} translations for ${String(request.texts.length)} strings`,
        context,
      );
    }

    return {
      translations: translations.map(item => item.text ?? ''),
      ...(translations[0]?.detected_source_language === undefined
        ? {}
        : { detectedSourceLanguage: translations[0].detected_source_language.toLowerCase() }),
    };
  }
}

function parse(body: string): DeepLResponse | null {
  try {
    return JSON.parse(body) as DeepLResponse;
  } catch {
    return null;
  }
}

/** DeepL accepts ISO codes with a small set of regional target variants. */
function deeplLanguage(language: string): string {
  const normalized = language.trim().replaceAll('_', '-').toUpperCase();
  if (/^(?:EN|PT)-(?:GB|US|BR)$/.test(normalized)) return normalized;
  if (/^ZH-(?:HANS|HANT)$/.test(normalized)) return normalized;
  return normalized.split('-')[0] ?? normalized;
}

function isModelType(
  value: string,
): value is 'latency_optimized' | 'quality_optimized' | 'prefer_quality_optimized' {
  return ['latency_optimized', 'quality_optimized', 'prefer_quality_optimized'].includes(value);
}
