import { Body, Controller, Get, HttpCode, Inject, Logger, Post, Res } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import type { Response } from 'express';
import { createHash } from 'node:crypto';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { AppError, forbidden } from '../common/errors';
import { CorrelationId, CurrentPrincipal, type Principal, Public } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { decryptGhlContext } from './ghl-context';
import { verifyPassword } from './password';
import { SESSION_COOKIE, SessionService } from './session.service';

class LoginDto {
  @IsEmail() @MaxLength(254) email!: string;
  @IsString() @MinLength(8) @MaxLength(128) password!: string;
  /** Opcional: empresa a abrir si el usuario pertenece a varias. Se valida contra sus membresías. */
  @IsOptional() @IsUUID() companyId?: string;
}

class GhlContextDto {
  @IsString() @MinLength(40) @MaxLength(8192) encryptedData!: string;
}

const loginLimit = () => Number(process.env.LOGIN_RATE_LIMIT_PER_MINUTE ?? 10);
const invalidCredentials = () => new AppError(401, 'INVALID_CREDENTIALS', 'Credenciales inválidas');

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger('Auth');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  @Post('login')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: loginLimit, ttl: 60_000 } })
  @ApiOperation({ summary: 'Inicia sesión con email y contraseña. Emite cookie HttpOnly de corta duración.' })
  async login(@Body() body: LoginDto, @CorrelationId() correlationId: string, @Res({ passthrough: true }) res: Response) {
    const user = await this.prisma.user.findUnique({
      where: { email: body.email.toLowerCase() },
      include: { memberships: { where: { status: 'active', company: { status: 'active' } }, include: { company: { select: { name: true } } }, orderBy: { company: { name: 'asc' } } } },
    });
    const valid = await verifyPassword(body.password, user?.passwordHash);
    const membership = body.companyId ? user?.memberships.find(m => m.companyId === body.companyId) : user?.memberships[0];
    if (!user || !valid || user.status !== 'active' || !membership) {
      this.logger.warn({ msg: 'login_rejected', emailHash: createHash('sha256').update(body.email.toLowerCase()).digest('hex').slice(0, 16), correlationId });
      throw invalidCredentials();
    }
    const session = await this.sessions.create(user.id, membership.companyId, 'password');
    res.cookie(SESSION_COOKIE, session.token, this.sessions.cookieOptions(session.ttlMs));
    await this.audit.record({ companyId: membership.companyId, actorId: user.id, action: 'auth.login', resourceType: 'Session', correlationId });
    return { expiresAt: session.expiresAt, user: { id: user.id, email: user.email, displayName: user.displayName }, company: { id: membership.companyId, name: membership.company.name }, role: membership.role };
  }

  @Post('logout')
  @HttpCode(200)
  @ApiCookieAuth(SESSION_COOKIE)
  @ApiOperation({ summary: 'Revoca la sesión en el servidor y elimina la cookie' })
  async logout(@CurrentPrincipal() p: Principal, @CorrelationId() correlationId: string, @Res({ passthrough: true }) res: Response) {
    await this.sessions.revoke(p.sessionId);
    res.clearCookie(SESSION_COOKIE, this.sessions.cookieOptions());
    await this.audit.record({ companyId: p.companyId, actorId: p.userId, action: 'auth.logout', resourceType: 'Session', resourceId: p.sessionId, correlationId });
    return { ok: true };
  }

  @Get('me')
  @ApiCookieAuth(SESSION_COOKIE)
  @ApiOperation({ summary: 'Usuario, empresa activa y rol resueltos desde la sesión' })
  async me(@CurrentPrincipal() p: Principal) {
    const [user, company, session] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: p.userId }, select: { id: true, email: true, displayName: true } }),
      this.prisma.company.findUniqueOrThrow({ where: { id: p.companyId }, select: { id: true, name: true } }),
      this.prisma.session.findUniqueOrThrow({ where: { id: p.sessionId }, select: { expiresAt: true, method: true } }),
    ]);
    return { user, company, role: p.role, session };
  }

  /**
   * Acceso incrustado (Custom Page de GHL): el frontend reenvía el payload cifrado recibido por postMessage.
   * Se descifra con el Shared Secret, se exige la location instalada y se emite la sesión de esa subcuenta.
   */
  @Post('ghl-context')
  @Public()
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Crea sesión a partir del contexto de usuario cifrado de una Custom Page de GHL' })
  async ghlContext(@Body() body: GhlContextDto, @CorrelationId() correlationId: string, @Res({ passthrough: true }) res: Response) {
    if (!this.config.ghl.sharedSecret) throw forbidden('GHL_CONTEXT_DISABLED', 'El acceso incrustado no está configurado (GHL_APP_SHARED_SECRET)');
    const rejected = (reason: string) => {
      this.logger.warn({ msg: 'ghl_context_rejected', reason, correlationId });
      const message: Record<string, string> = {
        decrypt_failed: 'No se pudo leer el contexto de GoHighLevel.',
        no_active_location: 'El contexto no incluye la subcuenta activa.',
        unknown_location: 'Esta subcuenta no está registrada en AIDA.',
        installation_inactive: 'La instalación de esta subcuenta no está activa.',
        replayed: 'El contexto de GoHighLevel ya se usó. Recarga la página desde el menú.',
      };
      return new AppError(401, 'GHL_CONTEXT_INVALID', message[reason] ?? 'Contexto de GHL inválido, expirado o no vinculado');
    };
    let ctx;
    try {
      ctx = decryptGhlContext(body.encryptedData, this.config.ghl.sharedSecret);
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 120) : 'decrypt_failed';
      this.logger.warn({ msg: 'ghl_context_decrypt_failed', detail, correlationId });
      throw rejected('decrypt_failed');
    }
    // La Custom Page se abre dentro de una subcuenta. La sesión es de esa location, no del administrador de agencia.
    const company = await this.prisma.company.findUnique({ where: { ghlLocationId: ctx.activeLocation } });
    if (!company || company.status !== 'active') throw rejected('unknown_location');
    const installation = await this.prisma.ghlInstallation.findUnique({ where: { companyId: company.id } });
    if (this.config.ghl.mode === 'real' && installation?.installationStatus !== 'active') throw rejected('installation_inactive');

    const locationKey = `location:${ctx.activeLocation}`;
    const locationEmail = `${ctx.activeLocation.toLowerCase()}@subcuenta.aida`;
    const displayName = ctx.activeLocationName?.trim() || ctx.locationName?.trim() || company.name?.trim() || 'Subcuenta';
    const user = await this.prisma.$transaction(async tx => {
      const existing = await tx.user.findFirst({ where: { OR: [{ ghlUserId: locationKey }, { email: locationEmail }] } });
      const locationUser = existing
        ? await tx.user.update({
            where: { id: existing.id },
            data: { displayName, status: 'active', ...(existing.ghlUserId ? {} : { ghlUserId: locationKey }) },
          })
        : await tx.user.create({ data: { email: locationEmail, displayName, ghlUserId: locationKey } });
      await tx.membership.upsert({
        where: { userId_companyId: { userId: locationUser.id, companyId: company.id } },
        create: { userId: locationUser.id, companyId: company.id, role: 'owner' },
        update: { status: 'active' },
      });
      return locationUser;
    });

    const payloadHash = createHash('sha256').update(body.encryptedData).digest('hex');
    try {
      await this.prisma.ghlContextGrant.create({ data: { payloadHash, expiresAt: new Date(Date.now() + 24 * 3600_000) } });
    } catch {
      // HighLevel reenvía el mismo contexto al reabrir la Custom Page (también desde el dominio white-label). Si sigue vigente, se emite otra sesión.
      const existing = await this.prisma.ghlContextGrant.findUnique({ where: { payloadHash } });
      if (!existing || existing.expiresAt.getTime() <= Date.now()) throw rejected('replayed');
    }

    const session = await this.sessions.create(user.id, company.id, 'ghl_context');
    res.cookie(SESSION_COOKIE, session.token, this.sessions.cookieOptions(session.ttlMs));
    await this.audit.record({ companyId: company.id, actorId: user.id, action: 'auth.ghl_context', resourceType: 'Session', correlationId });
    return { expiresAt: session.expiresAt };
  }
}
