import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AuditService } from '../../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { badRequest } from '../../common/errors';
import type { Principal } from '../../common/request-context';
import { PrismaService } from '../../prisma/prisma.service';
import { GhlApiError } from '../contacts/ghl-errors';
import { AgencyInstallationService } from '../installation/agency-installation.service';
import { LocationRegistrationService } from '../installation/location-registration.service';
import { GhlTokenService, type TokenResponse } from '../tokens/ghl-token.service';

export const STATE_TTL_MS = 10 * 60_000;
/** Scopes imprescindibles para CONECTAR (sincronización de contactos). Los de aprovisionamiento no se exigen aquí. */
export const REQUIRED_SCOPES = ['contacts.readonly'];

export type CallbackOutcome =
  | 'connected'
  | 'installed'
  | 'agency_installed'
  | 'agency_missing_scopes'
  | 'agency_app_id_missing'
  | 'agency_lookup_failed'
  | 'agency_conflict'
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
const parseScopes = (scope: string) => scope.split(/[\s,]+/).filter(Boolean);

@Injectable()
export class GhlOAuthService {
  private readonly logger = new Logger('GhlOAuth');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly tokens: GhlTokenService,
    private readonly audit: AuditService,
    private readonly registration: LocationRegistrationService,
    private readonly agency: AgencyInstallationService,
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
   * Procesa el callback.
   *  - Con state (query y/o cookie HttpOnly de /oauth/start): flujo iniciado desde Contact Sync. Si llegan ambos
   *    deben coincidir; se consume atómicamente antes del intercambio y liga la location a la empresa del state.
   *  - SIN state ni cookie: instalación iniciada desde Marketplace, sólo si GHL_MARKETPLACE_INSTALL_ENABLED=true.
   *    La legitimidad proviene del intercambio del code con el Client Secret (GHL devuelve la location verificada);
   *    NO se vincula a ninguna sesión ni usuario local y no se concede ningún rol.
   *  - Un state presente pero inválido nunca cae al flujo de Marketplace.
   */
  async callback(input: { code?: string; queryState?: string; cookieState?: string; error?: string }, correlationId: string): Promise<CallbackOutcome> {
    if (input.error) return 'denied';
    const { code, queryState, cookieState } = input;
    if (!code || code.length > 2048) return 'invalid_request';
    if (!queryState && !cookieState) {
      return this.config.ghl.marketplaceInstallEnabled ? this.marketplaceInstall(code, correlationId) : 'invalid_state';
    }
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

    const data = await this.exchange(code, correlationId);
    if (typeof data === 'string') return data;
    if (data.userType && data.userType !== 'Location') return 'not_location_install';
    if (!data.locationId) return 'not_location_install';
    const scopes = parseScopes(data.scope);
    if (scopes.length && !REQUIRED_SCOPES.every(s => scopes.includes(s))) return 'missing_scopes';

    const verifiedName = await this.registration.fetchVerifiedName({ locationId: data.locationId, accessToken: data.access_token, scopes });
    const result = await this.registration.register({
      locationId: data.locationId,
      agencyId: data.companyId ?? null,
      scopes,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      source: 'app_oauth',
      verifiedName,
      bind: { companyId: saved.companyId, userId: saved.userId },
      trigger: 'oauth_callback',
      correlationId,
    });
    return result.outcome === 'registered' ? 'connected' : result.outcome;
  }

  private async marketplaceInstall(code: string, correlationId: string): Promise<CallbackOutcome> {
    const data = await this.exchange(code, correlationId);
    if (typeof data === 'string') return data;
    if (data.userType === 'Company') {
      const r = await this.agency.install(data, correlationId);
      return r.outcome;
    }
    if (!data.locationId) return 'not_location_install';
    const scopes = parseScopes(data.scope);
    if (scopes.length && !REQUIRED_SCOPES.every(s => scopes.includes(s))) return 'missing_scopes';
    const verifiedName = await this.registration.fetchVerifiedName({ locationId: data.locationId, accessToken: data.access_token, scopes });
    const result = await this.registration.register({
      locationId: data.locationId,
      agencyId: data.companyId ?? null,
      scopes,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      source: 'marketplace',
      verifiedName,
      trigger: 'marketplace_install',
      correlationId,
    });
    this.logger.log({ msg: 'ghl_marketplace_install', outcome: result.outcome, correlationId });
    return result.outcome === 'registered' ? 'installed' : result.outcome;
  }

  private async exchange(code: string, correlationId: string): Promise<TokenResponse | CallbackOutcome> {
    try {
      return await this.tokens.exchangeCode(code);
    } catch (e) {
      this.logger.warn({ msg: 'ghl_code_exchange_failed', code: e instanceof GhlApiError ? e.code : 'UNKNOWN', correlationId });
      return e instanceof GhlApiError && e.code === 'GHL_INVALID_RESPONSE' ? 'invalid_token_response' : 'exchange_failed';
    }
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

  /** UNINSTALL a nivel agencia: revoca el grant de agencia y las instalaciones que dependen de él. */
  async handleAgencyUninstall(agencyId: string) {
    const grant = await this.prisma.ghlAgencyGrant.findUnique({ where: { ghlCompanyId: agencyId }, include: { installations: { where: { installationStatus: { not: 'revoked' } } } } });
    if (!grant) return 0;
    await this.prisma.ghlAgencyGrant.update({ where: { id: grant.id }, data: { status: 'revoked', encryptedAccessToken: null, encryptedRefreshToken: null } });
    for (const i of grant.installations) await this.revokeInstallation(i.id, i.companyId, null, 'ghl.uninstalled', randomUUID());
    return grant.installations.length;
  }

  /**
   * Baja: credenciales inutilizadas, instalación revocada, trabajos de configuración pendientes/en curso cancelados
   * (un trabajador en curso pierde su lease y no puede escribir más) y sesiones obtenidas vía contexto de GHL
   * revocadas. NO se borran contactos, custom fields, custom values ni el historial técnico.
   */
  private async revokeInstallation(installationId: string, companyId: string, actorId: string | null, action: string, correlationId: string) {
    await this.prisma.$transaction(async tx => {
      await tx.oAuthCredential.deleteMany({ where: { installationId } });
      await tx.ghlInstallation.update({ where: { id: installationId }, data: { installationStatus: 'revoked', revokedAt: new Date(), configurationStatus: 'cancelled' } });
      const active = await tx.provisioningExecution.findMany({ where: { installationId, status: { in: ['pending', 'running'] } }, select: { id: true, status: true } });
      if (active.length) {
        await tx.provisioningExecution.updateMany({ where: { id: { in: active.map(a => a.id) } }, data: { status: 'cancelled', finishedAt: new Date(), lockedUntil: null, lastErrorCode: 'INSTALLATION_REVOKED' } });
        await tx.provisioningStep.updateMany({ where: { executionId: { in: active.map(a => a.id) }, status: { in: ['pending', 'running'] } }, data: { status: 'cancelled' } });
      }
      const sessions = await tx.session.updateMany({ where: { companyId, method: 'ghl_context', revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.record(
        { companyId, actorId, action, resourceType: 'GhlInstallation', resourceId: installationId, correlationId, metadata: { cancelledExecutions: active.length, executionWasRunning: active.some(a => a.status === 'running'), revokedGhlSessions: sessions.count } },
        tx,
      );
    });
  }
}
