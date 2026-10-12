import { HttpException, HttpStatus } from '@nestjs/common';

/** Error de dominio con código estable para el frontend y los logs. El mensaje debe ser seguro para mostrar. */
export class AppError extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: string,
    message: string,
  ) {
    super({ code, message }, status);
  }
}

export const badRequest = (code: string, message: string) => new AppError(HttpStatus.BAD_REQUEST, code, message);
export const forbidden = (code: string, message: string) => new AppError(HttpStatus.FORBIDDEN, code, message);
export const notFound = (code: string, message: string) => new AppError(HttpStatus.NOT_FOUND, code, message);
export const conflict = (code: string, message: string) => new AppError(HttpStatus.CONFLICT, code, message);
