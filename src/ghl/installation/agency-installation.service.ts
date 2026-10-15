import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { PrismaService } from '../../prisma/prisma.service';
import { GhlApiError } from '../contacts/ghl-errors';
import { GhlHttp } from '../contacts/ghl-http';
import { GHL_HTTP_TUNING, type GhlHttpTuning } from '../contacts/http-ghl-contacts.client';
import { FETCH, type FetchFn, GhlTokenService, type TokenResponse } from '../tokens/ghl-token.service';
import { TokenCipher } from '../tokens/token-cipher.service';
import { LocationRegistrationService } from './location-registration.service';

/** Scopes necesarios para operar con un token de agencia (apps/oauth.json). */
export const AGENCY_SCOPES = ['oauth.readonly', 'oauth.write'] as const;
const PAGE_SIZE = 100;
/** Límite de seguridad por callback. Las restantes se registrarán en la siguiente autorización. */
export const MAX_AGENCY_LOCATIONS = 1000;

const installedSchema = z.object({
  locations: z.array(z.object({ _id: z.string().min(1).max(128), name: z.string().max(200).optional(), isInstalled: z.boolean().optional() })),
  count: z.number().int().nonnegative().optional(),
});

export type AgencyInstallResult =
  | { outcome: 'agency_installed'; registered: number; failed: number; conflicts: number }
  | { outcome: 'agency_missing_scopes' | 'agency_app_id_missing' | 'agency_lookup_failed' };

/**
 * Instalación con token de AGENCIA (userType=Company):
 *  1. Guarda el grant de agencia cifrado.
 *  2. Lista SÓLO las locations donde la app está instalada: GET /oauth/installedLocations?isInstalled=true
 *     (nunca enumera todas las subcuentas de la agencia).
 *  3. Para cada una obtiene un token de location (POST /oauth/locationToken) y la registra de forma independiente:
 *     un fallo en una location no detiene a las demás.
 */
@Injectable()
export class AgencyInstallationService {
  private readonly logger = new Logger('AgencyInstallation');
  private readonly http: GhlHttp;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(FETCH) fetchFn: FetchFn,
    @Inject(GHL_HTTP_TUNING) tuning: GhlHttpTuning,
    private readonly prisma: PrismaService,
    private readonly tokens: GhlTokenService,
    private readonly cipher: TokenCipher,
    private readonly registration: LocationRegistrationService,
  ) {
    this.http = new GhlHttp({ ...tuning, apiBase: config.ghl.apiBase, apiVersion: config.ghl.apiVersion, fetchFn });
  }

  async install(data: TokenResponse, correlationId: string): Promise<AgencyInstallResult> {
    const agencyId = data.companyId;
    if (!agencyId) return { outcome: 'agency_lookup_failed' };
    if (!this.config.ghl.appId) return { outcome: 'agency_app_id_missing' };
    const scopes = data.scope.split(/[\s,]+/).filter(Boolean);
    if (!AGENCY_SCOPES.every(s => scopes.includes(s))) return { outcome: 'agency_missing_scopes' };

    const grant = await this.prisma.$transaction(async tx => {
      const g = await tx.ghlAgencyGrant.upsert({ where: { ghlCompanyId: agencyId }, create: { ghlCompanyId: agencyId, grantedScopes: scopes }, update: { grantedScopes: scopes, status: 'active', lastErrorCode: null } });
      return tx.ghlAgencyGrant.update({
        where: { id: g.id },
        data: { encryptedAccessToken: this.cipher.encrypt(data.access_token, g.id), encryptedRefreshToken: this.cipher.encrypt(data.refresh_token, g.id), expiresAt: new Date(Date.now() + data.expires_in * 1000), tokenVersion: { increment: 1 } },
      });
    });

    let locations: { id: string; name: string | null }[];
    try {
      locations = await this.installedLocations(data.access_token, agencyId);
    } catch (e) {
      this.logger.warn({ msg: 'agency_installed_locations_failed', code: e instanceof GhlApiError ? e.code : 'UNKNOWN', correlationId });
      await this.prisma.ghlAgencyGrant.update({ where: { id: grant.id }, data: { lastErrorCode: e instanceof GhlApiError ? e.code : 'UNKNOWN' } });
      return { outcome: 'agency_lookup_failed' };
    }

    let registered = 0;
    let failed = 0;
    let conflicts = 0;
    for (const loc of locations) {
      try {
        const token = await this.tokens.requestLocationToken(data.access_token, agencyId, loc.id);
        const r = await this.registration.register({
          locationId: loc.id,
          agencyId,
          scopes: token.scope.split(/[\s,]+/).filter(Boolean),
          accessToken: token.access_token,
          refreshToken: null,
          expiresIn: token.expires_in,
          source: 'agency',
          agencyGrantId: grant.id,
          verifiedName: loc.name,
          trigger: 'agency_install',
          correlationId,
        });
        if (r.outcome === 'registered') registered++;
        else conflicts++;
      } catch (e) {
        failed++;
        this.logger.warn({ msg: 'agency_location_install_failed', locationId: loc.id, code: e instanceof GhlApiError ? e.code : 'UNKNOWN', correlationId });
      }
    }
    this.logger.log({ msg: 'agency_install_processed', registered, failed, conflicts, total: locations.length, correlationId });
    return { outcome: 'agency_installed', registered, failed, conflicts };
  }

  /** GET /oauth/installedLocations (Version 2021-07-28, token de agencia, scope oauth.readonly), paginado por skip/limit. */
  private async installedLocations(agencyToken: string, agencyId: string) {
    const out: { id: string; name: string | null }[] = [];
    for (let skip = 0; skip < MAX_AGENCY_LOCATIONS; skip += PAGE_SIZE) {
      const qs = new URLSearchParams({ companyId: agencyId, appId: this.config.ghl.appId, isInstalled: 'true', skip: String(skip), limit: String(PAGE_SIZE) });
      const raw = await this.http.request({ method: 'GET', path: `/oauth/installedLocations?${qs}`, retry: 'safe' }, async () => ({ token: agencyToken, version: 0 }));
      const parsed = installedSchema.safeParse(raw);
      if (!parsed.success) throw new GhlApiError('GHL_INVALID_RESPONSE');
      // Defensa: sólo locations marcadas como instaladas (si GHL informa el campo).
      for (const l of parsed.data.locations) if (l.isInstalled !== false) out.push({ id: l._id, name: l.name?.trim() || null });
      if (parsed.data.locations.length < PAGE_SIZE || (parsed.data.count !== undefined && skip + PAGE_SIZE >= parsed.data.count)) break;
    }
    return out;
  }
}
