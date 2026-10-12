import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { conflict, notFound } from '../common/errors';
import { paginated } from '../common/pagination';
import type { Principal } from '../common/request-context';
import { normalizeField, SYNCABLE_FIELDS, type SyncableField } from '../ghl/contacts/ghl-contact.types';
import { PrismaService } from '../prisma/prisma.service';
import type { ListContactsQueryDto, UpdateContactDto } from './contacts.dto';

/** Columnas expuestas por la API (sin hashes internos). */
export const CONTACT_SELECT = {
  id: true,
  ghlContactId: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  source: true,
  origin: true,
  syncStatus: true,
  lastSyncedAt: true,
  lastRemoteUpdate: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ContactSelect;

@Injectable()
export class ContactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(companyId: string, q: ListContactsQueryDto) {
    const search = q.q?.trim();
    const where: Prisma.ContactWhereInput = {
      companyId,
      ...(q.status ? { syncStatus: q.status } : {}),
      ...(search
        ? {
            OR: [
              { firstName: { contains: search, mode: 'insensitive' } },
              { lastName: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search } },
              { ghlContactId: { contains: search } },
            ],
          }
        : {}),
    };
    const ORDER: Record<ListContactsQueryDto['sort'], Prisma.ContactOrderByWithRelationInput[]> = {
      updatedAt: [{ updatedAt: 'desc' }, { id: 'asc' }],
      lastName: [{ lastName: { sort: 'asc', nulls: 'last' } }, { firstName: { sort: 'asc', nulls: 'last' } }, { id: 'asc' }],
      lastSyncedAt: [{ lastSyncedAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
    };
    const orderBy = ORDER[q.sort];
    const [items, total] = await this.prisma.$transaction([
      this.prisma.contact.findMany({ where, orderBy, skip: (q.page - 1) * q.limit, take: q.limit, select: CONTACT_SELECT }),
      this.prisma.contact.count({ where }),
    ]);
    return paginated(items, total, q);
  }

  /** Siempre filtra por companyId: un id de otra empresa responde 404 (sin revelar su existencia). */
  async get(companyId: string, id: string) {
    const contact = await this.prisma.contact.findFirst({ where: { id, companyId }, select: CONTACT_SELECT });
    if (!contact) throw notFound('CONTACT_NOT_FOUND', 'Contacto no encontrado');
    return contact;
  }

  async history(companyId: string, id: string) {
    await this.get(companyId, id);
    return this.prisma.syncEvent.findMany({
      where: { contactId: id, syncJob: { companyId } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, operation: true, status: true, errorCode: true, createdAt: true, syncJobId: true },
    });
  }

  /**
   * Edición local. No escribe en GHL: marca el contacto como `pending` para exportarlo de forma explícita.
   * Un contacto en `conflict` permanece en conflicto hasta resolverse.
   */
  async update(p: Principal, id: string, dto: UpdateContactDto, correlationId: string) {
    const existing = await this.prisma.contact.findFirst({ where: { id, companyId: p.companyId } });
    if (!existing) throw notFound('CONTACT_NOT_FOUND', 'Contacto no encontrado');
    if (dto.expectedUpdatedAt && new Date(dto.expectedUpdatedAt).getTime() !== existing.updatedAt.getTime()) {
      throw conflict('STALE_CONTACT', 'El contacto cambió desde que lo abriste. Recarga y vuelve a intentarlo.');
    }
    const data: Partial<Record<SyncableField, string | null>> = {};
    for (const field of SYNCABLE_FIELDS) {
      if (dto[field] === undefined) continue;
      const value = normalizeField(field, dto[field]);
      if (value !== existing[field]) data[field] = value;
    }
    const changed = Object.keys(data);
    if (!changed.length) return this.get(p.companyId, id);

    // updateMany con updatedAt como condición evita sobrescribir una edición concurrente.
    const result = await this.prisma.$transaction(async tx => {
      const res = await tx.contact.updateMany({
        where: { id, companyId: p.companyId, updatedAt: existing.updatedAt },
        data: { ...data, syncStatus: existing.syncStatus === 'conflict' ? 'conflict' : 'pending' },
      });
      if (res.count === 1) {
        await this.audit.record({ companyId: p.companyId, actorId: p.userId, action: 'contact.updated', resourceType: 'Contact', resourceId: id, correlationId, metadata: { fields: changed } }, tx);
      }
      return res.count;
    });
    if (result !== 1) throw conflict('STALE_CONTACT', 'El contacto cambió durante la edición. Recarga y vuelve a intentarlo.');
    return this.get(p.companyId, id);
  }

  async summary(companyId: string) {
    const [byStatus, lastJob, failedJobs, pendingJobs] = await Promise.all([
      this.prisma.contact.groupBy({ by: ['syncStatus'], where: { companyId }, _count: { _all: true } }),
      this.prisma.syncJob.findFirst({ where: { companyId, finishedAt: { not: null } }, orderBy: { finishedAt: 'desc' }, select: { id: true, direction: true, status: true, finishedAt: true } }),
      this.prisma.syncJob.count({ where: { companyId, status: { in: ['failed', 'partially_failed'] }, createdAt: { gt: new Date(Date.now() - 7 * 86400_000) } } }),
      this.prisma.syncJob.count({ where: { companyId, status: { in: ['pending', 'running'] } } }),
    ]);
    const counts = Object.fromEntries(byStatus.map(s => [s.syncStatus, s._count._all])) as Record<string, number>;
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return {
      contacts: { total, synced: counts.synced ?? 0, pending: counts.pending ?? 0, conflict: counts.conflict ?? 0, failed: counts.failed ?? 0 },
      jobs: { running: pendingJobs, failedLast7Days: failedJobs },
      lastSync: lastJob,
    };
  }
}
