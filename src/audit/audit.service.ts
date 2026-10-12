import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type AuditEntry = {
  companyId: string;
  actorId: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  correlationId: string;
  /** Sólo metadatos no sensibles: nombres de campos, contadores, códigos. Nunca valores personales ni secretos. */
  metadata?: Prisma.InputJsonValue;
};

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  record(entry: AuditEntry, tx: Prisma.TransactionClient = this.prisma) {
    return tx.auditLog.create({
      data: {
        companyId: entry.companyId,
        actorId: entry.actorId,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId ?? null,
        correlationId: entry.correlationId,
        metadata: entry.metadata,
      },
    });
  }
}
