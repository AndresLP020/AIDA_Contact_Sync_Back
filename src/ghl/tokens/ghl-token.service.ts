import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { PrismaService } from '../../prisma/prisma.service';
import { GhlApiError } from '../contacts/ghl-errors';
import { TokenCipher } from './token-cipher.service';

export const FETCH = Symbol('FETCH');
export type FetchFn = typeof fetch;

/** Respuesta oficial de POST /oauth/token (sólo los campos que usamos; el resto se descarta). */
export const tokenResponseSchema = z.object({
  access_token: z.string().min(10),
  refresh_token: z.string().min(10),
  expires_in: z.coerce.number().int().positive().max(60 * 60 * 24 * 30),
  scope: z.string().optional().default(''),
  userType: z.string().optional(),
  locationId: z.string().optional(),
  companyId: z.string().optional(),
  userId: z.string().optional(),
  isBulkInstallation: z.boolean().optional(),
  approvedLocations: z.array(z.string().max(128)).max(10_000).optional(),
});
export type TokenResponse = z.infer<typeof tokenResponseSchema>;

/** Respuesta oficial de POST /oauth/locationToken (token de location emitido con un token de agencia; sin refresh token). */
export const locationTokenResponseSchema = z.object({
  access_token: z.string().min(10),
  expires_in: z.coerce.number().int().positive().max(60 * 60 * 24 * 30),
  scope: z.string().optional().default(''),
  locationId: z.string().min(1).max(128),
});
export type LocationTokenResponse = z.infer<typeof locationTokenResponseSchema>;

const REFRESH_MARGIN_MS = 2 * 60_000;

export type AccessToken = { token: string; version: number };

@Injectable()
export class GhlTokenService {
  private readonly logger = new Logger('GhlTokens');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(FETCH) private readonly fetchFn: FetchFn,
    private readonly prisma: PrismaService,
    private readonly cipher: TokenCipher,
  ) {}

  /** Intercambia el authorization code. Se ejecuta SÓLO en el backend; el Client Secret nunca llega al navegador. */
  exchangeCode(code: string): Promise<TokenResponse> {
    return this.tokenRequest({ grant_type: 'authorization_code', code });
  }

  /**
   * POST /oauth/locationToken (Version 2021-07-28, token de AGENCIA, scope oauth.write, form companyId+locationId).
   * Verifica que el token emitido corresponda a la location solicitada.
   */
  async requestLocationToken(agencyAccessToken: string, agencyId: string, locationId: string): Promise<LocationTokenResponse> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.config.ghl.apiBase}/oauth/locationToken`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', authorization: `Bearer ${agencyAccessToken}`, Version: this.config.ghl.apiVersion },
        body: new URLSearchParams({ companyId: agencyId, locationId }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new GhlApiError('GHL_NETWORK');
    }
    if (response.status === 401) throw new GhlApiError('GHL_UNAUTHORIZED', 401);
    if (response.status === 403) throw new GhlApiError('GHL_FORBIDDEN', 403);
    if (response.status === 429) throw new GhlApiError('GHL_RATE_LIMITED', 429);
    if (response.status === 400 || response.status === 422) throw new GhlApiError('GHL_VALIDATION', response.status);
    if (!response.ok) throw new GhlApiError('GHL_UNAVAILABLE', response.status);
    const parsed = locationTokenResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new GhlApiError('GHL_INVALID_RESPONSE');
    if (parsed.data.locationId !== locationId) throw new GhlApiError('GHL_FOREIGN_LOCATION');
    return parsed.data;
  }

  /** Token de agencia vigente. Se renueva (user_type=Company) bajo bloqueo de fila: el refresh token es de un solo uso. */
  async getAgencyAccessToken(grantId: string): Promise<string> {
    const grant = await this.prisma.ghlAgencyGrant.findUnique({ where: { id: grantId } });
    if (!grant || grant.status !== 'active' || !grant.encryptedAccessToken || !grant.expiresAt) throw new GhlApiError('GHL_NOT_CONNECTED');
    if (grant.expiresAt.getTime() > Date.now() + REFRESH_MARGIN_MS) return this.cipher.decrypt(grant.encryptedAccessToken, grantId);
    let rejected = false;
    try {
      return await this.prisma.$transaction(
        async tx => {
          await tx.$queryRaw`SELECT id FROM "GhlAgencyGrant" WHERE id = ${grantId}::uuid FOR UPDATE`;
          const fresh = await tx.ghlAgencyGrant.findUniqueOrThrow({ where: { id: grantId } });
          if (fresh.status !== 'active' || !fresh.encryptedRefreshToken) throw new GhlApiError('GHL_NOT_CONNECTED');
          if (fresh.encryptedAccessToken && fresh.expiresAt && fresh.expiresAt.getTime() > Date.now() + REFRESH_MARGIN_MS) return this.cipher.decrypt(fresh.encryptedAccessToken, grantId);
          let data: TokenResponse;
          try {
            data = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: this.cipher.decrypt(fresh.encryptedRefreshToken, grantId) }, 'Company');
          } catch (e) {
            if (e instanceof GhlApiError && e.code === 'GHL_UNAUTHORIZED') rejected = true;
            throw e;
          }
          await tx.ghlAgencyGrant.update({
            where: { id: grantId },
            data: { encryptedAccessToken: this.cipher.encrypt(data.access_token, grantId), encryptedRefreshToken: this.cipher.encrypt(data.refresh_token, grantId), expiresAt: new Date(Date.now() + data.expires_in * 1000), tokenVersion: { increment: 1 }, lastErrorCode: null },
          });
          return data.access_token;
        },
        { timeout: 20_000, maxWait: 20_000 },
      );
    } catch (e) {
      if (rejected) {
        await this.prisma.ghlAgencyGrant.update({ where: { id: grantId }, data: { status: 'error', lastErrorCode: 'GHL_REFRESH_REJECTED' } });
        throw new GhlApiError('GHL_REFRESH_REJECTED', 401);
      }
      throw e;
    }
  }

  /**
   * Devuelve un access token vigente. Si está por expirar (o `staleVersion` indica que GHL lo rechazó),
   * lo renueva bajo un bloqueo de fila (SELECT … FOR UPDATE): las solicitudes concurrentes esperan y reutilizan
   * el token renovado. Es imprescindible porque el refresh token de GHL es de un solo uso.
   */
  async getAccessToken(installationId: string, staleVersion?: number): Promise<AccessToken> {
    const credential = await this.prisma.oAuthCredential.findUnique({ where: { installationId } });
    if (!credential) throw new GhlApiError('GHL_NOT_CONNECTED');
    const needsRefresh = staleVersion !== undefined ? credential.tokenVersion <= staleVersion : credential.expiresAt.getTime() <= Date.now() + REFRESH_MARGIN_MS;
    if (!needsRefresh) return { token: this.cipher.decrypt(credential.encryptedAccessToken, installationId), version: credential.tokenVersion };

    let rejected = false;
    try {
      return await this.prisma.$transaction(
        async tx => {
          await tx.$queryRaw`SELECT id FROM "OAuthCredential" WHERE id = ${credential.id}::uuid FOR UPDATE`;
          const fresh = await tx.oAuthCredential.findUniqueOrThrow({ where: { id: credential.id } });
          const stillNeeds = staleVersion !== undefined ? fresh.tokenVersion <= staleVersion : fresh.expiresAt.getTime() <= Date.now() + REFRESH_MARGIN_MS;
          if (!stillNeeds) return { token: this.cipher.decrypt(fresh.encryptedAccessToken, installationId), version: fresh.tokenVersion };

          // Credencial derivada de un token de agencia: no hay refresh token; se emite un token de location nuevo.
          if (!fresh.encryptedRefreshToken) {
            const installation = await tx.ghlInstallation.findUniqueOrThrow({ where: { id: installationId } });
            if (installation.installationStatus !== 'active' || !installation.agencyGrantId || !installation.ghlCompanyId) throw new GhlApiError('GHL_NOT_CONNECTED');
            const agencyToken = await this.getAgencyAccessToken(installation.agencyGrantId);
            const minted = await this.requestLocationToken(agencyToken, installation.ghlCompanyId, installation.ghlLocationId);
            const updated = await tx.oAuthCredential.update({
              where: { id: fresh.id },
              data: { encryptedAccessToken: this.cipher.encrypt(minted.access_token, installationId), expiresAt: new Date(Date.now() + minted.expires_in * 1000), tokenVersion: { increment: 1 } },
            });
            await tx.ghlInstallation.update({ where: { id: installationId }, data: { lastCommunicationAt: new Date(), lastErrorCode: null } });
            return { token: minted.access_token, version: updated.tokenVersion };
          }
          let data: TokenResponse;
          try {
            data = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: this.cipher.decrypt(fresh.encryptedRefreshToken, installationId) });
          } catch (e) {
            if (e instanceof GhlApiError && e.code === 'GHL_UNAUTHORIZED') rejected = true;
            throw e;
          }
          // El refresh token anterior queda invalidado por GHL: el nuevo debe persistirse en esta misma transacción.
          const updated = await tx.oAuthCredential.update({
            where: { id: fresh.id },
            data: {
              encryptedAccessToken: this.cipher.encrypt(data.access_token, installationId),
              encryptedRefreshToken: this.cipher.encrypt(data.refresh_token, installationId),
              expiresAt: new Date(Date.now() + data.expires_in * 1000),
              tokenVersion: { increment: 1 },
            },
          });
          await tx.ghlInstallation.update({ where: { id: installationId }, data: { lastCommunicationAt: new Date(), lastErrorCode: null } });
          this.logger.log({ msg: 'ghl_token_refreshed', installationId, tokenVersion: updated.tokenVersion });
          return { token: data.access_token, version: updated.tokenVersion };
        },
        { timeout: 20_000, maxWait: 20_000 },
      );
    } catch (e) {
      if (rejected) {
        await this.prisma.ghlInstallation.update({ where: { id: installationId }, data: { installationStatus: 'error', lastErrorCode: 'GHL_REFRESH_REJECTED' } });
        throw new GhlApiError('GHL_REFRESH_REJECTED', 401);
      }
      throw e;
    }
  }

  private async tokenRequest(grant: Record<string, string>, userType: 'Location' | 'Company' = 'Location'): Promise<TokenResponse> {
    const body = new URLSearchParams({
      client_id: this.config.ghl.clientId,
      client_secret: this.config.ghl.clientSecret,
      user_type: userType,
      redirect_uri: this.config.ghl.redirectUri,
      ...grant,
    });
    let response: Response;
    try {
      response = await this.fetchFn(`${this.config.ghl.apiBase}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new GhlApiError('GHL_NETWORK');
    }
    if (response.status === 400 || response.status === 401 || response.status === 403) throw new GhlApiError('GHL_UNAUTHORIZED', response.status);
    if (response.status === 429) throw new GhlApiError('GHL_RATE_LIMITED', 429);
    if (!response.ok) throw new GhlApiError('GHL_UNAVAILABLE', response.status);
    const parsed = tokenResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new GhlApiError('GHL_INVALID_RESPONSE');
    return parsed.data;
  }
}
