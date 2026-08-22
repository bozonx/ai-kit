import { Global, Module } from '@nestjs/common';
import { ShutdownService } from './shutdown.service.js';

/**
 * Global module for graceful shutdown management
 */
@Global()
@Module({
  providers: [ShutdownService],
  exports: [ShutdownService],
})
export class ShutdownModule {}
