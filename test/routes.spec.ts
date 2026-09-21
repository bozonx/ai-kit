import { describe, it, expect } from '@jest/globals';

import { Catalog } from '../src/catalog/catalog.js';
import { selectCandidates } from '../src/policy/policy.js';

/**
 * The same model at several providers.
 *
 * The rule the whole feature exists for: a provider having a bad ten minutes
 * costs a request one extra attempt, not a different model. Somebody who
 * pinned a model by name has agreed to a change of route and to nothing else.
 */

const yaml = `
models:
  - name: writer
    provider: openrouter
    model: vendor/writer
    routeId: writer-openrouter
    tier: premium
    contextSize: 200000
    maxOutputTokens: 8192
    capabilities:
      tools: true
      structuredOutput: true
    pricing:
      version: 'aggregated'
      inputPerMTok: 3000000
      outputPerMTok: 15000000
    routes:
      - id: writer-direct
        provider: anthropic
        model: writer-4-5
        priority: 10
        pricing:
          version: 'direct'
          inputPerMTok: 2000000
          outputPerMTok: 10000000
      - id: writer-slow
        provider: openai
        model: writer-compat
        priority: 20
        capabilities:
          structuredOutput: false
      - id: writer-off
        provider: google
        model: writer-mirror
        priority: 5
        available: false
  - name: plain
    provider: google
    model: plain-1
    tier: premium
    contextSize: 200000
    maxOutputTokens: 8192
    pricing:
      version: 'x'
      inputPerMTok: 1
      outputPerMTok: 1
taskClasses:
  writing: [writer, plain]
`;

const catalog = Catalog.fromYaml(yaml);
const signals = { estimatedInputTokens: 1_000 };

describe('resolving routes', () => {
  it('puts the definition first and the backups behind it by priority', () => {
    expect(catalog.routesOf('writer').map(route => route.provider)).toEqual([
      'openrouter',
      'anthropic',
      'openai',
    ]);
  });

  it('leaves a route that was switched off out of the list entirely', () => {
    expect(catalog.routesOf('writer').map(route => route.id)).not.toContain('writer-off');
  });

  it('gives a model with no backups exactly one route', () => {
    expect(catalog.routesOf('plain')).toHaveLength(1);
    expect(catalog.routesOf('plain')[0]).toMatchObject({ index: 0, provider: 'google' });
  });

  it('lets a route carry its own price, inheriting the model price where it does not', () => {
    const [aggregated, direct, compat] = catalog.routesOf('writer');

    expect(aggregated?.pricing?.version).toBe('aggregated');
    expect(direct?.pricing?.version).toBe('direct');
    // The third route states no price of its own, so it is the model's.
    expect(compat?.pricing?.version).toBe('aggregated');
  });

  it('lets a route narrow what the model claims it can do', () => {
    const [aggregated, , compat] = catalog.routesOf('writer');

    expect(aggregated?.capabilities.structuredOutput).toBe(true);
    expect(compat?.capabilities.structuredOutput).toBe(false);
    // Everything the route said nothing about is still the model's answer.
    expect(compat?.capabilities.tools).toBe(true);
  });

  it('refuses two routes to one model at the same provider', () => {
    expect(() =>
      Catalog.fromYaml(yaml.replace('        provider: openai\n', '        provider: anthropic\n')),
    ).toThrow(/more than one route at provider "anthropic"/);
  });
});

describe('routes as candidates', () => {
  it('tries every route of a model before moving to another model', () => {
    const result = selectCandidates({ mode: 'auto', taskClass: 'writing', signals }, catalog);

    expect(result.map(candidate => `${candidate.model.name}@${candidate.route.provider}`)).toEqual([
      'writer@openrouter',
      'writer@anthropic',
      'writer@openai',
      'plain@google',
    ]);
  });

  it('calls only the very first attempt the plan and the rest a fallback', () => {
    const result = selectCandidates({ mode: 'auto', taskClass: 'writing', signals }, catalog);

    expect(result.map(candidate => candidate.routedBy)).toEqual([
      'auto',
      'fallback',
      'fallback',
      'fallback',
    ]);
  });

  it('drops a route that cannot serve the request but keeps the model', () => {
    const result = selectCandidates(
      {
        mode: 'auto',
        taskClass: 'writing',
        signals: { ...signals, needsStructuredOutput: true },
      },
      catalog,
    );

    expect(result.map(candidate => candidate.route.provider)).not.toContain('openai');
    expect(result.map(candidate => candidate.model.name)).toContain('writer');
  });

  it('gives a pinned model its other routes and no other model', () => {
    const result = selectCandidates(
      { mode: 'manual', taskClass: 'writing', requestedModel: 'writer', signals },
      catalog,
    );

    expect(result.map(candidate => candidate.model.name)).toEqual(['writer', 'writer', 'writer']);
    expect(result.map(candidate => candidate.routedBy)).toEqual(['user', 'fallback', 'fallback']);
  });

  it('honours a provider-qualified pin as a pin on one route', () => {
    const result = selectCandidates(
      { mode: 'manual', taskClass: 'writing', requestedModel: 'anthropic/writer', signals },
      catalog,
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.route.id).toBe('writer-direct');
  });

  it('moves a route the consumer reports as unhealthy to the back, never out', () => {
    const result = selectCandidates(
      {
        mode: 'auto',
        taskClass: 'writing',
        signals,
        demotedRoutes: new Set(['writer-openrouter']),
      },
      catalog,
    );

    const writerRoutes = result
      .filter(candidate => candidate.model.name === 'writer')
      .map(candidate => candidate.route.id);
    expect(writerRoutes).toEqual(['writer-direct', 'writer-slow', 'writer-openrouter']);
  });
});
