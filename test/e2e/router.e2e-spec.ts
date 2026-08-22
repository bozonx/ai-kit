import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createTestApp } from './test-app.factory.js';

describe('Router (e2e)', () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    // Create fresh app instance for each test for better isolation
    app = await createTestApp();
  });

  afterEach(async () => {
    // Clean up app instance after each test
    if (app) {
      await app.close();
    }
  });

  describe('GET /api/v1/models', () => {
    it('returns list of available models', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/v1/models',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body).toHaveProperty('models');
      expect(Array.isArray(body.models)).toBe(true);
      expect(body.models.length).toBeGreaterThan(0);

      // Check structure of first model
      const firstModel = body.models[0];
      expect(firstModel).toHaveProperty('name');
      expect(firstModel).toHaveProperty('provider');
      expect(firstModel).toHaveProperty('type');
      expect(firstModel).toHaveProperty('contextSize');
      expect(firstModel).toHaveProperty('tags');
      expect(firstModel).toHaveProperty('available');

      expect(firstModel).toHaveProperty('model');
      expect(firstModel).toHaveProperty('maxOutputTokens');
      expect(firstModel).toHaveProperty('jsonResponse');

      expect(['fast', 'reasoning']).toContain(firstModel.type);
      expect(typeof firstModel.contextSize).toBe('number');
      expect(Array.isArray(firstModel.tags)).toBe(true);
    });
  });

  describe('POST /api/v1/chat/completions', () => {
    it('validates required messages field', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/completions',
        payload: {},
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.message).toContain('messages');
    });

    it('validates messages array is not empty', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/completions',
        payload: {
          messages: [],
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('validates message role is valid', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/completions',
        payload: {
          messages: [
            {
              role: 'invalid',
              content: 'test',
            },
          ],
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('validates temperature is in range 0-2', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/completions',
        payload: {
          messages: [
            {
              role: 'user',
              content: 'test',
            },
          ],
          temperature: 3,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('validates top_p is in range 0-1', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/completions',
        payload: {
          messages: [
            {
              role: 'user',
              content: 'test',
            },
          ],
          top_p: 2,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('validates type field with valid values', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/completions',
        payload: {
          messages: [
            {
              role: 'user',
              content: 'test',
            },
          ],
          type: 'invalid',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects non-whitelisted fields', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/completions',
        payload: {
          messages: [
            {
              role: 'user',
              content: 'test',
            },
          ],
          unexpected_field: 'should be rejected',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    // Note: This test requires actual API keys and is skipped in CI
    // Run manually with valid API keys to test integration
    it.skip('successfully completes chat with valid request', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/completions',
        payload: {
          messages: [
            {
              role: 'user',
              content: 'Say hello in one word',
            },
          ],
          temperature: 0.7,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      // Check standard OpenAI fields
      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('object');
      expect(body.object).toBe('chat.completion');
      expect(body).toHaveProperty('created');
      expect(body).toHaveProperty('model');
      expect(body).toHaveProperty('choices');
      expect(body).toHaveProperty('usage');

      // Check choices
      expect(Array.isArray(body.choices)).toBe(true);
      expect(body.choices.length).toBeGreaterThan(0);
      const firstChoice = body.choices[0];
      expect(firstChoice).toHaveProperty('index');
      expect(firstChoice).toHaveProperty('message');
      expect(firstChoice.message).toHaveProperty('role', 'assistant');
      expect(firstChoice.message).toHaveProperty('content');
      expect(firstChoice).toHaveProperty('finish_reason');

      // Check usage
      expect(body.usage).toHaveProperty('prompt_tokens');
      expect(body.usage).toHaveProperty('completion_tokens');
      expect(body.usage).toHaveProperty('total_tokens');

      // Check router metadata
      expect(body).toHaveProperty('_router');
      expect(body._router).toHaveProperty('provider');
      expect(body._router).toHaveProperty('model_name');
      expect(body._router).toHaveProperty('attempts');
      expect(body._router).toHaveProperty('fallback_used');
      expect(typeof body._router.attempts).toBe('number');
      expect(typeof body._router.fallback_used).toBe('boolean');
    });

    it.skip('filters models by type', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/completions',
        payload: {
          messages: [
            {
              role: 'user',
              content: 'Test message',
            },
          ],
          type: 'fast',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body._router.model_name).toBeDefined();
    });

    it.skip('filters models by tags', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/completions',
        payload: {
          messages: [
            {
              role: 'user',
              content: 'Test message',
            },
          ],
          tags: ['code'],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body._router.model_name).toBeDefined();
    });

    it.skip('uses specified model when provided', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/completions',
        payload: {
          messages: [
            {
              role: 'user',
              content: 'Test message',
            },
          ],
          model: 'llama-3.3-70b',
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body._router.model_name).toBe('llama-3.3-70b');
    });
  });

  describe('POST /api/v1/chat/completions (Streaming)', () => {
    it('validates stream parameter is boolean', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/completions',
        payload: {
          messages: [
            {
              role: 'user',
              content: 'test',
            },
          ],
          stream: 'invalid',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it.skip('returns SSE stream when stream=true', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/completions',
        payload: {
          messages: [
            {
              role: 'user',
              content: 'Say hello in one word',
            },
          ],
          stream: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('text/event-stream');
      expect(response.headers['cache-control']).toBe('no-cache');
      expect(response.headers['connection']).toBe('keep-alive');

      // Parse SSE events from body
      const body = response.body;
      const lines = body.split('\n');
      const dataLines = lines.filter((line: string) => line.startsWith('data: '));

      expect(dataLines.length).toBeGreaterThan(0);

      // Check for [DONE] message
      const doneMessage = dataLines.find((line: string) => line === 'data: [DONE]');
      expect(doneMessage).toBeDefined();

      // Check data chunks (all except [DONE])
      const dataChunks = dataLines.filter((line: string) => line !== 'data: [DONE]');
      expect(dataChunks.length).toBeGreaterThan(0);

      // Validate first chunk structure
      const firstChunk = JSON.parse(dataChunks[0].replace('data: ', ''));
      expect(firstChunk).toHaveProperty('id');
      expect(firstChunk).toHaveProperty('object', 'chat.completion.chunk');
      expect(firstChunk).toHaveProperty('created');
      expect(firstChunk).toHaveProperty('model');
      expect(firstChunk).toHaveProperty('choices');

      expect(Array.isArray(firstChunk.choices)).toBe(true);
      const choice = firstChunk.choices[0];
      expect(choice).toHaveProperty('index', 0);
      expect(choice).toHaveProperty('delta');
      expect(choice).toHaveProperty('finish_reason');

      // Check router metadata in first chunk
      expect(firstChunk).toHaveProperty('_router');
      expect(firstChunk._router).toHaveProperty('provider');
      expect(firstChunk._router).toHaveProperty('model_name');
      expect(firstChunk._router).toHaveProperty('attempts');
      expect(firstChunk._router).toHaveProperty('fallback_used');
    });

    it.skip('handles errors in streaming mode', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/completions',
        payload: {
          messages: [
            {
              role: 'user',
              content: 'test',
            },
          ],
          model: 'non-existent-model',
          stream: true,
        },
      });

      // Should return error as SSE or HTTP error
      expect([200, 400, 404, 500]).toContain(response.statusCode);
    });

    it.skip('streams with specific model', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/chat/completions',
        payload: {
          messages: [
            {
              role: 'user',
              content: 'Count to 3',
            },
          ],
          model: 'llama-3.3-70b',
          stream: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('text/event-stream');

      const body = response.body;
      const dataLines = body.split('\n').filter((line: string) => line.startsWith('data: '));

      // Verify chunks contain model name
      const dataChunks = dataLines.filter((line: string) => line !== 'data: [DONE]');
      const firstChunk = JSON.parse(dataChunks[0].replace('data: ', ''));
      expect(firstChunk.model).toContain('llama-3.3-70b');
    });
  });
});
