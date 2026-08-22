import { Module, forwardRef } from '@nestjs/common';
import { StateService } from './state.service.js';
import { CircuitBreakerService } from './circuit-breaker.service.js';
import { ModelsModule } from '../models/models.module.js';
import { routerConfigProvider, ROUTER_CONFIG } from '../../config/router-config.provider.js';
import {
  CircuitBreakerConfigProvider,
  CIRCUIT_BREAKER_CONFIG,
} from './circuit-breaker-config.provider.js';

@Module({
  imports: [forwardRef(() => ModelsModule)],
  providers: [
    routerConfigProvider,
    CircuitBreakerConfigProvider,
    StateService,
    CircuitBreakerService,
  ],
  exports: [StateService, CircuitBreakerService, ROUTER_CONFIG, CIRCUIT_BREAKER_CONFIG],
})
export class StateModule {}
