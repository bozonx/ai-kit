import { describe, it, expect } from '@jest/globals';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

import { Catalog } from '../src/catalog/catalog.js';
import { createAiKit } from '../src/kit.js';
import type { UsageEvent } from '../src/ports.js';
import type { StreamPart } from '../src/stream/stream-parts.js';

/**
 * The retry rules, checked against a model that fails on purpose.
 *
 * These are the tests worth having twice: an accidental retry after the first
 * token is invisible in development and looks, in production, like the answer
 * rewriting itself while somebody reads it.
 */

const catalog = Catalog.fromYaml(`
models:
  - name: primary
    provider: fake
    model: primary-id
    tier: standard
    contextSize: 100000
    maxOutputTokens: 4096
    capabilities:
      structuredOutput: true
    pricing:
      version: 'test'
      inputPerMTok: 1000000
      outputPerMTok: 2000000
  - name: backup
    provider: fake
    model: backup-id
    tier: standard
    contextSize: 100000
    maxOutputTokens: 4096
    capabilities:
      structuredOutput: true
    pricing:
      version: 'test'
      inputPerMTok: 1000000
      outputPerMTok: 2000000
taskClasses:
  chat_simple: [primary, backup]
`);

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

function apiError(statusCode: number): APICallError {
  return new APICallError({
    message: `provider said ${String(statusCode)}`,
    url: 'https://provider.test',
    requestBodyValues: {},
    statusCode,
  });
}

/** Counts calls per model id, so a test can assert what was actually tried. */
function fakeProvider(handlers: {
  doGenerate?: (modelId: string, call: number) => unknown;
  doStream?: (modelId: string, call: number) => unknown;
}) {
  const calls: string[] = [];
  const perModel = new Map<string, number>();

  const factory = ({ modelId }: { apiKey: string; modelId: string }) =>
    new MockLanguageModelV4({
      provider: 'fake',
      modelId,
      doGenerate: async () => {
        calls.push(modelId);
        const nth = (perModel.get(modelId) ?? 0) + 1;
        perModel.set(modelId, nth);
        return (await handlers.doGenerate?.(modelId, nth)) as never;
      },
      doStream: async () => {
        calls.push(modelId);
        const nth = (perModel.get(modelId) ?? 0) + 1;
        perModel.set(modelId, nth);
        return (await handlers.doStream?.(modelId, nth)) as never;
      },
    });

  return { factory, calls };
}

function textResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: 'stop' as const,
    usage,
    warnings: [],
  };
}

function textStream(parts: Array<Record<string, unknown>>) {
  return {
    stream: new ReadableStream({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
  };
}

const keys = { get: () => Promise.resolve('test-key') };
const policy = {
  mode: 'auto' as const,
  taskClass: 'chat_simple' as const,
  signals: { estimatedInputTokens: 100 },
};
const messages = [{ role: 'user' as const, content: 'hi' }];
const retry = { initialDelayMs: 1, maxDelayMs: 2 };

describe('generate', () => {
  it('reports which model answered and what it cost', async () => {
    const recorded: UsageEvent[] = [];
    const { factory } = fakeProvider({ doGenerate: () => textResult('answer') });
    const kit = createAiKit({
      catalog,
      keys,
      retry,
      providers: { fake: factory },
      usage: { record: event => Promise.resolve(void recorded.push(event)) },
    });

    const result = await kit.generate({ policy, messages });

    expect(result.text).toBe('answer');
    expect(result.model).toBe('primary');
    expect(result.routedBy).toBe('auto');
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    });
    // 10 in at 1 unit/token plus 20 out at 2 units/token.
    expect(result.costMicros).toBe(50);
    expect(result.priceVersion).toBe('test');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.status).toBe('ok');
  });

  it('retries the same model on a rate limit, then succeeds', async () => {
    const { factory, calls } = fakeProvider({
      doGenerate: (_modelId, nth) => {
        if (nth === 1) throw apiError(429);
        return textResult('second try');
      },
    });
    const kit = createAiKit({ catalog, keys, retry, providers: { fake: factory } });

    const result = await kit.generate({ policy, messages });

    expect(result.text).toBe('second try');
    expect(result.attempts).toBe(2);
    expect(calls).toEqual(['primary-id', 'primary-id']);
  });

  it('moves to the next candidate once a model is out of retries', async () => {
    const { factory, calls } = fakeProvider({
      doGenerate: modelId => {
        if (modelId === 'primary-id') throw apiError(503);
        return textResult('from backup');
      },
    });
    const kit = createAiKit({ catalog, keys, retry, providers: { fake: factory } });

    const result = await kit.generate({ policy, messages });

    expect(result.model).toBe('backup');
    expect(result.routedBy).toBe('fallback');
    expect(calls.filter(id => id === 'primary-id')).toHaveLength(3);
  });

  it('never retries a request the provider called invalid', async () => {
    const { factory, calls } = fakeProvider({
      doGenerate: () => {
        throw apiError(400);
      },
    });
    const kit = createAiKit({ catalog, keys, retry, providers: { fake: factory } });

    await expect(kit.generate({ policy, messages })).rejects.toMatchObject({
      kind: 'no_candidates',
    });
    // One try per candidate, no repeats.
    expect(calls).toEqual(['primary-id', 'backup-id']);
  });

  it('never retries an authentication failure', async () => {
    const { factory, calls } = fakeProvider({
      doGenerate: () => {
        throw apiError(401);
      },
    });
    const kit = createAiKit({ catalog, keys, retry, providers: { fake: factory } });

    await expect(kit.generate({ policy, messages })).rejects.toBeDefined();
    expect(calls).toEqual(['primary-id', 'backup-id']);
  });
});

async function collect(stream: AsyncIterable<StreamPart>): Promise<StreamPart[]> {
  const parts: StreamPart[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

describe('stream', () => {
  it('announces the model before any text and accounts at the end', async () => {
    const recorded: UsageEvent[] = [];
    const { factory } = fakeProvider({
      doStream: () =>
        textStream([
          { type: 'text-start', id: '1' },
          { type: 'text-delta', id: '1', delta: 'he' },
          { type: 'text-delta', id: '1', delta: 'llo' },
          { type: 'text-end', id: '1' },
          { type: 'finish', finishReason: 'stop', usage },
        ]),
    });
    const kit = createAiKit({
      catalog,
      keys,
      retry,
      providers: { fake: factory },
      usage: { record: event => Promise.resolve(void recorded.push(event)) },
    });

    const parts = await collect(kit.stream({ policy, messages }));

    expect(parts[0]).toEqual({
      type: 'model',
      provider: 'fake',
      model: 'primary',
      routedBy: 'auto',
    });
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.text)).toEqual(['he', 'llo']);
    expect(parts.at(-1)).toEqual({ type: 'finish', finishReason: 'stop' });
    expect(recorded[0]?.costMicros).toBe(50);
  });

  it('retries before the first token, invisibly', async () => {
    const { factory, calls } = fakeProvider({
      doStream: (_modelId, nth) => {
        if (nth === 1) throw apiError(503);
        return textStream([
          { type: 'text-start', id: '1' },
          { type: 'text-delta', id: '1', delta: 'ok' },
          { type: 'text-end', id: '1' },
          { type: 'finish', finishReason: 'stop', usage },
        ]);
      },
    });
    const kit = createAiKit({ catalog, keys, retry, providers: { fake: factory } });

    const parts = await collect(kit.stream({ policy, messages }));

    expect(calls).toEqual(['primary-id', 'primary-id']);
    expect(parts.some(p => p.type === 'error')).toBe(false);
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.text)).toEqual(['ok']);
  });

  it('does not retry once output has reached the reader', async () => {
    const { factory, calls } = fakeProvider({
      doStream: () =>
        textStream([
          { type: 'text-start', id: '1' },
          { type: 'text-delta', id: '1', delta: 'half an ans' },
          { type: 'error', error: apiError(503) },
        ]),
    });
    const kit = createAiKit({ catalog, keys, retry, providers: { fake: factory } });

    const parts = await collect(kit.stream({ policy, messages }));

    expect(calls).toEqual(['primary-id']);
    const error = parts.find(p => p.type === 'error');
    expect(error).toMatchObject({ kind: 'stream_interrupted', recoverable: true });
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.text)).toEqual(['half an ans']);
  });

  it('charges for a stream that was interrupted after producing output', async () => {
    const recorded: UsageEvent[] = [];
    const { factory } = fakeProvider({
      doStream: () =>
        textStream([
          { type: 'text-start', id: '1' },
          { type: 'text-delta', id: '1', delta: 'partial' },
          { type: 'finish', finishReason: 'stop', usage },
          { type: 'error', error: apiError(503) },
        ]),
    });
    const kit = createAiKit({
      catalog,
      keys,
      retry,
      providers: { fake: factory },
      usage: { record: event => Promise.resolve(void recorded.push(event)) },
    });

    await collect(kit.stream({ policy, messages }));

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.costMicros).toBe(50);
    expect(recorded[0]?.status).toBe('error');
  });

  it('estimates usage when an aborted stream omits final accounting', async () => {
    const recorded: UsageEvent[] = [];
    const abortController = new AbortController();
    const { factory } = fakeProvider({
      doStream: () =>
        textStream([
          { type: 'text-start', id: '1' },
          { type: 'text-delta', id: '1', delta: 'a partial answer' },
          { type: 'text-delta', id: '1', delta: ' that should not arrive' },
          { type: 'finish', finishReason: 'stop', usage },
        ]),
    });
    const kit = createAiKit({
      catalog,
      keys,
      retry,
      providers: { fake: factory },
      usage: { record: event => Promise.resolve(void recorded.push(event)) },
    });

    for await (const part of kit.stream({
      policy,
      messages,
      abortSignal: abortController.signal,
    })) {
      if (part.type === 'text-delta') abortController.abort();
    }

    expect(recorded[0]?.status).toBe('aborted');
    expect(recorded[0]?.usage.outputTokens).toBeGreaterThan(0);
    expect(recorded[0]?.costMicros).toBeGreaterThan(0);
  });
});

describe('falling back to another route of the same model', () => {
  const routed = Catalog.fromYaml(`
models:
  - name: writer
    provider: fake
    model: writer-aggregated
    routeId: writer-aggregated
    tier: standard
    contextSize: 100000
    maxOutputTokens: 4096
    pricing:
      version: 'aggregated'
      inputPerMTok: 2000000
      outputPerMTok: 4000000
    routes:
      - id: writer-direct
        provider: other
        model: writer-direct
        priority: 10
        pricing:
          version: 'direct'
          inputPerMTok: 1000000
          outputPerMTok: 2000000
taskClasses:
  chat_simple: [writer]
`);

  it('tries the second provider of the same model and bills at its price', async () => {
    const events: UsageEvent[] = [];
    const { factory, calls } = fakeProvider({
      doGenerate: modelId => {
        if (modelId === 'writer-aggregated') throw apiError(503);
        return {
          content: [{ type: 'text', text: 'ok' }],
          finishReason: 'stop',
          usage,
          warnings: [],
        };
      },
    });

    const kit = createAiKit({
      catalog: routed,
      keys: { get: () => Promise.resolve('key') },
      usage: {
        record: event => {
          events.push(event);
          return Promise.resolve();
        },
      },
      providers: { fake: factory, other: factory },
    });

    const result = await kit.generate({
      policy: {
        mode: 'manual',
        taskClass: 'chat_simple',
        requestedModel: 'writer',
        signals: { estimatedInputTokens: 10 },
      },
      messages: [{ role: 'user', content: 'hi' }],
    });

    // The model the caller pinned is the model that answered; only the way to
    // it changed.
    expect(result.model).toBe('writer');
    expect(result.provider).toBe('other');
    expect(result.routeId).toBe('writer-direct');
    expect(result.priceVersion).toBe('direct');
    expect(calls).toContain('writer-direct');
    expect(events[0]).toMatchObject({ routeId: 'writer-direct', priceVersion: 'direct' });
  });

  it('names the route that answered in the first stream part', async () => {
    const { factory } = fakeProvider({
      doStream: modelId => {
        if (modelId === 'writer-aggregated') throw apiError(503);
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({ type: 'text-start', id: '1' });
              controller.enqueue({ type: 'text-delta', id: '1', delta: 'hi' });
              controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
              controller.close();
            },
          }),
        };
      },
    });

    const kit = createAiKit({
      catalog: routed,
      keys: { get: () => Promise.resolve('key') },
      providers: { fake: factory, other: factory },
    });

    const parts: StreamPart[] = [];
    for await (const part of kit.stream({
      policy: {
        mode: 'manual',
        taskClass: 'chat_simple',
        requestedModel: 'writer',
        signals: { estimatedInputTokens: 10 },
      },
      messages: [{ role: 'user', content: 'hi' }],
    })) {
      parts.push(part);
    }

    expect(parts[0]).toMatchObject({ type: 'model', model: 'writer', routeId: 'writer-direct' });
  });
});
