import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { ServiceUnavailableException } from '@nestjs/common';
import { ShutdownService } from '../../../../src/modules/shutdown/shutdown.service.js';
import { SHUTDOWN_TIMEOUT_MS } from '../../../../src/common/constants/app.constants.js';

describe('ShutdownService', () => {
  let service: ShutdownService;

  beforeEach(() => {
    service = new ShutdownService();
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  describe('initial state', () => {
    it('should not be shutting down initially', () => {
      expect(service.shuttingDown).toBe(false);
    });

    it('should return null abort signal initially', () => {
      expect(service.getAbortSignal()).toBeNull();
    });

    it('should create a non-aborted signal for requests', () => {
      const signal = service.createRequestSignal();
      expect(signal).toBeDefined();
      expect(signal.aborted).toBe(false);
    });
  });

  describe('registerRequest', () => {
    it('should allow registering requests when not shutting down', () => {
      expect(() => service.registerRequest()).not.toThrow();
    });

    it('should throw ServiceUnavailableException when shutting down', () => {
      // Trigger shutdown
      void service.onApplicationShutdown('SIGTERM');

      expect(() => service.registerRequest()).toThrow(ServiceUnavailableException);
    });
  });

  describe('unregisterRequest', () => {
    it('should complete shutdown when all requests finish', async () => {
      // Register a request
      service.registerRequest();

      // Start shutdown (this will wait for active requests)
      const shutdownPromise = service.onApplicationShutdown('SIGTERM');

      // Unregister the request
      service.unregisterRequest();

      // Shutdown should complete quickly
      await expect(shutdownPromise).resolves.toBeUndefined();
    });
  });

  describe('onApplicationShutdown', () => {
    it('should set shuttingDown to true', async () => {
      const shutdownPromise = service.onApplicationShutdown('SIGTERM');

      expect(service.shuttingDown).toBe(true);

      // Complete shutdown (no active requests)
      await shutdownPromise;
    });

    it('should complete immediately when no active requests', async () => {
      const start = Date.now();

      await service.onApplicationShutdown('SIGTERM');

      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(100);
    });

    it('should wait for active requests to complete', async () => {
      jest.useFakeTimers();
      // Register a request
      service.registerRequest();

      const shutdownPromise = service.onApplicationShutdown('SIGTERM');

      // Simulate request completing after small delay
      jest.advanceTimersByTime(50);
      service.unregisterRequest();

      await expect(shutdownPromise).resolves.toBeUndefined();
      jest.useRealTimers();
    });

    it('should create abort controller when shutdown starts with active requests', async () => {
      // Register a request
      service.registerRequest();

      // Start shutdown
      const shutdownPromise = service.onApplicationShutdown('SIGTERM');

      // Abort signal should now be available
      expect(service.getAbortSignal()).not.toBeNull();

      // Cleanup
      service.unregisterRequest();
      await expect(shutdownPromise).resolves.toBeUndefined();
    });

    it('should clear shutdown timeout when requests complete before timeout', async () => {
      jest.useFakeTimers();

      service.registerRequest();

      const shutdownPromise = service.onApplicationShutdown('SIGTERM');

      // Ensure timeout has been scheduled
      expect(jest.getTimerCount()).toBeGreaterThan(0);

      // Complete the request before SHUTDOWN_TIMEOUT_MS
      service.unregisterRequest();
      await expect(shutdownPromise).resolves.toBeUndefined();

      // Run any pending timers; they should have been cleared by the service
      jest.runOnlyPendingTimers();
      expect(jest.getTimerCount()).toBe(0);

      jest.useRealTimers();
    });
  });

  describe('shutdown timeout constant', () => {
    it('should be 25 seconds', () => {
      expect(SHUTDOWN_TIMEOUT_MS).toBe(25_000);
    });
  });
});
