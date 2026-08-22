import { Injectable, Logger } from '@nestjs/common';
import { RETRY_JITTER_PERCENT } from '../../../common/constants/retry.constants.js';

export interface RetryConfig {
  maxRetries: number;
  baseDelay: number;
}

@Injectable()
export class RetryHandlerService {
  private readonly logger = new Logger(RetryHandlerService.name);

  public calculateRetryDelay(baseDelay: number): number {
    const jitter = (Math.random() - 0.5) * 2 * ((baseDelay * RETRY_JITTER_PERCENT) / 100);
    return Math.max(0, Math.round(baseDelay + jitter));
  }

  public async sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
    if (abortSignal?.aborted) {
      throw this.createAbortError();
    }

    return new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        abortSignal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);

      const onAbort = () => {
        clearTimeout(timeoutId);
        abortSignal?.removeEventListener('abort', onAbort);
        reject(this.createAbortError());
      };

      if (abortSignal) {
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      timeoutId.unref?.();
    });
  }

  public async executeWithRetry<T>(params: {
    operation: () => Promise<T>;
    maxRetries: number;
    retryDelay: number;
    shouldRetry: (error: unknown) => boolean;
    onRetry?: (attempt: number, error: unknown) => void;
    abortSignal?: AbortSignal;
  }): Promise<T> {
    const { operation, maxRetries, retryDelay, shouldRetry, onRetry, abortSignal } = params;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (abortSignal?.aborted) {
          throw this.createAbortError();
        }
        return await operation();
      } catch (error) {
        if (abortSignal?.aborted) {
          throw this.createAbortError();
        }
        if (attempt === maxRetries || !shouldRetry(error)) {
          throw error;
        }

        const delay = this.calculateRetryDelay(retryDelay);
        onRetry?.(attempt + 1, error);

        await this.sleep(delay, abortSignal);
      }
    }

    throw new Error('Retry logic failed unexpectedly');
  }

  private createAbortError(): Error {
    try {
      return new DOMException('The operation was aborted', 'AbortError');
    } catch {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      return error;
    }
  }
}
