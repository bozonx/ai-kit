import { describe, it, expect } from '@jest/globals';

import { ClientCache } from '../src/providers/client-cache.js';

describe('ClientCache', () => {
  it('never shares a client between two keys with the same suffix', async () => {
    const cache = new ClientCache<string>();
    const first = await cache.resolve({ provider: 'p', apiKey: 'customer-a-12345678' }, () => 'a');
    const second = await cache.resolve({ provider: 'p', apiKey: 'customer-b-12345678' }, () => 'b');

    expect([first, second]).toEqual(['a', 'b']);
  });

  it('reuses a client for the same provider, endpoint, model and key', async () => {
    const cache = new ClientCache<object>();
    const parts = { provider: 'p', model: 'm', baseUrl: 'https://x.test', apiKey: 'k' };
    const first = await cache.resolve(parts, () => ({}));
    const second = await cache.resolve(parts, () => ({}));

    expect(second).toBe(first);
  });

  it('keeps at most its limit, evicting the least recently used', async () => {
    const cache = new ClientCache<string>(2);
    let builds = 0;
    const get = (apiKey: string) =>
      cache.resolve({ provider: 'p', apiKey }, () => `${apiKey}#${String((builds += 1))}`);

    await get('a');
    await get('b');
    await get('a');
    await get('c');

    expect(cache.size).toBe(2);
    expect(await get('a')).toBe('a#1');
    expect(await get('b')).toBe('b#4');
  });
});
