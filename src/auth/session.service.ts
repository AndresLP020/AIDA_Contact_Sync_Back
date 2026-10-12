import { Inject, Injectable } from '@nestjs/common';
import type { CookieOptions } from 'express';
import jwt from 'jsonwebtoken';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import type { Principal } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';

export const SESSION_COOKIE = 'aida_session';
const ISSUER = 'aida-contact-sync';
const AUDIENCE = 'aida-contact-sync-api';

@Injectable()
export class SessionService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Cookie de sesión HttpOnly. En producción SameSite=None; Secure; Partitioned para funcionar dentro del iframe
   * de GHL (cookie de terceros particionada, CHIPS). En local SameSite=Strict (frontend y API son el mismo "site").
   */
  cookieOptions(maxAgeMs?: number): CookieOptions {
    const prod = this.config.isProduction;
    return { httpOnly: true, secure: this.config.cookieSecure, sameSite: prod ? 'none' : 'strict', partitioned: prod || undefined, path: '/api', ...(maxAgeMs ? { maxAge: maxAgeMs } : {}) };
  }

  async create(userId: string, companyId: string, method: 'password' | 'ghl_context') {
    const ttlMs = this.config.sessionTtlMinutes * 60_000;
    const session = await this.prisma.session.create({ data: { userId, companyId, method, expiresAt: new Date(Date.now() + ttlMs) } });
    const token = jwt.sign({ sid: session.id, cid: companyId }, this.config.jwtSecret, { subject: userId, issuer: ISSUER, audience: AUDIENCE, algorithm: 'HS256', expiresIn: Math.floor(ttlMs / 1000) });
    return { token, expiresAt: session.expiresAt, ttlMs };
  }

  /** Valida firma, expiración, sesión no revocada y membresía activa. Devuelve null si algo falla. */
  async validate(token: string): Promise<Principal | null> {
    let claims: jwt.JwtPayload;
    try {
      claims = jwt.verify(token, this.config.jwtSecret, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE }) as jwt.JwtPayload;
    } catch {
      return null;
    }
    if (typeof claims.sid !== 'string' || typeof claims.sub !== 'string') return null;
    const session = await this.prisma.session.findUnique({ where: { id: claims.sid } });
    if (!session || session.revokedAt || session.expiresAt <= new Date() || session.userId !== claims.sub) return null;
    const membership = await this.prisma.membership.findFirst({
      where: { userId: session.userId, companyId: session.companyId, status: 'active', user: { status: 'active' }, company: { status: 'active' } },
    });
    if (!membership) return null;
    if (Date.now() - session.lastSeenAt.getTime() > 60_000) {
      await this.prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
    }
    return { userId: session.userId, companyId: session.companyId, role: membership.role, sessionId: session.id };
  }

  revoke(sessionId: string) {
    return this.prisma.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { revokedAt: new Date() } });
  }
}
