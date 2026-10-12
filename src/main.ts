import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.factory';
import { APP_CONFIG, type AppConfig, ConfigError, loadConfig } from './config/app-config';
import { JsonLogger } from './common/json-logger';

async function bootstrap() {
  const logger = new JsonLogger(false);
  try {
    loadConfig(); // falla rápido antes de abrir conexiones
  } catch (e) {
    logger.fatal({ msg: 'invalid_configuration', error: e instanceof ConfigError ? e.message : String(e) }, 'Bootstrap');
    process.exit(1);
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger, rawBody: true });
  configureApp(app, logger);
  app.enableShutdownHooks();
  const config = app.get<AppConfig>(APP_CONFIG);
  await app.listen(config.port, '0.0.0.0');
  logger.log({ msg: 'api_started', port: config.port, env: config.env, ghlMode: config.ghl.mode }, 'Bootstrap');
  if (config.ghl.mode === 'mock') logger.warn({ msg: 'GHL_MODE=mock: integración SIMULADA, no se contacta a GoHighLevel' }, 'Bootstrap');
}

void bootstrap();
