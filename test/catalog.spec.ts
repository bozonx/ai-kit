import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from '@jest/globals';

import { Catalog } from '../src/catalog/catalog.js';
import { CatalogError } from '../src/errors.js';

const minimal = `
models:
  - name: fast
    provider: google
    model: gemini-2.5-flash
    tier: standard
    contextSize: 1000000
    maxOutputTokens: 8192
    pricing:
      version: '2026-08'
      inputPerMTok: 300000
      outputPerMTok: 2500000
taskClasses:
  summarize: [fast]
`;

describe('Catalog', () => {
  it('applies the documented defaults to a minimal entry', () => {
    const model = Catalog.fromYaml(minimal).require('fast');

    expect(model.available).toBe(true);
    expect(model.weight).toBe(1);
    expect(model.tags).toEqual([]);
    expect(model.modalities).toEqual({ input: ['text'], output: ['text'] });
    expect(model.capabilities.streaming).toBe(true);
    expect(model.capabilities.tools).toBe(false);
  });

  it('refuses a task class that names a model nobody defined', () => {
    const yaml = minimal.replace('summarize: [fast]', 'summarize: [fast, ghost]');

    expect(() => Catalog.fromYaml(yaml)).toThrow(CatalogError);
    expect(() => Catalog.fromYaml(yaml)).toThrow(/ghost/);
  });

  it('refuses two models with the same name', () => {
    const one = {
      name: 'fast',
      provider: 'google',
      model: 'gemini-2.5-flash',
      tier: 'standard',
      contextSize: 1_000_000,
      maxOutputTokens: 8192,
      pricing: { version: '2026-08', inputPerMTok: 300_000, outputPerMTok: 2_500_000 },
    };

    expect(() =>
      Catalog.fromObject({ models: [one, one], taskClasses: { summarize: ['fast'] } }),
    ).toThrow(/Duplicate model name/);
  });

  it('refuses a price that is not an integer', () => {
    expect(() => Catalog.fromYaml(minimal.replace('300000', '0.3'))).toThrow(CatalogError);
  });

  it('refuses text that is not YAML', () => {
    expect(() => Catalog.fromYaml('models: [')).toThrow(/not valid YAML/);
  });

  it('drops unavailable models from the candidate list', () => {
    const yaml = minimal.replace('    tier: standard', '    tier: standard\n    available: false');

    expect(Catalog.fromYaml(yaml).candidatesFor('summarize')).toHaveLength(0);
  });

  it('returns nothing for a task class the operator did not configure', () => {
    expect(Catalog.fromYaml(minimal).candidatesFor('chat_agentic')).toEqual([]);
  });

  it('throws for a model that is not there rather than returning undefined', () => {
    expect(() => Catalog.fromYaml(minimal).require('ghost')).toThrow(CatalogError);
    expect(Catalog.fromYaml(minimal).find('ghost')).toBeUndefined();
  });

  it('validates the example catalog shipped with the package', () => {
    const path = fileURLToPath(new URL('../models.example.yaml', import.meta.url));
    const catalog = Catalog.fromYaml(readFileSync(path, 'utf8'));

    expect(catalog.models.length).toBeGreaterThan(0);
    for (const taskClass of catalog.taskClasses) {
      expect(catalog.candidatesFor(taskClass).length).toBeGreaterThan(0);
    }
  });
});
