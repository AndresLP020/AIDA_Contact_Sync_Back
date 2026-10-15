import { Inject, Injectable, Logger } from '@nestjs/common';
import { type ConfigurationStatus, Prisma, type ProvisionedResource, type ProvisioningExecution, type ProvisioningStepStatus } from '@prisma/client';
import { AuditService } from '../../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { PrismaService } from '../../prisma/prisma.service';
import type { GhlConnection } from '../contacts/ghl-contacts.client';
import { GhlApiError } from '../contacts/ghl-errors';
import { GhlProvisioningClient, isAmbiguousCreateError } from './ghl-provisioning.client';
import { type CustomFieldSpec, type CustomValueSpec, missingProvisioningScopes, PROVISIONING_MANIFEST, RESOURCE_KEYS, type ResourceSpec } from './provisioning.manifest';
import { ACTION_CODES, decideField, decideValue, isCompatibleField, retryDelayMs, sameName, TRANSIENT_CODES } from './reconcile';

/** El trabajador perdió el lease (otro lo reclamó, o la ejecución fue cancelada): debe detenerse sin escribir. */
export class LeaseLostError extends Error {}
/** La instalación ya no está activa o cambió de generación: no se permiten más operaciones remotas. */
class InstallationInactiveError extends Error {}
/** Creación con resultado ambiguo (timeout/5xx): NO se repite de inmediato; se reconcilia en el siguiente intento. */
class AmbiguousCreateError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Creaciones ambiguas sin confirmar a partir de las cuales se exige intervención en vez de volver a crear. */
export const MAX_AMBIGUOUS_CREATES = 2;
const AMBIGUOUS_MIN_DELAY_MS = 30_000;

type Ctx = { exec: ProvisioningExecution; lease: number; conn: GhlConnection };
type StepResult = { status: 'succeeded' | 'requires_action'; outcome: string; code?: string; remoteId?: string | null };

const errorCode = (e: unknown) => {
  if (e instanceof GhlApiError) return e.code;
  if (e instanceof AmbiguousCreateError) return e.code;
  if (e instanceof Prisma.PrismaClientKnownRequestError || e instanceof Prisma.PrismaClientUnknownRequestError) return 'DB_WRITE_FAILED';
  return 'INTERNAL_ERROR';
};

/**
 * Ejecuta UNA ejecución de configuración ya reclamada (lease). Reglas:
 *  - Nunca mantiene transacciones abiertas durante llamadas HTTP a GHL.
 *  - Toda escritura local va "cercada" por (status=running, leaseToken): un trabajador obsoleto no puede escribir.
 *  - Antes de cada operación remota comprueba que la instalación siga activa y en la misma generación.
 *  - Antes de un POST registra la intención (status=creating) para poder reconciliar si se pierde la respuesta
 *    o falla el guardado del ID remoto.
 */
@Injectable()
export class ProvisioningRunner {
  private readonly logger = new Logger('Provisioning');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly client: GhlProvisioningClient,
    private readonly audit: AuditService,
  ) {}

  async run(executionId: string, lease: number): Promise<ConfigurationStatus | 'lost'> {
    const exec = await this.prisma.provisioningExecution.findUnique({ where: { id: executionId } });
    if (!exec || exec.status !== 'running' || exec.leaseToken !== lease) return 'lost';
    const ctx: Ctx = { exec, lease, conn: { companyId: exec.companyId, locationId: exec.ghlLocationId, installationId: exec.installationId } };
    try {
      const installation = await this.prisma.ghlInstallation.findUnique({ where: { id: exec.installationId } });
      if (!installation || installation.installationStatus !== 'active' || installation.generation !== exec.installationGeneration || installation.ghlLocationId !== exec.ghlLocationId) {
        return await this.finish(ctx, 'cancelled', 'INSTALLATION_INACTIVE');
      }
      if (exec.attempts > exec.maxAttempts) return await this.finish(ctx, 'requires_action', 'MAX_ATTEMPTS_EXCEEDED');

      const missing = missingProvisioningScopes(installation.grantedScopes);
      if (missing.length) {
        for (const spec of PROVISIONING_MANIFEST) await this.updateStep(ctx, spec.resourceKey, { status: 'requires_action', outcome: 'missing_scopes', errorCode: 'MISSING_SCOPES', finishedAt: new Date() });
        return await this.finish(ctx, 'requires_action', 'MISSING_SCOPES', missing);
      }

      const results = new Map<string, StepResult['status']>();
      const ordered = PROVISIONING_MANIFEST.filter(s => s.resourceKey !== RESOURCE_KEYS.configurationStatus);
      for (const spec of ordered) results.set(spec.resourceKey, await this.runStep(ctx, spec));
      // El valor informativo refleja el resultado de los demás pasos; si su propia escritura falla, no habrá "ready".
      const provisional = [...results.values()].every(s => s === 'succeeded') ? 'ready' : 'requires_action';
      const statusSpec = PROVISIONING_MANIFEST.find(s => s.resourceKey === RESOURCE_KEYS.configurationStatus)!;
      results.set(statusSpec.resourceKey, await this.runStep(ctx, statusSpec, provisional));

      const ready = PROVISIONING_MANIFEST.every(s => !s.required || results.get(s.resourceKey) === 'succeeded');
      return await this.finish(ctx, ready ? 'ready' : 'requires_action', ready ? null : 'RESOURCE_REQUIRES_ACTION');
    } catch (e) {
      return this.handleFailure(ctx, e);
    }
  }

  // ───────────────────────────── Pasos ─────────────────────────────

  private async runStep(ctx: Ctx, spec: ResourceSpec, dynamicValue?: string): Promise<StepResult['status']> {
    await this.updateStep(ctx, spec.resourceKey, { status: 'running', attempts: { increment: 1 }, startedAt: new Date(), finishedAt: null, errorCode: null });
    try {
      const res = await this.ensureResourceRow(ctx, spec);
      const r = spec.resourceType === 'custom_field' ? await this.reconcileField(ctx, spec, res) : await this.reconcileValue(ctx, spec, res, dynamicValue);
      await this.updateStep(ctx, spec.resourceKey, { status: r.status, outcome: r.outcome, errorCode: r.code ?? null, remoteId: r.remoteId ?? null, finishedAt: new Date() });
      return r.status;
    } catch (e) {
      if (e instanceof LeaseLostError || e instanceof InstallationInactiveError) throw e;
      const ambiguous = e instanceof AmbiguousCreateError;
      await this.updateStep(ctx, spec.resourceKey, { status: ambiguous ? 'ambiguous' : 'failed', outcome: ambiguous ? 'pending_reconciliation' : null, errorCode: errorCode(e), finishedAt: new Date() }).catch(err => {
        if (err instanceof LeaseLostError) throw err;
      });
      throw e;
    }
  }

  private async reconcileField(ctx: Ctx, spec: CustomFieldSpec, res: ProvisionedResource): Promise<StepResult> {
    let recreated = false;
    // 1-2. ID registrado: se verifica existencia y compatibilidad. Un recurso renombrado por el cliente se conserva.
    if (res.remoteId) {
      await this.assertActive(ctx);
      try {
        const remote = await this.client.getCustomField(ctx.conn, res.remoteId);
        if (!isCompatibleField(spec, remote)) {
          await this.saveResource(ctx, spec, { status: 'conflict', remoteName: remote.name });
          return { status: 'requires_action', outcome: 'conflict_incompatible_type', code: 'INCOMPATIBLE_TYPE', remoteId: remote.id };
        }
        await this.saveResource(ctx, spec, { status: 'active', remoteName: remote.name, remoteKey: remote.fieldKey ?? res.remoteKey, lastVerifiedAt: new Date() });
        return { status: 'succeeded', outcome: sameName(remote.name, spec.displayName) ? 'verified' : 'verified_renamed', remoteId: remote.id };
      } catch (e) {
        if (!(e instanceof GhlApiError && e.code === 'GHL_NOT_FOUND')) throw e;
        // Se eliminó en GHL: se olvida el ID y se trata como faltante.
        await this.saveResource(ctx, spec, { remoteId: null, remoteKey: null, remoteName: null, origin: null, status: 'missing' });
        recreated = true;
      }
    }
    // 3-5. Sin ID registrado: consultar recursos remotos y buscar coincidencias inequívocas.
    await this.assertActive(ctx);
    const decision = decideField(spec, await this.client.listCustomFields(ctx.conn));
    const hadIntent = res.status === 'creating' || res.status === 'pending_reconciliation';
    if (decision.action === 'conflict') {
      await this.saveResource(ctx, spec, { status: 'conflict' });
      return { status: 'requires_action', outcome: decision.code === 'AMBIGUOUS_MATCH' ? 'ambiguous_match' : 'conflict_incompatible_type', code: decision.code };
    }
    if (decision.action === 'adopt') {
      const r = decision.remote;
      // Con intención previa registrada (POST cuya respuesta se perdió o cuyo ID no se pudo guardar), el recurso es nuestro.
      await this.saveResource(ctx, spec, { remoteId: r.id, remoteKey: r.fieldKey, remoteName: r.name, origin: hadIntent ? 'created' : 'adopted', status: 'active', ambiguousCount: 0, lastVerifiedAt: new Date() });
      return { status: 'succeeded', outcome: hadIntent ? 'reconciled_created' : 'adopted', remoteId: r.id };
    }
    // 6. Confirmado que falta: crear.
    if (res.ambiguousCount >= MAX_AMBIGUOUS_CREATES) {
      await this.saveResource(ctx, spec, { status: 'pending_reconciliation' });
      return { status: 'requires_action', outcome: 'ambiguous_unresolved', code: 'AMBIGUOUS_UNRESOLVED' };
    }
    const created = await this.createWithIntent(ctx, spec, () => this.client.createCustomField(ctx.conn, { name: spec.displayName, dataType: spec.dataType, model: spec.model, ...(spec.placeholder ? { placeholder: spec.placeholder } : {}) }));
    // 7. Guardar el ID devuelto.
    await this.saveResource(ctx, spec, { remoteId: created.id, remoteKey: created.fieldKey, remoteName: created.name, origin: 'created', status: 'active', ambiguousCount: 0, lastVerifiedAt: new Date() });
    return { status: 'succeeded', outcome: recreated ? 'recreated' : 'created', remoteId: created.id };
  }

  private async reconcileValue(ctx: Ctx, spec: CustomValueSpec, res: ProvisionedResource, dynamicValue?: string): Promise<StepResult> {
    const desired = spec.value === 'dynamic:configuration_status' ? (dynamicValue ?? 'requires_action') : spec.value;
    let recreated = false;
    if (res.remoteId) {
      await this.assertActive(ctx);
      try {
        const remote = await this.client.getCustomValue(ctx.conn, res.remoteId);
        if (res.origin !== 'created') {
          // Adoptado: no se sobrescribe un valor que la app no creó.
          await this.saveResource(ctx, spec, { status: 'active', remoteName: remote.name, remoteKey: remote.fieldKey ?? res.remoteKey, lastVerifiedAt: new Date() });
          return { status: 'succeeded', outcome: 'verified_unmanaged', remoteId: remote.id };
        }
        let outcome = 'verified';
        if (remote.value !== desired) {
          await this.assertActive(ctx);
          // Se conserva el nombre remoto (si el cliente lo renombró, no se revierte).
          await this.client.updateCustomValue(ctx.conn, remote.id, { name: remote.name, value: desired });
          outcome = 'updated';
        }
        await this.saveResource(ctx, spec, { status: 'active', remoteName: remote.name, remoteKey: remote.fieldKey ?? res.remoteKey, lastVerifiedAt: new Date() });
        return { status: 'succeeded', outcome, remoteId: remote.id };
      } catch (e) {
        if (!(e instanceof GhlApiError && e.code === 'GHL_NOT_FOUND')) throw e;
        await this.saveResource(ctx, spec, { remoteId: null, remoteKey: null, remoteName: null, origin: null, status: 'missing' });
        recreated = true;
      }
    }
    await this.assertActive(ctx);
    const decision = decideValue(spec, await this.client.listCustomValues(ctx.conn));
    const hadIntent = res.status === 'creating' || res.status === 'pending_reconciliation';
    if (decision.action === 'conflict') {
      await this.saveResource(ctx, spec, { status: 'conflict' });
      return { status: 'requires_action', outcome: 'ambiguous_match', code: decision.code };
    }
    if (decision.action === 'adopt') {
      const r = decision.remote;
      if (hadIntent) {
        if (r.value !== desired) {
          await this.assertActive(ctx);
          await this.client.updateCustomValue(ctx.conn, r.id, { name: r.name, value: desired });
        }
        await this.saveResource(ctx, spec, { remoteId: r.id, remoteKey: r.fieldKey, remoteName: r.name, origin: 'created', status: 'active', ambiguousCount: 0, lastVerifiedAt: new Date() });
        return { status: 'succeeded', outcome: 'reconciled_created', remoteId: r.id };
      }
      await this.saveResource(ctx, spec, { remoteId: r.id, remoteKey: r.fieldKey, remoteName: r.name, origin: 'adopted', status: 'active', lastVerifiedAt: new Date() });
      return { status: 'succeeded', outcome: 'adopted_unmanaged', remoteId: r.id };
    }
    if (res.ambiguousCount >= MAX_AMBIGUOUS_CREATES) {
      await this.saveResource(ctx, spec, { status: 'pending_reconciliation' });
      return { status: 'requires_action', outcome: 'ambiguous_unresolved', code: 'AMBIGUOUS_UNRESOLVED' };
    }
    const created = await this.createWithIntent(ctx, spec, () => this.client.createCustomValue(ctx.conn, { name: spec.displayName, value: desired }));
    await this.saveResource(ctx, spec, { remoteId: created.id, remoteKey: created.fieldKey, remoteName: created.name, origin: 'created', status: 'active', ambiguousCount: 0, lastVerifiedAt: new Date() });
    return { status: 'succeeded', outcome: recreated ? 'recreated' : 'created', remoteId: created.id };
  }

  /** Registra la intención antes del POST; un resultado ambiguo deja el recurso pendiente de reconciliación. */
  private async createWithIntent<T>(ctx: Ctx, spec: ResourceSpec, create: () => Promise<T>): Promise<T> {
    await this.assertActive(ctx);
    await this.saveResource(ctx, spec, { status: 'creating' });
    try {
      return await create();
    } catch (e) {
      if (isAmbiguousCreateError(e)) {
        this.logger.warn({ msg: 'provisioning_ambiguous_create', executionId: ctx.exec.id, resourceKey: spec.resourceKey, code: errorCode(e) });
        await this.saveResource(ctx, spec, { status: 'pending_reconciliation', ambiguousCount: { increment: 1 } });
        throw new AmbiguousCreateError(errorCode(e));
      }
      // Error definitivo (p. ej. 422/403): GHL no creó el recurso.
      await this.saveResource(ctx, spec, { status: 'missing' });
      throw e;
    }
  }

  // ───────────────────────────── Persistencia cercada ─────────────────────────────

  /** Renueva el lease y comprueba que esta ejecución siga siendo de este trabajador. */
  private async guard(ctx: Ctx, tx: Prisma.TransactionClient = this.prisma) {
    const r = await tx.provisioningExecution.updateMany({
      where: { id: ctx.exec.id, leaseToken: ctx.lease, status: 'running' },
      data: { lockedUntil: new Date(Date.now() + this.config.provisioning.leaseMs) },
    });
    if (r.count !== 1) throw new LeaseLostError('lease_lost');
  }

  /** Comprobación previa a cada operación remota. */
  private async assertActive(ctx: Ctx) {
    await this.guard(ctx);
    const inst = await this.prisma.ghlInstallation.findUnique({ where: { id: ctx.exec.installationId }, select: { installationStatus: true, generation: true } });
    if (!inst || inst.installationStatus !== 'active' || inst.generation !== ctx.exec.installationGeneration) throw new InstallationInactiveError('installation_inactive');
  }

  private updateStep(ctx: Ctx, resourceKey: string, data: Prisma.ProvisioningStepUpdateManyMutationInput & { status?: ProvisioningStepStatus }) {
    return this.prisma.$transaction(async tx => {
      await this.guard(ctx, tx);
      await tx.provisioningStep.updateMany({ where: { executionId: ctx.exec.id, resourceKey }, data });
    });
  }

  private async ensureResourceRow(ctx: Ctx, spec: ResourceSpec) {
    return this.prisma.$transaction(async tx => {
      await this.guard(ctx, tx);
      return tx.provisionedResource.upsert({
        where: { ghlLocationId_resourceKey: { ghlLocationId: ctx.exec.ghlLocationId, resourceKey: spec.resourceKey } },
        create: { companyId: ctx.exec.companyId, ghlLocationId: ctx.exec.ghlLocationId, resourceKey: spec.resourceKey, resourceType: spec.resourceType, manifestVersion: spec.manifestVersion, managementPolicy: spec.policy },
        update: {},
      });
    });
  }

  /** Punto único de escritura de ProvisionedResource (las pruebas lo sustituyen para simular fallos de guardado). */
  async saveResource(ctx: Ctx, spec: ResourceSpec, data: Prisma.ProvisionedResourceUpdateInput) {
    await this.prisma.$transaction(async tx => {
      await this.guard(ctx, tx);
      await tx.provisionedResource.update({
        where: { ghlLocationId_resourceKey: { ghlLocationId: ctx.exec.ghlLocationId, resourceKey: spec.resourceKey } },
        data: { ...data, manifestVersion: spec.manifestVersion, managementPolicy: spec.policy },
      });
    });
  }

  // ───────────────────────────── Finalización ─────────────────────────────

  private async handleFailure(ctx: Ctx, e: unknown): Promise<ConfigurationStatus | 'lost'> {
    if (e instanceof LeaseLostError) {
      // Cancelada (baja) o reclamada por otro trabajador tras vencer el lease. Una operación remota en curso pudo
      // completarse: queda registrada como intención y se reconciliará si la location se reinstala.
      this.logger.warn({ msg: 'provisioning_lease_lost', executionId: ctx.exec.id });
      return 'lost';
    }
    if (e instanceof InstallationInactiveError) return this.finish(ctx, 'cancelled', 'INSTALLATION_INACTIVE').catch(() => 'lost' as const);
    const code = errorCode(e);
    this.logger.warn({ msg: 'provisioning_attempt_failed', executionId: ctx.exec.id, attempt: ctx.exec.attempts, code });
    try {
      if (ACTION_CODES.has(code)) return await this.finish(ctx, 'requires_action', code);
      // Transitorio, ambiguo o inesperado: se reprograma con backoff + jitter (respetando Retry-After).
      if (ctx.exec.attempts >= ctx.exec.maxAttempts) return await this.finish(ctx, 'requires_action', code);
      if (!TRANSIENT_CODES.has(code)) this.logger.error({ msg: 'provisioning_unexpected_error', executionId: ctx.exec.id, code, error: e instanceof Error ? e.name : 'unknown' });
      const retryAfterMs = e instanceof GhlApiError && e.retryAfterSeconds ? e.retryAfterSeconds * 1000 : 0;
      const minimum = e instanceof AmbiguousCreateError ? Math.max(AMBIGUOUS_MIN_DELAY_MS, retryAfterMs) : retryAfterMs;
      const delay = retryDelayMs(ctx.exec.attempts, Math.random, minimum);
      await this.prisma.$transaction(async tx => {
        await this.guard(ctx, tx);
        await tx.provisioningExecution.update({ where: { id: ctx.exec.id }, data: { status: 'pending', nextAttemptAt: new Date(Date.now() + delay), lockedBy: null, lockedUntil: null, lastErrorCode: code } });
        await tx.ghlInstallation.updateMany({ where: { id: ctx.exec.installationId, generation: ctx.exec.installationGeneration }, data: { configurationStatus: 'pending' } });
      });
      return 'pending';
    } catch (err) {
      if (err instanceof LeaseLostError) return 'lost';
      throw err;
    }
  }

  private async finish(ctx: Ctx, status: ConfigurationStatus, code: string | null, missingScopes: string[] = []): Promise<ConfigurationStatus> {
    await this.prisma.$transaction(async tx => {
      await this.guard(ctx, tx);
      await tx.provisioningExecution.update({ where: { id: ctx.exec.id }, data: { status, finishedAt: new Date(), lockedBy: null, lockedUntil: null, lastErrorCode: code, missingScopes } });
      if (status === 'cancelled') await tx.provisioningStep.updateMany({ where: { executionId: ctx.exec.id, status: { in: ['pending', 'running'] } }, data: { status: 'cancelled' } });
      // El estado de la instalación sólo lo actualiza una ejecución de la generación vigente.
      await tx.ghlInstallation.updateMany({ where: { id: ctx.exec.installationId, generation: ctx.exec.installationGeneration, installationStatus: 'active' }, data: { configurationStatus: status } });
      await this.audit.record({ companyId: ctx.exec.companyId, actorId: null, action: `ghl.provisioning.${status}`, resourceType: 'ProvisioningExecution', resourceId: ctx.exec.id, correlationId: ctx.exec.correlationId, metadata: { errorCode: code, missingScopes, attempts: ctx.exec.attempts, manifestVersion: ctx.exec.manifestVersion } }, tx);
    });
    this.logger.log({ msg: 'provisioning_finished', executionId: ctx.exec.id, status, code });
    return status;
  }
}
