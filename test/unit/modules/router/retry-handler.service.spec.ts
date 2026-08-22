import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { RetryHandlerService } from '../../../../src/modules/router/services/retry-handler.service.js';

describe('RetryHandlerService', () => {
  let service: RetryHandlerService;

  beforeEach(() => {
    service = new RetryHandlerService();
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  describe('sleep', () => {
    it('should resolve after delay without abortSignal', async () => {
      jest.useFakeTimers();

      const promise = service.sleep(50);
      jest.advanceTimersByTime(50);

      await expect(promise).resolves.toBeUndefined();
    });

    it('should reject with AbortError when abortSignal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(service.sleep(50, controller.signal)).rejects.toMatchObject({
        name: 'AbortError',
      });
    });

    it('should reject promptly when abortSignal is aborted during delay', async () => {
      jest.useFakeTimers();

      const controller = new AbortController();
      const promise = service.sleep(10_000, controller.signal);

      jest.advanceTimersByTime(10);
      controller.abort();

      await expect(promise).rejects.toMatchObject({
        name: 'AbortError',
      });

      // Ensure no timers are left hanging
      jest.runOnlyPendingTimers();
      expect(jest.getTimerCount()).toBe(0);
    });
  });

  describe('executeWithRetry', () => {
    it('should stop retrying when abortSignal is aborted', async () => {
      jest.useFakeTimers();

      const controller = new AbortController();
      const operation = jest.fn(async () => {
        throw new Error('rate limit');
      });

      const promise = service.executeWithRetry({
        operation,
        maxRetries: 10,
        retryDelay: 10_000,
        abortSignal: controller.signal,
        shouldRetry: () => true,
      });

      // Let the first attempt happen
      await Promise.resolve();
      expect(operation).toHaveBeenCalledTimes(1);

      // Abort while sleeping
      controller.abort();

      await expect(promise).rejects.toMatchObject({
        name: 'AbortError',
      });

      // No additional attempts should happen
      await Promise.resolve();
      expect(operation).toHaveBeenCalledTimes(1);

      jest.runOnlyPendingTimers();
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});
