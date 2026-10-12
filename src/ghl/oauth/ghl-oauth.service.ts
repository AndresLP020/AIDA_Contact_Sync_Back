import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AuditService } from '../../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { badRequest } from '../../common/errors';
import type { Principal } from '../../common/request-context';
import { PrismaService } from '../../prisma/prisma.service';
import { GhlApiError } from '../contacts/ghl-errors';
import { TokenCipher } from '../tokens/token-cipher.service';
import { GhlTokenService, type TokenResponse } from '../tokens/ghl-token.service';

export const STATE_TTL_MS = 10 * 60_000;
export const REQUIRED_SCOPES = ['contacts.readonly'];

export type CallbackOutcome =
  | 'connected'
  | 'denied'
  | 'invalid_request'
  | 'invalid_state'
  | 'exchange_failed'
  | 'invalid_token_response'
  | 'not_location_install'
  | 'missing_scopes'
  | 'location_mismatch'
  | 'location_already_linked';

export const hashState = (state: string) => createHash('sha256').update(state).digest('hex');

@Injectable()
export class GhlOAuthService {
  private readonly logger = new Logger('GhlOAuth');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly tokens: GhlTokenService,
    private readonly cipher: TokenCipher,
    private readonly audit: AuditService,
  ) {}

  /**
   * Genera la URL oficial de autorización (Authorization Code). El state aleatorio se guarda hasheado,
   * ligado a empresa+usuario, con expiración de 10 min y uso único.
   */
  async start(p: Principal): Promise<{ authorizationUrl: string; state: string }> {
    if (this.config.ghl.mode !== 'real') throw badRequest('GHL_MOCK_MODE', 'OAuth sólo está disponible con GHL_MODE=real');
    const state = randomBytes(32).toString('base64url');
    await this.prisma.oAuthState.create({ data: { stateHash: hashState(state), companyId: p.companyId, userId: p.userId, expiresAt: new Date(Date.now() + STATE_TTL_MS) } });
    const url = new URL(this.config.ghl.authorizeUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.ghl.clientId);
    url.searchParams.set('redirect_uri', this.config.ghl.redirectUri);
    url.searchParams.set('scope', this.config.ghl.scopes.join(' '));
    url.searchParams.set('state', state);
    return { authorizationUrl: url.toString(), state };
  }

  /**
   * Procesa el callback. El state puede llegar por query (si GHL lo devuelve) y/o por la cookie HttpOnly
   * puesta en /oauth/start. Si llegan ambos deben coincidir. Se consume atómicamente antes del intercambio.
   */
  async callback(input: { code?: string; queryState?: string; cookieState?: string; error?: string }, correlationId: string): Promise<CallbackOutcome> {
    if (input.error) return 'denied';
    const { code, queryState, cookieState } = input;
    if (!code || code.length > 2048) return 'invalid_request';
    if (queryState && cookieState && queryState !== cookieState) return 'invalid_state';
    const state = queryState ?? cookieState;
    if (!state || state.length > 512) return 'invalid_state';

    const consumed = await this.prisma.oAuthState.updateMany({
      where: { stateHash: hashState(state), consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });
    if (consumed.count !== 1) return 'invalid_state';
    const saved = await this.prisma.oAuthState.findUniqueOrThrow({ where: { stateHash: hashState(state) } });

    // El usuario que inició el flujo debe seguir teniendo rol admin+ en la empresa.
    const membership = await this.prisma.membership.findFirst({ where: { userId: saved.userId, companyId: saved.companyId, status: 'active', role: { in: ['owner', 'admin'] } } });
    if (!membership) return 'invalid_state';

    let data: TokenResponse;
    try {
      data = await this.tokens.exchangeCode(code);
    } catch (e) {
      this.logger.warn({ msg: 'ghl_code_exchange_failed', code: e instanceof GhlApiError ? e.code : 'UNKNOWN', correlationId });
      return e instanceof GhlApiError && e.code === 'GHL_INVALID_RESPONSE' ? 'invalid_token_response' : 'exchange_failed';
    }
    if (data.userType && data.userType !== 'Location') return 'not_location_install';
    if (!data.locationId) return 'not_location_install';
    const scopes = data.scope.split(/[\s,]+/).filter(Boolean);
    if (scopes.length && !REQUIRED_SCOPES.every(s => scopes.includes(s))) return 'missing_scopes';

    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: saved.companyId } });
    if (company.ghlLocationId && company.ghlLocationId !== data.locationId) return 'location_mismatch';
    const other = await this.prisma.ghlInstallation.findFirst({ where: { ghlLocationId: data.locationId, companyId: { not: company.id } } });
    const otherCompany = await this.prisma.company.findFirst({ where: { ghlLocationId: data.locationId, id: { not: company.id } } });
    if (other || otherCompany) return 'location_already_linked';

    const locationId = data.locationId;
    await this.prisma.$transaction(async tx => {
      await tx.company.update({ where: { id: company.id }, data: { ghlLocationId: locationId } });
      const installation = await tx.ghlInstallation.upsert({
        where: { companyId: company.id },
        create: { companyId: company.id, ghlLocationId: locationId, ghlCompanyId: data.companyId ?? null, installationStatus: 'active', grantedScopes: scopes, installedAt: new Date(), lastCommunicationAt: new Date() },
        update: { ghlLocationId: locationId, ghlCompanyId: data.companyId ?? null, installationStatus: 'active', grantedScopes: scopes, installedAt: new Date(), revokedAt: null, lastCommunicationAt: new Date(), lastErrorCode: null },
      });
      const encrypted = {
        encryptedAccessToken: this.cipher.encrypt(data.access_token, installation.id),
        encryptedRefreshToken: this.cipher.encrypt(data.refresh_token, installation.id),
        expiresAt: new Date(Date.now() + data.expires_in * 1000),
      };
      await tx.oAuthCredential.upsert({
        where: { installationId: installation.id },
        create: { installationId: installation.id, ...encrypted },
        update: { ...encrypted, tokenVersion: { increment: 1 } },
      });
      await this.audit.record({ companyId: company.id, actorId: saved.userId, action: 'ghl.connected', resourceType: 'GhlInstallation', resourceId: installation.id, correlationId, metadata: { scopes } }, tx);
    });
    return 'connected';
  }

  /**
   * Desconexión local: elimina credenciales cifradas y marca la instalación como revocada.
   * La documentación oficial no publica un endpoint de revocación de tokens; para retirar el acceso en GHL
   * también debe desinstalarse la app desde la subcuenta (lo cual dispara el webhook UNINSTALL).
   */
  async disconnect(p: Principal, correlationId: string) {
    const installation = await this.prisma.ghlInstallation.findUnique({ where: { companyId: p.companyId } });
    if (!installation || installation.installationStatus === 'revoked') throw badRequest('GHL_NOT_CONNECTED', 'No hay una instalación activa');
    await this.revokeInstallation(installation.id, p.companyId, p.userId, 'ghl.disconnected', correlationId);
  }

  /** Procesa el webhook UNINSTALL ya verificado. */
  async handleUninstall(locationId: string) {
    const installation = await this.prisma.ghlInstallation.findUnique({ where: { ghlLocationId: locationId } });
    if (!installation || installation.installationStatus === 'revoked') return false;
    await this.revokeInstallation(installation.id, installation.companyId, null, 'ghl.uninstalled', randomUUID());
    return true;
  }

  private async revokeInstallation(installationId: string, companyId: string, actorId: string | null, action: string, correlationId: string) {
    await this.prisma.$transaction(async tx => {
      await tx.oAuthCredential.deleteMany({ where: { installationId } });
      await tx.ghlInstallation.update({ where: { id: installationId }, data: { installationStatus: 'revoked', revokedAt: new Date() } });
      await this.audit.record({ companyId, actorId, action, resourceType: 'GhlInstallation', resourceId: installationId, correlationId }, tx);
    });
  }
}
