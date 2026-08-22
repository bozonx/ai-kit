import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import pkg from '../package.json' with { type: 'json' };
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import appConfig from './config/app.config.js';
import type { AppConfig } from './config/app.config.js';
import { RouterConfigModule } from './config/router-config.module.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { DashboardModule } from './modules/dashboard/dashboard.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { RateLimiterModule } from './modules/rate-limiter/rate-limiter.module.js';
import { RouterModule } from './modules/router/router.module.js';
import { ShutdownModule } from './modules/shutdown/shutdown.module.js';

@Module({
  imports: [
    RouterConfigModule,
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      envFilePath: [`.env.${process.env.NODE_ENV ?? 'development'}`, '.env'],
      cache: true,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const appConfig = configService.get<AppConfig>('app');
        if (!appConfig) {
          throw new Error('Application configuration is missing');
        }
        const isDev = appConfig.nodeEnv === 'development';

        return {
          pinoHttp: {
            level: appConfig.logLevel,
            timestamp: () => `,"@timestamp":"${new Date().toISOString()}"`,
            base: {
              service: typeof pkg === 'object' && pkg && 'name' in pkg ? pkg.name : 'app',
              environment: appConfig.nodeEnv,
            },
            transport: isDev
              ? {
                  target: 'pino-pretty',
                  options: {
                    colorize: true,
                    singleLine: false,
                    translateTime: "UTC:yyyy-mm-dd'T'HH:MM:ss.l'Z'",
                    ignore: 'pid,hostname',
                    messageFormat: '[{context}] {msg}',
                  },
                }
              : undefined,
            serializers: {
              req: req => ({
                id: req.id,
                method: req.method,
                url: req.url,
                path: req.url?.split('?')[0] ?? '',
                remoteAddress: req.ip,
                remotePort: req.socket?.remotePort,
              }),
              res: res => ({
                statusCode: res.statusCode,
              }),
              err: err => ({
                type: err.type,
                message: err.message,
                stack: err.stack,
              }),
            },
            redact: {
              paths: ['req.headers.authorization', 'req.headers["x-api-key"]'],
              censor: '[REDACTED]',
            },
            customLogLevel: (req, res, err) => {
              if (res.statusCode >= 500 || err) {
                return 'error';
              }
              if (res.statusCode >= 400) {
                return 'warn';
              }
              if (res.statusCode >= 300) {
                return 'info';
              }
              return 'info';
            },
            autoLogging: {
              ignore: req => {
                if (appConfig.nodeEnv === 'production') {
                  return req.url?.includes('/health') ?? false;
                }
                return false;
              },
            },
          },
        };
      },
    }),
    ShutdownModule,
    RateLimiterModule,
    DashboardModule,
    AdminModule,
    HealthModule,
    RouterModule,
  ],
  controllers: [],
  providers: [
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
  ],
})
export class AppModule {}
