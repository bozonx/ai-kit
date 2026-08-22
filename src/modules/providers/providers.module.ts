import { Module, DynamicModule, Provider } from '@nestjs/common';
import { HttpModule, HttpService } from '@nestjs/axios';
import { OpenRouterProvider } from './openrouter.provider.js';
import { DeepSeekProvider } from './deepseek.provider.js';
import { loadRouterConfig } from '../../config/router.config.js';
import type { LlmProvider } from './interfaces/provider.interface.js';
import type { BaseProviderConfig } from './base.provider.js';
import type { RouterConfig } from '../../config/router-config.interface.js';

/**
 * Token for providers map
 */
export const PROVIDERS_MAP = 'PROVIDERS_MAP';

/**
 * Providers map type
 */
export type ProvidersMap = Map<string, LlmProvider>;

/**
 * Module for LLM providers
 */
@Module({})
export class ProvidersModule {
  /**
   * Register providers dynamically based on configuration
   */
  public static forRoot(): DynamicModule {
    const routerConfig: RouterConfig = loadRouterConfig();

    const providers: Provider[] = [];

    // Register OpenRouter if enabled
    if (routerConfig.providers['openrouter']?.enabled) {
      const openRouterConfig: BaseProviderConfig = {
        apiKey: routerConfig.providers['openrouter'].apiKey,
        baseUrl: routerConfig.providers['openrouter'].baseUrl ?? 'https://openrouter.ai/api/v1',
        timeoutSecs: routerConfig.routing.timeoutSecs,
      };

      providers.push({
        provide: 'OpenRouterProvider',
        useFactory: (httpService: HttpService) =>
          new OpenRouterProvider(httpService, openRouterConfig),
        inject: [HttpService],
      });
    } else {
      providers.push({
        provide: 'OpenRouterProvider',
        useValue: undefined,
      });
    }

    // Register DeepSeek if enabled
    if (routerConfig.providers['deepseek']?.enabled) {
      const deepSeekConfig: BaseProviderConfig = {
        apiKey: routerConfig.providers['deepseek'].apiKey,
        baseUrl: routerConfig.providers['deepseek'].baseUrl ?? 'https://api.deepseek.com',
        timeoutSecs: routerConfig.routing.timeoutSecs,
      };

      providers.push({
        provide: 'DeepSeekProvider',
        useFactory: (httpService: HttpService) => new DeepSeekProvider(httpService, deepSeekConfig),
        inject: [HttpService],
      });
    } else {
      providers.push({
        provide: 'DeepSeekProvider',
        useValue: undefined,
      });
    }

    // Create providers map provider
    providers.push({
      provide: PROVIDERS_MAP,
      useFactory: (openRouter?: OpenRouterProvider, deepSeek?: DeepSeekProvider) => {
        const map = new Map<string, LlmProvider>();

        if (openRouter) {
          map.set('openrouter', openRouter);
        }
        if (deepSeek) {
          map.set('deepseek', deepSeek);
        }

        return map;
      },
      inject: ['OpenRouterProvider', 'DeepSeekProvider'],
    });

    return {
      module: ProvidersModule,
      imports: [HttpModule],
      providers,
      exports: [PROVIDERS_MAP],
    };
  }
}
