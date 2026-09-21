import { describe, it, expect } from '@jest/globals';
import { MockEmbeddingModelV4, MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';

import { Catalog } from '../src/catalog/catalog.js';
import { createAiKit } from '../src/kit.js';
import { tool } from '../src/index.js';
import { signalsFor } from '../src/policy/signals.js';
import { isProviderFault } from '../src/errors.js';
import type { UsageEvent } from '../src/ports.js';

/**
 * Structured output, tools, provider options and embeddings: the parts of a
 * call that pass through to the SDK and so break quietly on an upgrade.
 */

const catalog = Catalog.fromYaml(`
models:
  - name: plain
    provider: fake
    model: plain-id
    tier: standard
    contextSize: 100000
    maxOutputTokens: 4096
    capabilities:
      structuredOutput: true
    pricing: { version: 'test', inputPerMTok: 1000000, outputPerMTok: 2000000 }
  - name: agent
    provider: fake
    model: agent-id
    tier: standard
    contextSize: 100000
    maxOutputTokens: 4096
    capabilities:
      tools: true
    pricing: { version: 'test', inputPerMTok: 1000000, outputPerMTok: 2000000 }
  - name: vectors
    kind: embedding
    provider: fake
    model: vectors-id
    tier: economy
    contextSize: 8000
    dimensions: 3
    pricing: { version: 'test', inputPerMTok: 100000, outputPerMTok: 0 }
  - name: vectors-backup
    kind: embedding
    provider: fake
    model: vectors-backup-id
    tier: economy
    contextSize: 10
    dimensions: 3
    pricing: { version: 'test', inputPerMTok: 100000, outputPerMTok: 0 }
taskClasses:
  chat: [plain, agent]
  embed: [vectors-backup, vectors]
`);

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
};

const keys = { get: () => Promise.resolve('test-key') };
const policy = { mode: 'auto' as const, taskClass: 'chat', signals: { estimatedInputTokens: 10 } };
const messages = [{ role: 'user' as const, content: 'hi' }];

function languageModels(doGenerate: (modelId: string, options: unknown) => unknown) {
  const seen: Array<{ modelId: string; options: Record<string, unknown> }> = [];
  const factory = ({ modelId }: { modelId: string }) =>
    new MockLanguageModelV4({
      provider: 'fake',
      modelId,
      doGenerate: async options => {
        seen.push({ modelId, options: options as unknown as Record<string, unknown> });
        return (await doGenerate(modelId, options)) as never;
      },
    });
  return { factory, seen };
}

describe('structured output', () => {
  it('parses the answer against the schema and returns the object', async () => {
    const { factory } = languageModels(() => ({
      content: [{ type: 'text', text: '{"title":"Hello"}' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage,
      warnings: [],
    }));
    const kit = createAiKit({ catalog, keys, providers: { fake: factory } });

    const result = await kit.generate({
      policy,
      messages,
      schema: z.object({ title: z.string() }),
    });

    expect(result.object).toEqual({ title: 'Hello' });
    expect(result.model).toBe('plain');
  });

  it('classifies an answer the schema rejects as invalid output', async () => {
    const { factory } = languageModels(() => ({
      content: [{ type: 'text', text: '{"title":42}' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage,
      warnings: [],
    }));
    const kit = createAiKit({
      catalog,
      keys,
      providers: { fake: factory },
      retry: { maxRetriesPerCandidate: 0 },
    });

    const error = await kit
      .generate({ policy, messages, schema: z.object({ title: z.string() }) })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({ kind: 'invalid_output' });
  });
});

describe('provider options', () => {
  it('reach the provider untouched', async () => {
    const { factory, seen } = languageModels(() => ({
      content: [{ type: 'text', text: 'ok' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage,
      warnings: [],
    }));
    const kit = createAiKit({ catalog, keys, providers: { fake: factory } });

    await kit.generate({
      policy,
      messages,
      providerOptions: { fake: { thinkingBudget: 0 } },
    });

    expect(seen[0]?.options.providerOptions).toEqual({ fake: { thinkingBudget: 0 } });
  });
});

describe('tools', () => {
  it('only tries candidates that can call tools, and runs the loop', async () => {
    const { factory, seen } = languageModels((_modelId, options) => {
      const prompt = (options as { prompt: Array<{ role: string }> }).prompt;
      const answered = prompt.some(message => message.role === 'tool');
      return answered
        ? {
            content: [{ type: 'text', text: 'It is sunny.' }],
            finishReason: { unified: 'stop', raw: undefined },
            usage,
            warnings: [],
          }
        : {
            content: [
              {
                type: 'tool-call',
                toolCallId: 'call-1',
                toolName: 'weather',
                input: '{"city":"Lima"}',
              },
            ],
            finishReason: { unified: 'tool-calls', raw: undefined },
            usage,
            warnings: [],
          };
    });
    const recorded: UsageEvent[] = [];
    const kit = createAiKit({
      catalog,
      keys,
      providers: { fake: factory },
      usage: { record: event => Promise.resolve(void recorded.push(event)) },
    });

    const result = await kit.generate({
      policy,
      messages,
      maxSteps: 3,
      tools: {
        weather: tool({
          description: 'Weather in a city',
          inputSchema: z.object({ city: z.string() }),
          execute: ({ city }) => Promise.resolve(`sunny in ${city}`),
        }),
      },
    });

    expect(seen.every(call => call.modelId === 'agent-id')).toBe(true);
    expect(result.text).toBe('It is sunny.');
    expect(result.steps).toBe(2);
    expect(result.toolCalls).toEqual([
      {
        toolCallId: 'call-1',
        toolName: 'weather',
        args: { city: 'Lima' },
        result: 'sunny in Lima',
      },
    ]);
    expect(result.responseMessages.map(message => message.role)).toEqual([
      'assistant',
      'tool',
      'assistant',
    ]);
    // Both steps are paid for.
    expect(result.usage.inputTokens).toBe(20);
    expect(recorded[0]?.usage.outputTokens).toBe(40);
  });
});

describe('embed', () => {
  function embeddings() {
    const seen: string[] = [];
    const factory = ({ modelId }: { modelId: string }) =>
      new MockEmbeddingModelV4({
        provider: 'fake',
        modelId,
        maxEmbeddingsPerCall: 100,
        doEmbed: ({ values }) => {
          seen.push(modelId);
          return Promise.resolve({
            embeddings: values.map((_, index) => [index, 0, 1]),
            usage: { tokens: 42 },
            warnings: [],
          });
        },
      });
    return { factory, seen };
  }

  it('returns one vector per value and bills the tokens the provider counted', async () => {
    const { factory } = embeddings();
    const recorded: UsageEvent[] = [];
    const kit = createAiKit({
      catalog,
      keys,
      embeddingProviders: { fake: factory },
      usage: { record: event => Promise.resolve(void recorded.push(event)) },
    });

    const result = await kit.embed({
      policy: { mode: 'manual', taskClass: 'embed', requestedModel: 'vectors' },
      values: ['one', 'two'],
    });

    expect(result.embeddings).toEqual([
      [0, 0, 1],
      [1, 0, 1],
    ]);
    expect(result.dimensions).toBe(3);
    expect(result.tokens).toBe(42);
    expect(result.costMicros).toBe(Math.ceil((42 * 100000) / 1_000_000));
    expect(recorded[0]?.usage.inputTokens).toBe(42);
  });

  it('skips a model whose input limit the longest value exceeds', async () => {
    const { factory, seen } = embeddings();
    const kit = createAiKit({ catalog, keys, embeddingProviders: { fake: factory } });

    await kit.embed({ policy: { mode: 'auto', taskClass: 'embed' }, values: ['x'.repeat(400)] });

    expect(seen).toEqual(['vectors-id']);
  });

  it('refuses a task class served by another kind of model', async () => {
    const kit = createAiKit({ catalog, keys });

    await expect(
      kit.embed({ policy: { mode: 'auto', taskClass: 'chat' }, values: ['x'] }),
    ).rejects.toMatchObject({ kind: 'invalid_request' });
  });
});

describe('signalsFor', () => {
  it('counts multi-part content and notices images', () => {
    const signals = signalsFor({
      system: 'be brief',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is on this picture?' },
            { type: 'image', image: new URL('https://example.test/a.png') },
          ],
        },
      ],
    });

    expect(signals.hasImages).toBe(true);
    expect(signals.estimatedInputTokens).toBeGreaterThan(1_000);
  });

  it('says nothing about images when there are none', () => {
    expect(signalsFor({ messages }).hasImages).toBeUndefined();
  });
});

describe('isProviderFault', () => {
  it('holds outages against the route and bad requests against nobody', () => {
    expect(isProviderFault('rate_limit')).toBe(true);
    expect(isProviderFault('unknown')).toBe(true);
    expect(isProviderFault('invalid_request')).toBe(false);
    expect(isProviderFault('content_filter')).toBe(false);
  });
});
