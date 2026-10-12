import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { PrismaService } from '../prisma/prisma.service';
import type { GhlConnection } from './contacts/ghl-contacts.client';
import { GhlApiError } from './contacts/ghl-errors';

/** Resuelve la subcuenta GHL a partir de la empresa autenticada. El locationId jamás proviene del frontend. */
@Injectable()
export class GhlConnectionService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  async resolve(companyId: string): Promise<GhlConnection> {
    if (this.config.ghl.mode === 'mock') return { companyId, locationId: `mock-location-${companyId}`, installationId: null };
    const installation = await this.prisma.ghlInstallation.findUnique({ where: { companyId } });
    if (!installation || installation.installationStatus !== 'active') throw new GhlApiError('GHL_NOT_CONNECTED');
    return { companyId, locationId: installation.ghlLocationId, installationId: installation.id };
  }

  /** Registra la última comunicación exitosa o el último código de error (sin detalles sensibles). */
  async touch(conn: GhlConnection, errorCode: string | null) {
    if (!conn.installationId) return;
    await this.prisma.ghlInstallation.update({
      where: { id: conn.installationId },
      data: errorCode ? { lastErrorCode: errorCode } : { lastCommunicationAt: new Date(), lastErrorCode: null },
    });
  }
}
