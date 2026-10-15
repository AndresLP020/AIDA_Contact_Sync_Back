import { type INestApplication, ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { APP_CONFIG, type AppConfig } from './config/app-config';
import { accessLogMiddleware, correlationMiddleware, csrfMiddleware } from './common/http-middleware';
import { JsonLogger } from './common/json-logger';

/** Configuración HTTP compartida por main.ts y las pruebas de integración (mismo pipeline de seguridad). */
export function configureApp(app: NestExpressApplication, logger: JsonLogger): INestApplication {
  const config = app.get<AppConfig>(APP_CONFIG);
  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.setGlobalPrefix('api/v1');
  app.use(correlationMiddleware);
  // La API (Render) y el frontend (Vercel) son sitios distintos: el navegador debe poder leer las respuestas.
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' }, hsts: config.isProduction }));
  app.use(cookieParser());
  app.enableCors({
    origin: config.frontendOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['content-type', 'idempotency-key', 'x-correlation-id'],
    exposedHeaders: ['x-correlation-id'],
    maxAge: 600,
  });
  app.use(csrfMiddleware(config));
  app.use(accessLogMiddleware(logger));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, stopAtFirstError: false }));

  if (config.swaggerEnabled) {
    const doc = new DocumentBuilder()
      .setTitle('AIDA Contact Sync API')
      .setDescription('API propia de AIDA Contact Sync (/api/v1). No confundir con la API oficial de GoHighLevel (services.leadconnectorhq.com).')
      .setVersion('1.0')
      .addCookieAuth('aida_session')
      .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, doc), { jsonDocumentUrl: 'api/docs/openapi.json' });
  }
  return app;
}
