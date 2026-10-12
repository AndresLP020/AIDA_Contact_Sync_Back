import { randomUUID } from 'node:crypto';
import type { NextFunction, Response } from 'express';
import type { AppConfig } from '../config/app-config';
import type { AppRequest } from './request-context';
import { JsonLogger } from './json-logger';

const CORRELATION_FORMAT = /^[A-Za-z0-9._-]{8,100}$/;

/** Asigna un Correlation ID (respeta el del cliente sólo si tiene un formato seguro) y lo devuelve en la respuesta. */
export function correlationMiddleware(req: AppRequest, res: Response, next: NextFunction) {
  const incoming = req.headers['x-correlation-id'];
  req.correlationId = typeof incoming === 'string' && CORRELATION_FORMAT.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-correlation-id', req.correlationId);
  next();
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Rutas llamadas por servidores de GHL (no por el navegador); se protegen con firma, no con Origin. */
const SERVER_TO_SERVER = ['/api/v1/integrations/ghl/webhooks'];

/**
 * Protección CSRF para operaciones de escritura:
 *  1. Origin debe pertenecer a FRONTEND_ORIGIN.
 *  2. Content-Type debe ser application/json (fuerza preflight CORS; un formulario HTML no puede enviarlo).
 * Complementa a la cookie SameSite.
 */
export function csrfMiddleware(config: AppConfig) {
  return (req: AppRequest, res: Response, next: NextFunction) => {
    if (!UNSAFE.has(req.method) || SERVER_TO_SERVER.includes(req.path)) return next();
    const origin = req.headers.origin;
    if (!origin || !config.frontendOrigins.includes(origin)) {
      return res.status(403).json({ statusCode: 403, code: 'CSRF_ORIGIN_REJECTED', message: 'Origen no permitido', correlationId: req.correlationId });
    }
    const type = String(req.headers['content-type'] ?? '');
    if (!type.toLowerCase().startsWith('application/json')) {
      return res.status(415).json({ statusCode: 415, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Se requiere Content-Type: application/json', correlationId: req.correlationId });
    }
    next();
  };
}

/** Log de acceso estructurado: sin query string ni cuerpos (pueden contener datos personales o códigos OAuth). */
export function accessLogMiddleware(logger: JsonLogger) {
  return (req: AppRequest, res: Response, next: NextFunction) => {
    const started = process.hrtime.bigint();
    res.on('finish', () => {
      logger.log(
        {
          msg: 'http_request',
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
          correlationId: req.correlationId,
          companyId: req.principal?.companyId,
          userId: req.principal?.userId,
        },
        'HTTP',
      );
    });
    next();
  };
}
