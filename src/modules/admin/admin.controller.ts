import { Controller, Get, Post, Param, NotFoundException, Logger } from '@nestjs/common';
import { StateService } from '../state/state.service.js';
import { RateLimiterService } from '../rate-limiter/rate-limiter.service.js';
import { ModelsService } from '../models/models.service.js';
import type { ModelState } from '../state/interfaces/state.interface.js';
import type { RateLimitStatus } from '../rate-limiter/interfaces/rate-limiter.interface.js';

@Controller('admin')
export class AdminController {
  private readonly logger = new Logger(AdminController.name);

  constructor(
    private readonly stateService: StateService,
    private readonly rateLimiterService: RateLimiterService,
    private readonly modelsService: ModelsService,
  ) { }

  /**
   * Get current state of all models.
   * Returns a list of models with their current stats, circuit breaker status, etc.
   */
  @Get('state')
  public getStates() {
    const states = this.stateService.getAllStates();
    const models = states.map(state => {
      const modelDef = this.modelsService.findModel(state.name);
      // Capitalize provider name for better display
      const provider = modelDef?.provider
        ? modelDef.provider.charAt(0).toUpperCase() + modelDef.provider.slice(1)
        : 'Unknown';

      return {
        ...state,
        modelName: state.name,
        providerName: provider,
        // Include static model definition properties
        tags: modelDef?.tags || [],
        type: modelDef?.type || 'fast',
        contextSize: modelDef?.contextSize || 0,
        weight: modelDef?.weight || 1,
        supportsImage: modelDef?.supportsImage || false,
        supportsVideo: modelDef?.supportsVideo || false,
        supportsAudio: modelDef?.supportsAudio || false,
        supportsFile: modelDef?.supportsFile || false,
        jsonResponse: modelDef?.jsonResponse || false,
        // Also include raw model ID for reference
        model: modelDef?.model || '',
        provider: modelDef?.provider || '',
      };
    });

    return {
      models,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Get state for a specific model by name.
   */
  @Get('state/:modelName')
  public getState(@Param('modelName') modelName: string): ModelState {
    if (!this.stateService.hasState(modelName)) {
      throw new NotFoundException(`Model "${modelName}" not found`);
    }
    return this.stateService.getState(modelName);
  }

  /**
   * Manually reset the state of a model.
   * Useful for clearing 'PERMANENTLY_UNAVAILABLE' state or resetting stats.
   */
  @Post('state/:modelName/reset')
  public resetState(@Param('modelName') modelName: string): { message: string } {
    if (!this.stateService.hasState(modelName)) {
      throw new NotFoundException(`Model "${modelName}" not found`);
    }
    this.logger.warn(`Admin action: Resetting state for model ${modelName}`);
    this.stateService.resetState(modelName);
    return { message: `State for model ${modelName} reset` };
  }

  @Get('metrics')
  public getMetrics() {
    const states = this.stateService.getAllStates();

    const totalRequests = states.reduce((sum, s) => sum + s.stats.totalRequests, 0);
    const successfulRequests = states.reduce((sum, s) => sum + s.stats.successCount, 0);
    const failedRequests = states.reduce((sum, s) => sum + s.stats.errorCount, 0);

    // Weighted Average Latency calculation:
    // We weigh the average latency of each model by its number of successful requests.
    // This gives a more accurate global average latency metric.
    let totalLatencyProduct = 0;
    let totalLatencyCount = 0;

    states.forEach(s => {
      // Only include models with successful requests to avoid skewing data
      if (s.stats.successCount > 0) {
        totalLatencyProduct += s.stats.avgLatency * s.stats.successCount;
        totalLatencyCount += s.stats.successCount;
      }
    });

    const avgLatency = totalLatencyCount > 0 ? totalLatencyProduct / totalLatencyCount : 0;

    const modelsAvailable = states.filter(
      s => s.circuitState === 'CLOSED' || s.circuitState === 'HALF_OPEN',
    ).length;
    const modelsInOpenState = states.filter(s => s.circuitState === 'OPEN').length;
    const modelsPermanentlyUnavailable = states.filter(
      s => s.circuitState === 'PERMANENTLY_UNAVAILABLE',
    ).length;

    return {
      uptime: process.uptime(),
      totalRequests,
      successfulRequests,
      failedRequests,
      fallbacksUsed: this.stateService.getFallbacksUsed(),
      avgLatency: Math.round(avgLatency),
      modelsAvailable,
      modelsInOpenState,
      modelsPermanentlyUnavailable,
    };
  }

  @Get('rate-limits')
  public getRateLimits(): RateLimitStatus {
    return this.rateLimiterService.getStatus();
  }
}
