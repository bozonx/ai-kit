import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import type { AppConfig } from './config/app.config.js';

async function bootstrap() {
  // Create app with bufferLogs enabled to capture early logs
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: false, // We'll use Pino logger instead
      ignoreTrailingSlash: true,
    }),
    {
      bufferLogs: true,
    },
  );

  // Use Pino logger for the entire application
  app.useLogger(app.get(Logger));

  const configService = app.get(ConfigService);
  const logger = app.get(Logger);

  let fatalErrorHandled = false;
  const handleFatalError = async (label: string, error: unknown) => {
    if (fatalErrorHandled) {
      return;
    }
    fatalErrorHandled = true;

    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(`${label}: ${err.message}`, err.stack, 'Process');

    try {
      await app.close();
    } catch (closeError) {
      const closeErr = closeError instanceof Error ? closeError : new Error(String(closeError));
      logger.error(`Failed to close application: ${closeErr.message}`, closeErr.stack, 'Process');
    } finally {
      process.exit(1);
    }
  };

  process.once('unhandledRejection', reason => {
    void handleFatalError('UnhandledRejection', reason);
  });

  process.once('uncaughtException', err => {
    void handleFatalError('UncaughtException', err);
  });

  const appConfig = configService.get<AppConfig>('app');

  // Ensure app config is available
  if (!appConfig) {
    throw new Error('Application configuration is missing');
  }

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  // Configure global API prefix from configuration
  // Exclude DashboardController from the prefix so it can serve at root / (or BASE_PATH)
  const basePath = appConfig.basePath;
  const globalPrefix = [basePath, 'api', 'v1'].filter(Boolean).join('/');

  // Dashboard routes to exclude from global prefix (which is for API)
  // We need to exclude the paths that DashboardController handles
  const dashboardPrefix = basePath ? `/${basePath}` : '';
  const excludePaths = ['/ui', '/ui/', '/ui/styles.css', '/ui/app.js', '/ui/:filename'].map(path =>
    (dashboardPrefix + path).replace('//', '/'),
  );

  app.setGlobalPrefix(globalPrefix, {
    exclude: excludePaths,
  });

  // Enable graceful shutdown
  app.enableShutdownHooks();

  await app.listen(appConfig.port, appConfig.host);

  logger.log(
    `🚀 NestJS service is running on: http://${appConfig.host}:${appConfig.port}/${globalPrefix}`,
    'Bootstrap',
  );
  logger.log(`📊 Environment: ${appConfig.nodeEnv}`, 'Bootstrap');
  logger.log(`📝 Log level: ${appConfig.logLevel}`, 'Bootstrap');

  // Rely on enableShutdownHooks for graceful shutdown
}

void bootstrap();
