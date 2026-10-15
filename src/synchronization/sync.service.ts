import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { type Contact, JobStatus, Prisma, type SyncDirection } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { conflict, forbidden, notFound } from '../common/errors';
import { paginated } from '../common/pagination';
import { hasRole, type Principal } from '../common/request-context';
import { type ContactPatch, diffFields, fieldsHash, pickFields, type RemoteContact, sameValue } from '../ghl/contacts/ghl-contact.types';
import { type GhlConnection, GhlContactsClient } from '../ghl/contacts/ghl-contacts.client';
import { GhlApiError } from '../ghl/contacts/ghl-errors';
import { GhlConnectionService } from '../ghl/ghl-connection.service';
import { RESOURCE_KEYS, type SYNC_STATUS_VALUES } from '../ghl/provisioning/provisioning.manifest';
import { ProvisioningService } from '../ghl/provisioning/provisioning.service';
import { PrismaService } from '../prisma/prisma.service';
import { detectRemoteChange, remoteTouchedSince, signPreview, verifyPreview } from './conflict';
import type { ExportDto, ImportDto, ListJobsQueryDto } from './sync.dto';

export const MAX_FULL_IMPORT = 5000;
const IMPORT_PAGE_SIZE = 100;
const STALE_JOB_MS = 30 * 60_000;

type Outcome = { ok: boolean };
const errorCode = (e: unknown) => (e instanceof GhlApiError ? e.code : 'INTERNAL_ERROR');

@Injectable()
export class SyncService implements OnModuleInit {
  private readonly logger = new Logger('Sync');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly client: GhlContactsClient,
    private readonly connections: GhlConnectionService,
    private readonly audit: AuditService,
    private readonly provisioning: ProvisioningService,
  ) {}

  /** Un proceso caído pudo dejar trabajos en "running": se cierran para no bloquear nuevas sincronizaciones. */
  async onModuleInit() {
    const stale = await this.prisma.syncJob.updateMany({
      where: { status: { in: ['pending', 'running'] }, createdAt: { lt: new Date(Date.now() - STALE_JOB_MS) } },
      data: { status: 'failed', finishedAt: new Date(), errorCode: 'STALE_JOB' },
    });
    if (stale.count) this.logger.warn({ msg: 'stale_sync_jobs_closed', count: stale.count });
  }

  // ───────────────────────────── Importación GHL → PostgreSQL ─────────────────────────────

  async importContacts(p: Principal, dto: ImportDto, idempotencyKey: string | undefined, correlationId: string) {
    if (dto.overwriteLocalChanges && !hasRole(p, 'admin')) throw forbidden('INSUFFICIENT_ROLE', 'Sobrescribir cambios locales requiere rol admin');
    const conn = await this.connections.resolve(p.companyId);
    const started = await this.startJob(p, 'import', idempotencyKey);
    if (started.replayed) return this.getJob(p.companyId, started.jobId);
    const jobId = started.jobId;

    let success = 0;
    let failed = 0;
    let jobError: string | null = null;
    const tally = (o: Outcome) => (o.ok ? success++ : failed++);

    try {
      if (dto.ghlContactIds?.length) {
        for (const id of dto.ghlContactIds) {
          let remote: RemoteContact;
          try {
            remote = await this.client.getContact(conn, id);
          } catch (e) {
            if (!(e instanceof GhlApiError) || ['GHL_UNAUTHORIZED', 'GHL_REFRESH_REJECTED', 'GHL_FORBIDDEN'].includes(e.code)) throw e;
            await this.event(jobId, null, id, 'import.fetch', 'failed', e.code);
            failed++;
            continue;
          }
          tally(await this.applyImport(jobId, p.companyId, remote, !!dto.overwriteLocalChanges));
        }
      } else {
        for (let page = 1; ; page++) {
          const result = await this.client.searchContacts(conn, { page, pageLimit: IMPORT_PAGE_SIZE });
          for (const remote of result.contacts) tally(await this.applyImport(jobId, p.companyId, remote, !!dto.overwriteLocalChanges));
          if (!result.hasMore || !result.contacts.length) break;
          if (success + failed >= MAX_FULL_IMPORT) {
            jobError = 'IMPORT_LIMIT_REACHED';
            break;
          }
        }
      }
      await this.connections.touch(conn, null);
    } catch (e) {
      jobError = errorCode(e);
      await this.connections.touch(conn, jobError);
      this.logger.warn({ msg: 'import_aborted', jobId, code: jobError, correlationId });
    }

    await this.finishJob(jobId, success, failed, jobError);
    await this.audit.record({ companyId: p.companyId, actorId: p.userId, action: 'sync.import', resourceType: 'SyncJob', resourceId: jobId, correlationId, metadata: { success, failed, selected: dto.ghlContactIds?.length ?? null, errorCode: jobError } });
    return this.getJob(p.companyId, jobId);
  }

  /**
   * Inserta o actualiza un contacto por (companyId, ghlContactId). Nunca pisa en silencio cambios locales:
   * si el contacto está pendiente de exportar o en conflicto, se omite (y pasa a conflicto si GHL también cambió).
   */
  private async applyImport(jobId: string, companyId: string, remote: RemoteContact, overwriteLocal: boolean): Promise<Outcome> {
    const hash = fieldsHash(remote);
    const fields = pickFields(remote);
    const now = new Date();
    try {
      return await this.prisma.$transaction(async tx => {
        const existing = await tx.contact.findUnique({ where: { companyId_ghlContactId: { companyId, ghlContactId: remote.id } } });
        if (!existing) {
          const created = await tx.contact.create({
            data: { companyId, ghlContactId: remote.id, ...fields, source: remote.source ?? 'ghl', origin: 'ghl', syncStatus: 'synced', lastSyncedAt: now, lastRemoteUpdate: remote.dateUpdated, remoteHash: hash },
          });
          await this.event(jobId, created.id, remote.id, 'import.created', 'success', null, tx);
          return { ok: true };
        }
        if ((existing.syncStatus === 'pending' || existing.syncStatus === 'conflict') && !overwriteLocal) {
          const remoteChanged = existing.remoteHash !== hash;
          if (remoteChanged && existing.syncStatus !== 'conflict') await tx.contact.update({ where: { id: existing.id }, data: { syncStatus: 'conflict' } });
          await this.event(jobId, existing.id, remote.id, 'import.skipped', 'failed', remoteChanged ? 'CONFLICT_REMOTE_CHANGED' : 'LOCAL_CHANGES_PENDING', tx);
          return { ok: false };
        }
        const unchanged = existing.syncStatus === 'synced' && existing.remoteHash === hash && diffFields(pickFields(existing), fields).length === 0;
        if (unchanged) {
          await tx.contact.update({ where: { id: existing.id }, data: { lastSyncedAt: now, lastRemoteUpdate: remote.dateUpdated ?? existing.lastRemoteUpdate } });
          await this.event(jobId, existing.id, remote.id, 'import.unchanged', 'success', null, tx);
          return { ok: true };
        }
        await tx.contact.update({
          where: { id: existing.id },
          data: { ...fields, source: remote.source ?? existing.source, origin: 'ghl', syncStatus: 'synced', lastSyncedAt: now, lastRemoteUpdate: remote.dateUpdated, remoteHash: hash },
        });
        await this.event(jobId, existing.id, remote.id, 'import.updated', 'success', null, tx);
        return { ok: true };
      });
    } catch (e) {
      this.logger.error({ msg: 'import_contact_failed', jobId, error: e instanceof Error ? e.message : 'unknown' });
      await this.event(jobId, null, remote.id, 'import.write', 'failed', 'DB_WRITE_FAILED');
      return { ok: false };
    }
  }

  // ───────────────────────────── Exportación PostgreSQL → GHL ─────────────────────────────

  /** Vista previa sin escrituras: diferencias campo a campo y conflictos detectados contra el estado remoto actual. */
  async previewExport(p: Principal, contactIds: string[]) {
    const contacts = await this.loadOwned(p.companyId, contactIds);
    const conn = await this.connections.resolve(p.companyId);
    const items = [];
    for (const c of contacts) {
      try {
        const remote = await this.client.getContact(conn, c.ghlContactId);
        const reason = detectRemoteChange(c, remote);
        const changes = diffFields(pickFields(c), pickFields(remote));
        items.push({
          contactId: c.id,
          ghlContactId: c.ghlContactId,
          name: [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || c.ghlContactId,
          syncStatus: c.syncStatus,
          changes,
          conflict: changes.length > 0 && reason ? reason : null,
          remoteTouched: remoteTouchedSince(c.lastRemoteUpdate, remote),
          remoteDateUpdated: remote.dateUpdated,
          error: null as string | null,
        });
      } catch (e) {
        if (e instanceof GhlApiError && ['GHL_UNAUTHORIZED', 'GHL_REFRESH_REJECTED', 'GHL_NOT_CONNECTED'].includes(e.code)) throw e;
        items.push({ contactId: c.id, ghlContactId: c.ghlContactId, name: [c.firstName, c.lastName].filter(Boolean).join(' '), syncStatus: c.syncStatus, changes: [], conflict: null, remoteTouched: false, remoteDateUpdated: null, error: errorCode(e) });
      }
    }
    await this.connections.touch(conn, null);
    const preview = signPreview(this.config.jwtSecret, p.companyId, contacts);
    return {
      items,
      summary: {
        total: items.length,
        withChanges: items.filter(i => i.changes.length).length,
        conflicts: items.filter(i => i.conflict).length,
        errors: items.filter(i => i.error).length,
      },
      previewToken: preview.token,
      expiresAt: preview.expiresAt,
    };
  }

  async exportContacts(p: Principal, dto: ExportDto, idempotencyKey: string | undefined, correlationId: string) {
    if (dto.overwriteConflicts && !hasRole(p, 'admin')) throw forbidden('INSUFFICIENT_ROLE', 'Sobrescribir conflictos requiere rol admin');
    if (idempotencyKey) {
      const previous = await this.prisma.syncJob.findUnique({ where: { companyId_idempotencyKey: { companyId: p.companyId, idempotencyKey } } });
      if (previous) return this.replay(previous, 'export', p.companyId);
    }
    const contacts = await this.loadOwned(p.companyId, dto.contactIds);
    if (!verifyPreview(this.config.jwtSecret, dto.previewToken, p.companyId, contacts)) {
      throw conflict('PREVIEW_STALE', 'La vista previa expiró o los contactos cambiaron. Genera una nueva vista previa.');
    }
    const conn = await this.connections.resolve(p.companyId);
    const started = await this.startJob(p, 'export', idempotencyKey);
    if (started.replayed) return this.getJob(p.companyId, started.jobId);
    const jobId = started.jobId;
    const metadata = await this.metadataFieldIds(p.companyId);

    let success = 0;
    let failed = 0;
    let jobError: string | null = null;
    for (const c of contacts) {
      try {
        const outcome = await this.exportOne(jobId, conn, c, !!dto.overwriteConflicts);
        outcome.ok ? success++ : failed++;
        if (outcome.ok && metadata) await this.writeMetadata(jobId, conn, c, metadata);
      } catch (e) {
        // Credenciales inválidas: no tiene sentido seguir con el resto del lote.
        jobError = errorCode(e);
        failed += contacts.length - success - failed;
        await this.event(jobId, c.id, c.ghlContactId, 'export.aborted', 'failed', jobError);
        break;
      }
    }
    await this.connections.touch(conn, jobError);
    await this.finishJob(jobId, success, failed, jobError);
    await this.audit.record({ companyId: p.companyId, actorId: p.userId, action: 'sync.export', resourceType: 'SyncJob', resourceId: jobId, correlationId, metadata: { success, failed, overwriteConflicts: !!dto.overwriteConflicts, errorCode: jobError } });
    return this.getJob(p.companyId, jobId);
  }

  private async exportOne(jobId: string, conn: GhlConnection, c: Contact, overwriteConflicts: boolean): Promise<Outcome> {
    const fatal = (e: unknown) => e instanceof GhlApiError && ['GHL_UNAUTHORIZED', 'GHL_REFRESH_REJECTED', 'GHL_NOT_CONNECTED'].includes(e.code);
    const fail = async (code: string, status?: 'failed' | 'conflict') => {
      if (status) await this.prisma.contact.update({ where: { id: c.id }, data: { syncStatus: status } });
      await this.event(jobId, c.id, c.ghlContactId, 'export.update', 'failed', code);
      return { ok: false };
    };

    // 1. Estado remoto actual.
    let remote: RemoteContact;
    try {
      remote = await this.client.getContact(conn, c.ghlContactId);
    } catch (e) {
      if (fatal(e)) throw e;
      return fail(errorCode(e), e instanceof GhlApiError && e.code === 'GHL_NOT_FOUND' ? 'failed' : undefined);
    }

    const local = pickFields(c);
    const changes = diffFields(local, pickFields(remote));
    // 2. Sin diferencias: ya está alineado (también resuelve un conflicto en el que ambos lados coinciden).
    if (!changes.length) {
      await this.prisma.contact.updateMany({ where: { id: c.id, updatedAt: c.updatedAt }, data: { syncStatus: 'synced', remoteHash: fieldsHash(remote), lastRemoteUpdate: remote.dateUpdated, lastSyncedAt: new Date() } });
      await this.event(jobId, c.id, c.ghlContactId, 'export.unchanged', 'success', null);
      return { ok: true };
    }
    // 3. Conflicto: GHL cambió desde la última sincronización (o no hay base para saberlo).
    const reason = detectRemoteChange(c, remote);
    if (reason && !overwriteConflicts) return fail(`CONFLICT_${reason}`, 'conflict');

    // 4. PUT sólo con los campos autorizados que difieren.
    const patch: ContactPatch = Object.fromEntries(changes.map(ch => [ch.field, local[ch.field]]));
    let updated: RemoteContact;
    try {
      updated = await this.client.updateContact(conn, c.ghlContactId, patch);
    } catch (e) {
      if (fatal(e)) throw e;
      return fail(errorCode(e), 'failed');
    }
    // 5. Verificación: la respuesta de GHL debe reflejar lo enviado.
    const mismatched = changes.filter(ch => !sameValue(ch.field, local[ch.field], updated[ch.field]));
    if (mismatched.length) return fail('REMOTE_VERIFY_FAILED', 'failed');

    // 6. Estado local: se adoptan los valores canónicos devueltos por GHL (p. ej. teléfono E.164).
    const saved = await this.prisma.contact.updateMany({
      where: { id: c.id, updatedAt: c.updatedAt },
      data: { ...pickFields(updated), origin: 'local', syncStatus: 'synced', lastSyncedAt: new Date(), lastRemoteUpdate: updated.dateUpdated ?? new Date(), remoteHash: fieldsHash(updated) },
    });
    if (saved.count !== 1) {
      // El usuario editó el contacto durante la exportación: se conserva su edición como pendiente y se actualiza la base remota.
      await this.prisma.contact.update({ where: { id: c.id }, data: { remoteHash: fieldsHash(updated), lastRemoteUpdate: updated.dateUpdated ?? new Date() } });
      await this.event(jobId, c.id, c.ghlContactId, 'export.update', 'failed', 'LOCAL_CHANGED_DURING_EXPORT');
      return { ok: false };
    }
    await this.event(jobId, c.id, c.ghlContactId, 'export.update', 'success', null);
    return { ok: true };
  }

  // ───────────────────────────── Metadatos AIDA en GHL ─────────────────────────────

  /**
   * IDs de "AIDA - ID externo" y "AIDA - Estado de sincronización" de ESTA location (ProvisionedResource).
   * null si la escritura está desactivada (GHL_SYNC_METADATA_WRITE) o la configuración no los registró.
   */
  private async metadataFieldIds(companyId: string) {
    if (!this.config.ghl.syncMetadataWrite) return null;
    const ids = await this.provisioning.activeResourceIds(companyId);
    const externalId = ids.get(RESOURCE_KEYS.externalId);
    const syncStatus = ids.get(RESOURCE_KEYS.syncStatus);
    return externalId && syncStatus ? { externalId, syncStatus } : null;
  }

  /**
   * Escribe los metadatos sólo tras una exportación confirmada y exitosa (operación remota autorizada). Envía
   * exclusivamente esos dos custom fields; un fallo se registra como evento propio sin alterar el resultado real
   * de la exportación ya completada.
   */
  private async writeMetadata(jobId: string, conn: GhlConnection, c: Contact, ids: { externalId: string; syncStatus: string }) {
    try {
      await this.client.updateCustomFields(conn, c.ghlContactId, [
        { id: ids.externalId, field_value: c.id },
        { id: ids.syncStatus, field_value: 'synced' satisfies (typeof SYNC_STATUS_VALUES)[number] },
      ]);
      await this.event(jobId, c.id, c.ghlContactId, 'export.metadata', 'success', null);
    } catch (e) {
      if (e instanceof GhlApiError && ['GHL_UNAUTHORIZED', 'GHL_REFRESH_REJECTED', 'GHL_NOT_CONNECTED'].includes(e.code)) throw e;
      await this.event(jobId, c.id, c.ghlContactId, 'export.metadata', 'failed', errorCode(e));
    }
  }

  // ───────────────────────────── Trabajos ─────────────────────────────

  async listJobs(companyId: string, q: ListJobsQueryDto) {
    const where: Prisma.SyncJobWhereInput = { companyId, ...(q.direction ? { direction: q.direction } : {}), ...(q.status ? { status: q.status } : {}) };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.syncJob.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.limit, take: q.limit, omit: { idempotencyKey: true } }),
      this.prisma.syncJob.count({ where }),
    ]);
    return paginated(items, total, q);
  }

  async getJob(companyId: string, id: string) {
    const job = await this.prisma.syncJob.findFirst({
      where: { id, companyId },
      omit: { idempotencyKey: true },
      include: {
        events: {
          orderBy: { createdAt: 'asc' },
          take: 500,
          select: { id: true, contactId: true, ghlContactId: true, operation: true, status: true, errorCode: true, createdAt: true, contact: { select: { firstName: true, lastName: true } } },
        },
      },
    });
    if (!job) throw notFound('JOB_NOT_FOUND', 'Trabajo no encontrado');
    return job;
  }

  private async loadOwned(companyId: string, ids: string[]) {
    const contacts = await this.prisma.contact.findMany({ where: { companyId, id: { in: ids } }, orderBy: { id: 'asc' } });
    // Un id ajeno se trata igual que uno inexistente (no revela datos de otras empresas).
    if (contacts.length !== new Set(ids).size) throw notFound('CONTACT_NOT_FOUND', 'Uno o más contactos no existen en esta empresa');
    return contacts;
  }

  private async replay(job: { id: string; direction: SyncDirection }, direction: SyncDirection, companyId: string) {
    if (job.direction !== direction) throw conflict('IDEMPOTENCY_KEY_REUSED', 'La Idempotency-Key ya se usó para otra operación');
    return this.getJob(companyId, job.id);
  }

  /** Crea el trabajo. El índice único parcial impide dos trabajos activos por empresa (evita carreras y bucles). */
  private async startJob(p: Principal, direction: SyncDirection, idempotencyKey?: string): Promise<{ jobId: string; replayed: boolean }> {
    if (idempotencyKey) {
      const previous = await this.prisma.syncJob.findUnique({ where: { companyId_idempotencyKey: { companyId: p.companyId, idempotencyKey } } });
      if (previous) {
        await this.replay(previous, direction, p.companyId);
        return { jobId: previous.id, replayed: true };
      }
    }
    try {
      const job = await this.prisma.syncJob.create({ data: { companyId: p.companyId, requestedById: p.userId, direction, status: 'running', startedAt: new Date(), idempotencyKey } });
      return { jobId: job.id, replayed: false };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        if (idempotencyKey) {
          const previous = await this.prisma.syncJob.findUnique({ where: { companyId_idempotencyKey: { companyId: p.companyId, idempotencyKey } } });
          if (previous) return { jobId: previous.id, replayed: true };
        }
        throw conflict('SYNC_IN_PROGRESS', 'Ya hay una sincronización en curso para esta empresa');
      }
      throw e;
    }
  }

  private async finishJob(jobId: string, success: number, failed: number, jobError: string | null) {
    const total = success + failed;
    let status: JobStatus = JobStatus.completed;
    if (success === 0 && (jobError || failed > 0)) status = JobStatus.failed;
    else if (failed > 0 || jobError) status = JobStatus.partially_failed;
    await this.prisma.syncJob.update({ where: { id: jobId }, data: { status, finishedAt: new Date(), totalRecords: total, successfulRecords: success, failedRecords: failed, errorCode: jobError } });
  }

  private event(syncJobId: string, contactId: string | null, ghlContactId: string | null, operation: string, status: 'success' | 'failed', code: string | null, tx: Prisma.TransactionClient = this.prisma) {
    return tx.syncEvent.create({ data: { syncJobId, contactId, ghlContactId, operation, status, errorCode: code } });
  }
}

