import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';
import { GhlApiError } from '../ghl/contacts/ghl-errors';
import type { AppRequest } from './request-context';

const DEFAULT_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'TOO_MANY_REQUESTS',
  502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE',
};

/**
 * Manejo centralizado de errores. Respuesta uniforme { statusCode, code, message, correlationId }.
 * Nunca devuelve stack traces, SQL, cuerpos de respuestas de GHL ni secretos.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Errors');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<AppRequest>();
    const res = ctx.getResponse<Response>();
    const correlationId = req.correlationId;
    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'Error interno. Usa el Correlation ID para diagnosticarlo.';
    const extra: Record<string, unknown> = {};

    if (exception instanceof GhlApiError) {
      status = exception.httpStatus();
      code = exception.code;
      message = exception.message;
      if (exception.retryAfterSeconds) extra.retryAfterSeconds = exception.retryAfterSeconds;
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      code = DEFAULT_CODES[status] ?? `HTTP_${status}`;
      if (typeof body === 'string') message = body;
      else if (body && typeof body === 'object') {
        const b = body as { code?: string; message?: string | string[] };
        if (b.code) code = b.code;
        if (Array.isArray(b.message)) {
          code = b.code ?? 'VALIDATION_FAILED';
          message = b.message.join('; ');
        } else if (b.message) message = b.message;
      }
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') [status, code, message] = [409, 'DUPLICATE', 'El registro ya existe'];
      else if (exception.code === 'P2025') [status, code, message] = [404, 'NOT_FOUND', 'Recurso no encontrado'];
    }

    if (status >= 500) {
      this.logger.error({ msg: 'request_failed', code, correlationId, path: req.path, error: exception instanceof Error ? exception.message : String(exception) }, exception instanceof Error ? exception.stack : undefined);
    } else {
      this.logger.warn({ msg: 'request_rejected', code, status, correlationId, path: req.path });
    }
    res.status(status).json({ statusCode: status, code, message, correlationId, ...extra });
  }
}
