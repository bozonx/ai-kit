import { createHash } from 'node:crypto';

import type { ResolvedRoute } from '../catalog/catalog.js';
import type { ModelDefinition } from '../catalog/schema.js';
import { AiError } from '../errors.js';
import type { KeyProvider } from '../ports.js';

/**
 * Credentials for one call, by provider id, applied over the `KeyProvider`.
 *
 * The shape "bring your own key" needs: a customer's key replaces the
 * deployment's for its provider and only for it, and only for the call that
 * carries it. Everything else still comes from the key provider.
 */
export type KeyOverrides = Readonly<Record<string, string | undefined>>;

/**
 * How many clients a registry keeps.
 *
 * Bounded because keys are part of the cache key: with per-call credentials
 * every customer key is another entry, and an unbounded map is a slow leak that
 * only shows up in a long-lived process.
 */
const MAX_CLIENTS = 64;

/**
 * Clients by provider, endpoint, model and credential, least recently used
 * evicted first.
 *
 * The credential goes in as a hash of the whole key. A suffix of it used to be
 * enough to tell two rotations of one deployment key apart, and is not enough
 * once keys arrive per call: two customers whose keys share a suffix would
 * have been served the same client, built with one of their keys.
 */
export class ClientCache<T> {
  private readonly entries = new Map<string, T>();

  constructor(private readonly limit = MAX_CLIENTS) {}

  public async resolve(
    parts: { provider: string; baseUrl?: string; model?: string; apiKey: string },
    build: () => T | Promise<T>,
  ): Promise<T> {
    const fingerprint = createHash('sha256').update(parts.apiKey).digest('hex');
    const key = [parts.provider, parts.baseUrl ?? '', parts.model ?? '', fingerprint].join('\0');

    const cached = this.entries.get(key);
    if (cached !== undefined) {
      // Re-inserted so that iteration order is recency order.
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }

    const instance = await build();
    this.entries.set(key, instance);
    if (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return instance;
  }

  public get size(): number {
    return this.entries.size;
  }
}

/**
 * The credential for a route: the call's own when it brought one, the key
 * provider's otherwise.
 *
 * @throws AiError('auth') when neither has one, so that the missing key is
 *   that candidate's failure and the next candidate still gets its turn.
 */
export async function keyFor(
  keys: KeyProvider,
  model: ModelDefinition,
  route: ResolvedRoute,
  overrides?: KeyOverrides,
): Promise<string> {
  const override = overrides?.[route.provider];
  if (override) return override;
  try {
    return await keys.get(route.provider);
  } catch (cause) {
    throw new AiError('auth', `No API key configured for provider "${route.provider}"`, {
      provider: route.provider,
      model: model.name,
      cause,
    });
  }
}
