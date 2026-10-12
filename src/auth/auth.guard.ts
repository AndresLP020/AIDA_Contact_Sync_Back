import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { MemberRole } from '@prisma/client';
import { AppError, forbidden } from '../common/errors';
import { type AppRequest, hasRole, IS_PUBLIC, MIN_ROLE } from '../common/request-context';
import { SESSION_COOKIE, SessionService } from './session.service';

/**
 * Guard GLOBAL: toda ruta exige sesión salvo las marcadas con @Public().
 * La empresa activa sale de la sesión validada en el servidor; nunca de un parámetro del cliente.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext) {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const req = context.switchToHttp().getRequest<AppRequest>();
    const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
    const token = bearer ?? (typeof req.cookies?.[SESSION_COOKIE] === 'string' ? (req.cookies[SESSION_COOKIE] as string) : undefined);
    if (!token) throw new AppError(401, 'SESSION_REQUIRED', 'Inicia sesión para continuar');
    const principal = await this.sessions.validate(token);
    if (!principal) throw new AppError(401, 'SESSION_INVALID', 'Sesión inválida, expirada o revocada');
    req.principal = principal;

    const minRole = this.reflector.getAllAndOverride<MemberRole | undefined>(MIN_ROLE, targets);
    if (minRole && !hasRole(principal, minRole)) throw forbidden('INSUFFICIENT_ROLE', 'Tu rol no tiene permiso para esta operación');
    return true;
  }
}
