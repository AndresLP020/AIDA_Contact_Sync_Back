import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { PrismaService } from '../../prisma/prisma.service';
import { GhlHttp } from '../contacts/ghl-http';
import { GHL_HTTP_TUNING, type GhlHttpTuning } from '../contacts/http-ghl-contacts.client';
import { ProvisioningService, type ProvisioningTrigger } from '../provisioning/provisioning.service';
import { FETCH, type FetchFn } from '../tokens/ghl-token.service';
import { TokenCipher } from '../tokens/token-cipher.service';

/**
 * Autorización ya VERIFICADA por GHL (resultado de intercambiar un code o de /oauth/locationToken).
 * `agencyId` es el companyId de AGENCIA devuelto por GHL; no es el id interno de Company.
 */
export type VerifiedLocationGrant = {
  locationId: string;
  agencyId: string | null;
  scopes: string[];
  accessToken: string;
  /** Nulo para tokens emitidos desde un token de agencia. */
  refreshToken: string | null;
  expiresIn: number;
  source: 'app_oauth' | 'marketplace' | 'agency';
  agencyGrantId?: string | null;
  /** Nombre obtenido de una fuente verificada de GHL; nunca se inventa. */
  verifiedName?: string | null;
  /** Sólo flujo iniciado desde Contact Sync: empresa y usuario ligados al state validado. */
  bind?: { companyId: string; userId: string };
  trigger: ProvisioningTrigger;
  correlationId: string;
};

export type RegistrationOutcome =
  | { outcome: 'registered'; companyId: string; installationId: string; companyCreated: boolean; reinstalled: boolean; executionId: string | null }
  | { outcome: 'location_mismatch' | 'location_already_linked' | 'agency_conflict' };

const locationSchema = z.object({ location: z.object({ id: z.string(), name: z.string().min(1).max(200).optional() }) });

/**
 * Registro automático de la location: busca por locationId, reutiliza o crea su Company local, guarda instalación
 * y credenciales cifradas y encola la configuración, TODO en una sola transacción (sin llamadas HTTP dentro).
 */
@Injectable()
export class LocationRegistrationService {
  private readonly logger = new Logger('LocationRegistration');
  private readonly http: GhlHttp;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(FETCH) fetchFn: FetchFn,
    @Inject(GHL_HTTP_TUNING) tuning: GhlHttpTuning,
    private readonly prisma: PrismaService,
    private readonly cipher: TokenCipher,
    private readonly audit: AuditService,
    private readonly provisioning: ProvisioningService,
  ) {
    this.http = new GhlHttp({ ...tuning, maxAttempts: 2, apiBase: config.ghl.apiBase, apiVersion: config.ghl.apiVersion, fetchFn });
  }

  /**
   * Nombre de la location con GET /locations/{locationId} (scope locations.readonly). Sólo se consulta si el scope
   * fue concedido y la empresa local aún no tiene nombre. Cualquier fallo deja el nombre en null (no se inventa).
   */
  async fetchVerifiedName(grant: Pick<VerifiedLocationGrant, 'locationId' | 'accessToken' | 'scopes'>): Promise<string | null> {
    if (!grant.scopes.includes('locations.readonly')) return null;
    const existing = await this.prisma.company.findUnique({ where: { ghlLocationId: grant.locationId }, select: { name: true } });
    if (existing?.name) return null;
    try {
      const raw = await this.http.request({ method: 'GET', path: `/locations/${encodeURIComponent(grant.locationId)}`, retry: 'safe' }, async () => ({ token: grant.accessToken, version: 0 }));
      const parsed = locationSchema.safeParse(raw);
      return parsed.success && parsed.data.location.id === grant.locationId ? (parsed.data.location.name?.trim() || null) : null;
    } catch {
      return null;
    }
  }

  async register(grant: VerifiedLocationGrant): Promise<RegistrationOutcome> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.prisma.$transaction(tx => this.registerInTx(tx, grant), { timeout: 20_000, maxWait: 20_000 });
      } catch (e) {
        // Carrera de inserción (dos callbacks/instalaciones simultáneas de la misma location): se reintenta una vez
        // y la segunda pasada encuentra y reutiliza el registro creado por la primera.
        if (attempt < 3 && e instanceof Prisma.PrismaClientKnownRequestError && (e.code === 'P2002' || e.code === 'P2034')) continue;
        throw e;
      }
    }
  }

  private async registerInTx(tx: Prisma.TransactionClient, g: VerifiedLocationGrant): Promise<RegistrationOutcome> {
    let company = await tx.company.findUnique({ where: { ghlLocationId: g.locationId } });
    let companyCreated = false;

    if (g.bind) {
      const bound = await tx.company.findUniqueOrThrow({ where: { id: g.bind.companyId } });
      if (bound.ghlLocationId && bound.ghlLocationId !== g.locationId) return { outcome: 'location_mismatch' };
      // No se fusionan empresas: si la location ya tiene otra representación local, no se reasigna en silencio.
      if (company && company.id !== bound.id) return { outcome: 'location_already_linked' };
      if (!company) company = await tx.company.update({ where: { id: bound.id }, data: { ghlLocationId: g.locationId } });
    } else if (!company) {
      // Representación local de una location autorizada. Sin miembros: crear el registro NO concede acceso a nadie.
      company = await tx.company.create({ data: { name: g.verifiedName ?? null, ghlLocationId: g.locationId } });
      companyCreated = true;
    }
    if (!company.name && g.verifiedName) company = await tx.company.update({ where: { id: company.id }, data: { name: g.verifiedName } });

    const byLocation = await tx.ghlInstallation.findUnique({ where: { ghlLocationId: g.locationId } });
    const byCompany = await tx.ghlInstallation.findUnique({ where: { companyId: company.id } });
    if (byLocation && byLocation.companyId !== company.id) return { outcome: 'location_already_linked' };
    if (byCompany && byCompany.ghlLocationId !== g.locationId) return { outcome: 'location_mismatch' };
    const existing = byLocation ?? byCompany;

    // Una location ligada a otra agencia no se reasigna: se registra el conflicto y se detiene.
    if (existing?.ghlCompanyId && g.agencyId && existing.ghlCompanyId !== g.agencyId) {
      await this.audit.record({ companyId: company.id, actorId: g.bind?.userId ?? null, action: 'ghl.install_conflict', resourceType: 'GhlInstallation', resourceId: existing.id, correlationId: g.correlationId, metadata: { reason: 'agency_mismatch', source: g.source } }, tx);
      this.logger.warn({ msg: 'ghl_install_agency_conflict', installationId: existing.id, correlationId: g.correlationId });
      return { outcome: 'agency_conflict' };
    }

    const reinstalled = existing?.installationStatus === 'revoked';
    const now = new Date();
    const common = {
      ghlLocationId: g.locationId,
      ghlCompanyId: g.agencyId ?? existing?.ghlCompanyId ?? null,
      installationStatus: 'active' as const,
      grantedScopes: g.scopes,
      lastCommunicationAt: now,
      lastErrorCode: null,
      installSource: g.source,
      agencyGrantId: g.agencyGrantId ?? null,
    };
    const installation = existing
      ? await tx.ghlInstallation.update({
          where: { id: existing.id },
          // Reinstalación tras una baja: nueva generación (los trabajos anteriores quedan bloqueados).
          data: { ...common, revokedAt: null, ...(reinstalled ? { generation: { increment: 1 }, installedAt: now } : existing.installedAt ? {} : { installedAt: now }) },
        })
      : await tx.ghlInstallation.create({ data: { ...common, companyId: company.id, installedAt: now } });

    const encrypted = {
      encryptedAccessToken: this.cipher.encrypt(g.accessToken, installation.id),
      encryptedRefreshToken: g.refreshToken ? this.cipher.encrypt(g.refreshToken, installation.id) : null,
      expiresAt: new Date(Date.now() + g.expiresIn * 1000),
    };
    await tx.oAuthCredential.upsert({ where: { installationId: installation.id }, create: { installationId: installation.id, ...encrypted }, update: { ...encrypted, tokenVersion: { increment: 1 } } });

    const queued = await this.provisioning.enqueueInTx(tx, { installationId: installation.id, trigger: g.trigger, correlationId: g.correlationId, requestedById: g.bind?.userId ?? null });
    // Eventos INSTALL que llegaron antes del token: convergen en esta misma ejecución.
    await tx.ghlWebhookEvent.updateMany({ where: { locationId: g.locationId, type: 'INSTALL', processingStatus: 'pending' }, data: { processingStatus: 'processed', processedAt: now } });

    await this.audit.record(
      {
        companyId: company.id,
        actorId: g.bind?.userId ?? null,
        action: g.bind ? 'ghl.connected' : 'ghl.installed',
        resourceType: 'GhlInstallation',
        resourceId: installation.id,
        correlationId: g.correlationId,
        metadata: { scopes: g.scopes, source: g.source, companyCreated, reinstalled, generation: installation.generation, provisioningExecutionId: queued.executionId },
      },
      tx,
    );
    return { outcome: 'registered', companyId: company.id, installationId: installation.id, companyCreated, reinstalled, executionId: queued.executionId };
  }
}
