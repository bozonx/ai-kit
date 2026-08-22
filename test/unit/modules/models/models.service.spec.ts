import { Test, type TestingModule } from '@nestjs/testing';
import { jest } from '@jest/globals';
import { ModelsService } from '../../../../src/modules/models/models.service.js';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTER_CONFIG } from '../../../../src/config/router-config.provider.js';
import { HttpService } from '@nestjs/axios';
import { of } from 'rxjs';

describe('ModelsService', () => {
  let service: ModelsService;
  const testModelsFile = join(process.cwd(), 'test-models.yaml');

  const testModelsYaml = `
models:
  - name: test-fast-model
    provider: openrouter
    model: test/fast:free
    type: fast
    contextSize: 8000
    maxOutputTokens: 2000
    tags: [general, code]
    jsonResponse: true
    available: true

  - name: test-reasoning-model
    provider: deepseek
    model: test/reasoning
    type: reasoning
    contextSize: 64000
    maxOutputTokens: 8000
    tags: [reasoning, math]
    jsonResponse: true
    available: true

  - name: test-unavailable-model
    provider: openrouter
    model: test/unavailable:free
    type: fast
    contextSize: 4000
    maxOutputTokens: 1000
    tags: [simple]
    jsonResponse: false
    available: false
`;

  const mockHttpService = {
    get: jest.fn(),
  };

  beforeEach(async () => {
    // Create test models file
    writeFileSync(testModelsFile, testModelsYaml, 'utf-8');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ModelsService,
        {
          provide: ROUTER_CONFIG,
          useValue: {
            modelsFile: testModelsFile,
          },
        },
        {
          provide: HttpService,
          useValue: mockHttpService,
        },
      ],
    }).compile();

    service = module.get<ModelsService>(ModelsService);
    await service.onModuleInit();
  });

  afterEach(() => {
    // Clean up test file
    try {
      unlinkSync(testModelsFile);
    } catch {
      // ignore
    }
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getModels', () => {
    it('should return all models', () => {
      const models = service.getModels();
      expect(models).toHaveLength(3);
      expect(models.map(m => m.name)).toEqual([
        'test-fast-model',
        'test-reasoning-model',
        'test-unavailable-model',
      ]);
    });
  });

  describe('findModel', () => {
    it('should find model by name', () => {
      const model = service.findModel('test-fast-model');
      expect(model).toBeDefined();
      expect(model?.name).toBe('test-fast-model');
      expect(model?.provider).toBe('openrouter');
    });

    it('should return undefined for non-existent model', () => {
      const model = service.findModel('non-existent');
      expect(model).toBeUndefined();
    });
  });

  describe('filter', () => {
    it('should filter by tags', () => {
      const models = service.filter({ tags: ['code'] });
      expect(models).toHaveLength(1);
      expect(models[0]?.name).toBe('test-fast-model');
    });

    it('should filter by type', () => {
      const models = service.filter({ type: 'reasoning' });
      expect(models).toHaveLength(1);
      expect(models[0]?.name).toBe('test-reasoning-model');
    });

    it('should filter by minimum context size', () => {
      const models = service.filter({ minContextSize: 60000 });
      expect(models).toHaveLength(1);
      expect(models[0]?.name).toBe('test-reasoning-model');
    });

    it('should filter by minimum max output tokens', () => {
      const models = service.filter({ minMaxOutputTokens: 5000 });
      expect(models).toHaveLength(1);
      expect(models[0]?.name).toBe('test-reasoning-model');
    });

    it('should filter by JSON response support', () => {
      const models = service.filter({ jsonResponse: true });
      expect(models).toHaveLength(2);
      expect(models.map(m => m.name)).toEqual(['test-fast-model', 'test-reasoning-model']);
    });

    it('should filter by provider', () => {
      const models = service.filter({ provider: 'deepseek' });
      expect(models).toHaveLength(1);
      expect(models[0]?.name).toBe('test-reasoning-model');
    });

    it('should filter by multiple criteria', () => {
      const models = service.filter({
        type: 'fast',
        tags: ['code'],
        jsonResponse: true,
      });
      expect(models).toHaveLength(1);
      expect(models[0]?.name).toBe('test-fast-model');
    });

    it('should exclude unavailable models', () => {
      const models = service.filter({ tags: ['simple'] });
      expect(models).toHaveLength(0);
    });

    it('should return empty array when no models match', () => {
      const models = service.filter({ tags: ['nonexistent'] });
      expect(models).toHaveLength(0);
    });

    it('should filter using DNF logic (OR between groups, AND within groups)', () => {
      // Should match model with either 'code' OR 'reasoning' tag
      const modelsOr = service.filter({ tags: ['code|reasoning'] });
      expect(modelsOr).toHaveLength(2);
      expect(modelsOr.map(m => m.name)).toContain('test-fast-model');
      expect(modelsOr.map(m => m.name)).toContain('test-reasoning-model');

      // Array elements are OR-ed: ['code|reasoning', 'math'] means (code OR reasoning) OR (math)
      // This should match both models: test-fast-model has 'code', test-reasoning-model has both 'reasoning' and 'math'
      const modelsArrayOr = service.filter({ tags: ['code|reasoning', 'math'] });
      expect(modelsArrayOr).toHaveLength(2);

      // For AND logic, use & within a single group: 'reasoning&math' means (reasoning AND math)
      const modelsAnd = service.filter({ tags: ['reasoning&math'] });
      expect(modelsAnd).toHaveLength(1);
      expect(modelsAnd[0]?.name).toBe('test-reasoning-model');
    });
  });

  describe('overrides', () => {
    it.skip('should apply overrides correctly (not implemented yet)', async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ModelsService,
          {
            provide: ROUTER_CONFIG,
            useValue: {
              modelsFile: testModelsFile,
              modelOverrides: [
                {
                  name: 'test-fast-model',
                  weight: 10,
                  available: false,
                },
              ],
            },
          },
          {
            provide: HttpService,
            useValue: mockHttpService,
          },
        ],
      }).compile();

      const overrideService = module.get<ModelsService>(ModelsService);
      await overrideService.onModuleInit();

      const model = overrideService.findModel('test-fast-model');
      expect(model).toBeDefined();
      // Note: model overrides are not implemented in current ModelsService
    });
  });

  describe('URL loading', () => {
    it('should load models from HTTP URL', async () => {
      const mockHttpService = {
        get: jest.fn(() => of({ data: testModelsYaml })),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ModelsService,
          {
            provide: ROUTER_CONFIG,
            useValue: {
              modelsFile: 'https://example.com/models.yaml',
            },
          },
          {
            provide: HttpService,
            useValue: mockHttpService,
          },
        ],
      }).compile();

      const urlService = module.get<ModelsService>(ModelsService);
      await urlService.onModuleInit();

      expect(mockHttpService.get).toHaveBeenCalledWith('https://example.com/models.yaml');
      expect(urlService.getModels()).toHaveLength(3);
    });

    it('should handle HTTP errors gracefully', async () => {
      const mockHttpService = {
        get: jest.fn(() => {
          throw new Error('Network error');
        }),
      };

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          ModelsService,
          {
            provide: ROUTER_CONFIG,
            useValue: {
              modelsFile: 'https://example.com/models.yaml',
            },
          },
          {
            provide: HttpService,
            useValue: mockHttpService,
          },
        ],
      }).compile();

      const urlService = module.get<ModelsService>(ModelsService);
      await urlService.onModuleInit();

      // Service should handle errors gracefully and set models to empty array
      expect(urlService.getModels()).toHaveLength(0);
    });
  });
});
