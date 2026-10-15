import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { badRequest, conflict } from '../../common/errors';
import type { Principal } from '../../common/request-context';
import { PrismaService } from '../../prisma/prisma.service';
import { MANIFEST_VERSION, missingProvisioningScopes, PROVISIONING_MANIFEST } from './provisioning.manifest';

export type ProvisioningTrigger = 'oauth_callback' | 'marketplace_install' | 'agency_install' | 'webhook_install' | 'user_retry';

type EnqueueInput = {
  installationId: string;
  trigger: ProvisioningTrigger;
  correlationId: string;
  requestedById?: string | null;
  /** webhook_install: no crea otra ejecución si ya hubo una para la generación vigente. */
  onlyIfNoneForGeneration?: boolean;
};

/**
 * Punto ÚNICO de entrada de la configuración automática: callback OAuth, instalación desde Marketplace,
 * webhook INSTALL y reintento manual convergen aquí. Es idempotente: con una ejecución activa de la misma
 * generación la reutiliza; nunca crea dos activas (además lo impide un índice único parcial).
 */
@Injectable()
export class ProvisioningService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Debe ejecutarse dentro de la transacción que registra la instalación (persistencia coherente). */
  async enqueueInTx(tx: Prisma.TransactionClient, input: EnqueueInput): Promise<{ executionId: string | null; created: boolean }> {
    // Serializa por instalación: dos solicitudes simultáneas no pueden crear dos ejecuciones activas.
    await tx.$queryRaw`SELECT id FROM "GhlInstallation" WHERE id = ${input.installationId}::uuid FOR UPDATE`;
    const installation = await tx.ghlInstallation.findUniqueOrThrow({ where: { id: input.installationId } });
    if (installation.installationStatus !== 'active') return { executionId: null, created: false };

    const active = await tx.provisioningExecution.findFirst({ where: { installationId: installation.id, status: { in: ['pending', 'running'] } } });
    if (active && active.installationGeneration === installation.generation) return { executionId: active.id, created: false };
    if (active) {
      // Trabajo de una instalación anterior (baja + reinstalación): se cancela y queda bloqueado por generación.
      await tx.provisioningExecution.update({ where: { id: active.id }, data: { status: 'cancelled', finishedAt: new Date(), lastErrorCode: 'STALE_GENERATION', lockedUntil: null } });
    }
    if (input.onlyIfNoneForGeneration) {
      const previous = await tx.provisioningExecution.findFirst({ where: { installationId: installation.id, installationGeneration: installation.generation } });
      if (previous) return { executionId: previous.id, created: false };
    }
    const execution = await tx.provisioningExecution.create({
      data: {
        installationId: installation.id,
        installationGeneration: installation.generation,
        companyId: installation.companyId,
        ghlLocationId: installation.ghlLocationId,
        manifestVersion: MANIFEST_VERSION,
        trigger: input.trigger,
        status: 'pending',
        correlationId: input.correlationId,
        requestedById: input.requestedById ?? null,
        steps: { create: PROVISIONING_MANIFEST.map(r => ({ resourceKey: r.resourceKey })) },
      },
    });
    await tx.ghlInstallation.update({ where: { id: installation.id }, data: { configurationStatus: 'pending' } });
    return { executionId: execution.id, created: true };
  }

  /** Reintento manual: la location sale de la sesión (empresa activa), nunca de un parámetro del cliente. */
  async retry(p: Principal, correlationId: string) {
    if (this.config.ghl.mode !== 'real') throw badRequest('GHL_MOCK_MODE', 'La configuración automática sólo aplica con GHL_MODE=real');
    const installation = await this.prisma.ghlInstallation.findUnique({ where: { companyId: p.companyId } });
    if (!installation || installation.installationStatus !== 'active') throw conflict('GHL_NOT_CONNECTED', 'No hay una instalación activa para esta empresa');
    const result = await this.prisma.$transaction(async tx => {
      const r = await this.enqueueInTx(tx, { installationId: installation.id, trigger: 'user_retry', correlationId, requestedById: p.userId });
      await this.audit.record({ companyId: p.companyId, actorId: p.userId, action: 'ghl.provisioning.retry', resourceType: 'ProvisioningExecution', resourceId: r.executionId, correlationId, metadata: { reusedActive: !r.created } }, tx);
      return r;
    });
    return { executionId: result.executionId, alreadyActive: !result.created };
  }

  /** Estado de configuración de la empresa activa. Nunca incluye tokens ni cuerpos de respuesta de GHL. */
  async status(companyId: string) {
    const mode = this.config.ghl.mode;
    const installation = await this.prisma.ghlInstallation.findUnique({
      where: { companyId },
      select: { id: true, ghlLocationId: true, installationStatus: true, configurationStatus: true, grantedScopes: true, generation: true, installSource: true },
    });
    if (mode === 'mock' || !installation) {
      return { mode, simulated: mode === 'mock', manifestVersion: MANIFEST_VERSION, installation: null, configurationStatus: null, execution: null, resources: [], missingScopes: [], canRetry: false };
    }
    const [execution, resources] = await Promise.all([
      this.prisma.provisioningExecution.findFirst({
        where: { installationId: installation.id },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true, trigger: true, attempts: true, maxAttempts: true, nextAttemptAt: true, startedAt: true, finishedAt: true, lastErrorCode: true, missingScopes: true, manifestVersion: true, installationGeneration: true, createdAt: true, updatedAt: true, steps: { select: { resourceKey: true, status: true, outcome: true, errorCode: true, attempts: true, finishedAt: true } } },
      }),
      this.prisma.provisionedResource.findMany({ where: { companyId }, select: { resourceKey: true, resourceType: true, remoteKey: true, remoteName: true, origin: true, status: true, managementPolicy: true, manifestVersion: true, lastVerifiedAt: true } }),
    ]);
    const byKey = new Map(resources.map(r => [r.resourceKey, r]));
    const steps = new Map((execution?.steps ?? []).map(s => [s.resourceKey, s]));
    const missingScopes = execution?.missingScopes.length ? execution.missingScopes : missingProvisioningScopes(installation.grantedScopes);
    return {
      mode,
      simulated: false,
      manifestVersion: MANIFEST_VERSION,
      installation: { locationId: installation.ghlLocationId, status: installation.installationStatus, generation: installation.generation, source: installation.installSource },
      configurationStatus: installation.configurationStatus,
      execution: execution
        ? { id: execution.id, status: execution.status, trigger: execution.trigger, attempts: execution.attempts, maxAttempts: execution.maxAttempts, nextAttemptAt: execution.nextAttemptAt, startedAt: execution.startedAt, finishedAt: execution.finishedAt, lastAttemptAt: execution.updatedAt, lastErrorCode: execution.lastErrorCode, manifestVersion: execution.manifestVersion }
        : null,
      resources: PROVISIONING_MANIFEST.map(spec => {
        const r = byKey.get(spec.resourceKey);
        const s = steps.get(spec.resourceKey);
        return {
          resourceKey: spec.resourceKey,
          resourceType: spec.resourceType,
          displayName: spec.displayName,
          required: spec.required,
          policy: spec.policy,
          origin: r?.origin ?? null,
          status: r?.status ?? 'missing',
          remoteKey: r?.remoteKey ?? null,
          remoteName: r?.remoteName ?? null,
          lastVerifiedAt: r?.lastVerifiedAt ?? null,
          step: s ? { status: s.status, outcome: s.outcome, errorCode: s.errorCode, attempts: s.attempts, finishedAt: s.finishedAt } : null,
        };
      }),
      missingScopes,
      canRetry: installation.installationStatus === 'active',
    };
  }

  /** IDs remotos registrados para una empresa (los usa la sincronización; nunca IDs fijos). */
  async activeResourceIds(companyId: string) {
    const rows = await this.prisma.provisionedResource.findMany({ where: { companyId, status: 'active', remoteId: { not: null } }, select: { resourceKey: true, remoteId: true } });
    return new Map(rows.map(r => [r.resourceKey, r.remoteId as string]));
  }
}
