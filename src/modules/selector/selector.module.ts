import { Module } from '@nestjs/common';
import { SelectorService } from './selector.service.js';
import { SmartStrategy } from './strategies/smart.strategy.js';
import { ModelsModule } from '../models/models.module.js';
import { StateModule } from '../state/state.module.js';

/**
 * Module for model selection.
 * Uses SmartStrategy for intelligent routing.
 */
@Module({
  imports: [ModelsModule, StateModule],
  providers: [SelectorService, SmartStrategy],
  exports: [SelectorService],
})
export class SelectorModule {}
