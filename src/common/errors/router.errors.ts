import { HttpException, HttpStatus } from '@nestjs/common';

export class AllModelsFailedError extends Error {
  constructor(
    public readonly attemptCount: number,
    public readonly errors: Array<{
      provider: string;
      model: string;
      error: string;
      code?: number;
    }>,
  ) {
    super(`All models failed after ${attemptCount} attempts`);
    this.name = 'AllModelsFailedError';
  }
}

export class NoSuitableModelError extends Error {
  constructor(message = 'No suitable model found') {
    super(message);
    this.name = 'NoSuitableModelError';
  }
}

export class ProviderNotFoundError extends Error {
  constructor(public readonly providerName: string) {
    super(`Provider ${providerName} not found`);
    this.name = 'ProviderNotFoundError';
  }
}

export class RequestCancelledError extends HttpException {
  constructor(reason: 'shutdown' | 'client') {
    const message =
      reason === 'shutdown'
        ? 'Request cancelled: server is shutting down'
        : 'Request cancelled by client';
    super(message, HttpStatus.SERVICE_UNAVAILABLE);
    this.name = 'RequestCancelledError';
  }
}
