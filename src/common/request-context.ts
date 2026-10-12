import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { MemberRole } from '@prisma/client';
import type { Request } from 'express';

/** Identidad resuelta y validada en el backend. Nunca proviene de parámetros del cliente. */
export type Principal = {
  userId: string;
  companyId: string;
  role: MemberRole;
  sessionId: string;
};

export type AppRequest = Request & { correlationId: string; principal?: Principal; rawBody?: Buffer };

export const IS_PUBLIC = 'isPublic';
/** Marca una ruta como accesible sin sesión (health, login, callbacks y webhooks firmados). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ROLE_RANK: Record<MemberRole, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };
export const MIN_ROLE = 'minRole';
/** Rol mínimo requerido (jerárquico: owner > admin > editor > viewer). */
export const RequireRole = (role: MemberRole) => SetMetadata(MIN_ROLE, role);

export const CurrentPrincipal = createParamDecorator((_: unknown, ctx: ExecutionContext): Principal => {
  const req = ctx.switchToHttp().getRequest<AppRequest>();
  if (!req.principal) throw new Error('Principal no resuelto: ruta sin AuthGuard');
  return req.principal;
});

export const CorrelationId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  return ctx.switchToHttp().getRequest<AppRequest>().correlationId;
});

export function hasRole(principal: Principal, role: MemberRole) {
  return ROLE_RANK[principal.role] >= ROLE_RANK[role];
}
