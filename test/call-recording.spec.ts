import { describe, it, expect } from '@jest/globals';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';

import { Catalog } from '../src/catalog/catalog.js';
import { createAiKit } from '../src/kit.js';
import type { GenerationTrace, SpanTrace, UsageEvent } from '../src/ports.js';
import type { StreamPart } from '../src/stream/stream-parts.js';

/**
 * What reaches the host's sinks, on the paths that used to reach nothing.
 *
 * A call that failed, a sink that threw, a stream stopped after only reasoning:
 * each of these was once either silent or fatal, and neither is visible until
 * somebody reconciles a bill or wonders why a broken route looks idle.
 */

const catalog = Catalog.fromYaml(`
models:
  - name: primary
    provider: fake
    model: primary-id
    tier: standard
    contextSize: 100000
    maxOutputTokens: 4096
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
    pricing:
      version: 'test'
      inputPerMTok: 1000000
      outputPerMTok: 2000000
taskClasses:
  chat: [primary, backup]
`);

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

const keys = { get: () => Promise.resolve('test-key') };
const retry = { initialDelayMs: 1, maxDelayMs: 2, maxRetriesPerCandidate: 0 };
const messages = [{ role: 'user' as const, content: 'hi' }];

function apiError(statusCode: number): APICallError {
  return new APICallError({
    message: `provider said ${String(statusCode)}`,
    url: 'https://provider.test',
    requestBodyValues: {},
    statusCode,
  });
}

function model(handlers: {
  doGenerate?: (modelId: string) => unknown;
  doStream?: (modelId: string) => unknown;
}) {
  return ({ modelId }: { apiKey: string; modelId: string }) =>
    new MockLanguageModelV4({
      provider: 'fake',
      modelId,
      doGenerate: async () => (await handlers.doGenerate?.(modelId)) as never,
      doStream: async () => (await handlers.doStream?.(modelId)) as never,
    });
}

function sinks() {
  const events: UsageEvent[] = [];
  const generations: GenerationTrace[] = [];
  const spans: SpanTrace[] = [];
  return {
    events,
    generations,
    spans,
    usage: { record: (event: UsageEvent) => Promise.resolve(void events.push(event)) },
    trace: {
      generation: (trace: GenerationTrace) => void generations.push(trace),
      span: (trace: SpanTrace) => void spans.push(trace),
    },
  };
}

async function collect(parts: AsyncIterable<StreamPart>): Promise<StreamPart[]> {
  const out: StreamPart[] = [];
  for await (const part of parts) out.push(part);
  return out;
}

describe('a call that ends without an answer', () => {
  it('is recorded at zero cost, with every attempt counted', async () => {
    const recorded = sinks();
    const kit = createAiKit({
      catalog,
      keys,
      retry,
      usage: recorded.usage,
      trace: recorded.trace,
      providers: {
        fake: model({
          doGenerate: () => {
            throw apiError(503);
          },
        }),
      },
    });

    await expect(
      kit.generate({ policy: { taskClass: 'chat' }, messages, traceId: 't1', name: 'feature' }),
    ).rejects.toThrow();

    expect(recorded.events).toHaveLength(1);
    expect(recorded.events[0]).toMatchObject({
      model: 'backup',
      status: 'error',
      costMicros: 0,
      attempts: 2,
      traceId: 't1',
    });
    const generation = recorded.generations.find(trace => trace.status === 'error');
    expect(generation?.name).toBe('feature');
    expect(generation?.error).toBeDefined();
  });

  it('is recorded when a stream fails before its first token', async () => {
    const recorded = sinks();
    const kit = createAiKit({
      catalog,
      keys,
      retry,
      usage: recorded.usage,
      providers: {
        fake: model({
          doStream: () => {
            throw apiError(503);
          },
        }),
      },
    });

    await expect(
      collect(kit.stream({ policy: { taskClass: 'chat' }, messages })),
    ).rejects.toThrow();
    expect(recorded.events.map(event => event.status)).toEqual(['error']);
  });
});

describe('a usage sink that throws', () => {
  it('does not take the answer down with it', async () => {
    const recorded = sinks();
    const kit = createAiKit({
      catalog,
      keys,
      retry,
      trace: recorded.trace,
      usage: { record: () => Promise.reject(new Error('database is down')) },
      providers: {
        fake: model({
          doGenerate: () => ({
            content: [{ type: 'text', text: 'answer' }],
            finishReason: 'stop',
            usage,
            warnings: [],
          }),
        }),
      },
    });

    const result = await kit.generate({ policy: { taskClass: 'chat' }, messages });

    expect(result.text).toBe('answer');
    expect(recorded.spans.map(span => span.name)).toContain('generate.usage-failed');
  });
});

describe('the usage part of a stream', () => {
  it('carries the same accounting generate returns', async () => {
    const kit = createAiKit({
      catalog,
      keys,
      retry,
      providers: {
        fake: model({
          doStream: modelId => {
            if (modelId === 'primary-id') throw apiError(503);
            return {
              stream: new ReadableStream({
                start(controller) {
                  controller.enqueue({ type: 'text-start', id: '1' });
                  controller.enqueue({ type: 'text-delta', id: '1', delta: 'ok' });
                  controller.enqueue({ type: 'text-end', id: '1' });
                  controller.enqueue({ type: 'finish', finishReason: 'stop', usage });
                  controller.close();
                },
              }),
            };
          },
        }),
      },
    });

    const parts = await collect(kit.stream({ policy: { taskClass: 'chat' }, messages }));
    const part = parts.find(item => item.type === 'usage');

    expect(part).toMatchObject({
      provider: 'fake',
      model: 'backup',
      routedBy: 'fallback',
      attempts: 2,
      costMicros: 50,
      priceVersion: 'test',
    });
    expect(part?.type === 'usage' && part.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('bills a stream stopped after reasoning alone', async () => {
    const recorded = sinks();
    const kit = createAiKit({
      catalog,
      keys,
      retry,
      usage: recorded.usage,
      providers: {
        fake: model({
          doStream: () => ({
            stream: new ReadableStream({
              start(controller) {
                controller.enqueue({ type: 'reasoning-start', id: 'r' });
                controller.enqueue({
                  type: 'reasoning-delta',
                  id: 'r',
                  delta: 'thinking about it at some length',
                });
              },
            }),
          }),
        }),
      },
    });

    for await (const part of kit.stream({ policy: { taskClass: 'chat' }, messages })) {
      if (part.type === 'reasoning-delta') break;
    }

    expect(recorded.events[0]?.status).toBe('aborted');
    expect(recorded.events[0]?.usage.outputTokens).toBeGreaterThan(0);
  });
});

describe('a policy that leaves things out', () => {
  it('reads the size of the request off its messages', () => {
    const kit = createAiKit({ catalog, keys });
    const plan = kit.plan({ policy: { taskClass: 'chat' }, messages });

    expect(plan.signals.estimatedInputTokens).toBeGreaterThan(0);
    expect(plan.candidates[0]?.routedBy).toBe('auto');
  });

  it('pins the model it names without being told the mode', () => {
    const kit = createAiKit({ catalog, keys });
    const plan = kit.plan({ policy: { taskClass: 'chat', requestedModel: 'backup' }, messages });

    expect(plan.candidates.map(candidate => candidate.model.name)).toEqual(['backup']);
    expect(plan.candidates[0]?.routedBy).toBe('user');
  });
});
