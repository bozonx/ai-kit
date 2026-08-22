import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SHUTDOWN_TIMEOUT_MS } from '../../common/constants/app.constants.js';

/**
 * Service for managing graceful shutdown with request cancellation
 */
@Injectable()
export class ShutdownService implements OnApplicationShutdown {
  private readonly logger = new Logger(ShutdownService.name);
  private abortController: AbortController | null = null;
  private isShuttingDown = false;
  private activeRequests = 0;
  private shutdownResolve: (() => void) | null = null;
  private shutdownTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private readonly normalOperationController = new AbortController();

  /**
   * Check if the service is currently shutting down
   */
  public get shuttingDown(): boolean {
    return this.isShuttingDown;
  }

  /**
   * Get the current AbortSignal for request cancellation
   * Returns null if not in shutdown mode
   */
  public getAbortSignal(): AbortSignal | null {
    return this.abortController?.signal ?? null;
  }

  /**
   * Register a new active request
   * @throws ServiceUnavailableException if shutdown is in progress
   */
  public registerRequest(): void {
    if (this.isShuttingDown) {
      throw new ServiceUnavailableException('Server is shutting down, not accepting new requests');
    }
    this.activeRequests++;
  }

  /**
   * Unregister a completed request.
   * Uses Math.max to prevent negative counter from race conditions.
   */
  public unregisterRequest(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    if (this.activeRequests === 0 && this.shutdownResolve) {
      this.shutdownResolve();
      this.shutdownResolve = null;
    }
  }

  /**
   * Create an AbortSignal for the current request
   * This signal will be aborted when shutdown timeout expires
   */
  public createRequestSignal(): AbortSignal {
    if (this.abortController) {
      return this.abortController.signal;
    }
    // Return a signal that will never abort (normal operation)
    return this.normalOperationController.signal;
  }

  /**
   * Called by NestJS when application is shutting down
   */
  public async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.log(`Shutdown signal received: ${signal ?? 'unknown'}`);
    this.isShuttingDown = true;

    if (this.activeRequests === 0) {
      this.logger.log('No active requests, shutting down immediately');
      return;
    }

    this.logger.log(
      `Waiting for ${this.activeRequests} active request(s) to complete (timeout: ${SHUTDOWN_TIMEOUT_MS}ms)`,
    );

    // Create AbortController for cancelling requests after timeout
    if (!this.abortController) {
      this.abortController = new AbortController();
    }

    // Create a promise that resolves when all requests complete
    const allRequestsComplete = new Promise<void>(resolve => {
      this.shutdownResolve = resolve;
    });

    // Create timeout promise
    const timeout = new Promise<void>(resolve => {
      this.shutdownTimeoutId = setTimeout(() => {
        if (this.activeRequests > 0) {
          this.logger.warn(
            `Shutdown timeout reached, aborting ${this.activeRequests} active request(s)`,
          );

          if (this.abortController && !this.abortController.signal.aborted) {
            this.abortController.abort();
          }
        }
        resolve();
      }, SHUTDOWN_TIMEOUT_MS);

      this.shutdownTimeoutId.unref?.();
    });

    // Wait for either all requests to complete or timeout
    await Promise.race([allRequestsComplete, timeout]);

    if (this.shutdownTimeoutId) {
      clearTimeout(this.shutdownTimeoutId);
      this.shutdownTimeoutId = null;
    }

    this.shutdownResolve = null;

    this.logger.log('Graceful shutdown complete');
  }
}
