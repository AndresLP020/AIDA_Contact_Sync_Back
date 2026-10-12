import { Body, Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { forbidden } from '../common/errors';
import { CurrentPrincipal, type Principal, RequireRole } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { GhlContactsClient } from './contacts/ghl-contacts.client';
import { MockGhlContactsClient } from './contacts/mock-ghl-contacts.client';
import { GhlConnectionService } from './ghl-connection.service';

class RemoteContactsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1000) page: number = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit: number = 20;
  @IsOptional() @IsString() @MaxLength(100) q?: string;
}

class SimulateRemoteEditDto {
  @IsString() @MaxLength(128) ghlContactId!: string;
}

@ApiTags('integrations')
@ApiCookieAuth('aida_session')
@Controller('integrations/ghl')
export class IntegrationsController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly client: GhlContactsClient,
    private readonly connections: GhlConnectionService,
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'Estado de la integración GHL de la empresa activa. Nunca incluye tokens.' })
  async status(@CurrentPrincipal() p: Principal) {
    const mode = this.config.ghl.mode;
    const installation = await this.prisma.ghlInstallation.findUnique({
      where: { companyId: p.companyId },
      select: { ghlLocationId: true, installationStatus: true, grantedScopes: true, installedAt: true, revokedAt: true, lastCommunicationAt: true, lastErrorCode: true, credential: { select: { expiresAt: true, tokenVersion: true, updatedAt: true } } },
    });
    if (mode === 'mock') {
      return { mode, simulated: true, connected: true, status: 'simulated', locationId: `mock-location-${p.companyId}`, scopes: this.config.ghl.scopes, credential: { present: false, expiresAt: null, tokenVersion: null }, installedAt: null, lastCommunicationAt: null, lastErrorCode: null, requestedScopes: this.config.ghl.scopes };
    }
    return {
      mode,
      simulated: false,
      connected: installation?.installationStatus === 'active' && !!installation.credential,
      status: installation?.installationStatus ?? 'not_connected',
      locationId: installation?.ghlLocationId ?? null,
      scopes: installation?.grantedScopes ?? [],
      requestedScopes: this.config.ghl.scopes,
      credential: { present: !!installation?.credential, expiresAt: installation?.credential?.expiresAt ?? null, tokenVersion: installation?.credential?.tokenVersion ?? null },
      installedAt: installation?.installedAt ?? null,
      revokedAt: installation?.revokedAt ?? null,
      lastCommunicationAt: installation?.lastCommunicationAt ?? null,
      lastErrorCode: installation?.lastErrorCode ?? null,
    };
  }

  @Get('contacts')
  @RequireRole('editor')
  @ApiOperation({ summary: 'Lista contactos remotos de la subcuenta conectada (para elegir qué importar). No persiste nada.' })
  async remoteContacts(@CurrentPrincipal() p: Principal, @Query() q: RemoteContactsQueryDto) {
    const conn = await this.connections.resolve(p.companyId);
    try {
      const page = await this.client.searchContacts(conn, { page: q.page, pageLimit: q.limit, query: q.q });
      await this.connections.touch(conn, null);
      const local = await this.prisma.contact.findMany({ where: { companyId: p.companyId, ghlContactId: { in: page.contacts.map(c => c.id) } }, select: { id: true, ghlContactId: true, syncStatus: true } });
      const byId = new Map(local.map(l => [l.ghlContactId, l]));
      return {
        items: page.contacts.map(c => ({ ghlContactId: c.id, firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone, source: c.source, dateUpdated: c.dateUpdated, localId: byId.get(c.id)?.id ?? null, localStatus: byId.get(c.id)?.syncStatus ?? null })),
        page: q.page,
        limit: q.limit,
        total: page.total,
        hasMore: page.hasMore,
      };
    } catch (e) {
      await this.connections.touch(conn, (e as { code?: string }).code ?? 'GHL_ERROR');
      throw e;
    }
  }

  @Post('mock/remote-edit')
  @HttpCode(200)
  @RequireRole('editor')
  @ApiOperation({ summary: 'SOLO MODO SIMULADO: simula una edición hecha directamente en GHL para demostrar la detección de conflictos.' })
  async simulateRemoteEdit(@CurrentPrincipal() p: Principal, @Body() body: SimulateRemoteEditDto) {
    if (!(this.client instanceof MockGhlContactsClient) || this.config.isProduction) throw forbidden('MOCK_ONLY', 'Disponible sólo con GHL_MODE=mock fuera de producción');
    const local = await this.prisma.contact.findFirst({ where: { companyId: p.companyId, ghlContactId: body.ghlContactId } });
    if (!local) throw forbidden('NOT_OWNED', 'El contacto no pertenece a esta empresa');
    const conn = await this.connections.resolve(p.companyId);
    const remote = await this.client.simulateRemoteEdit(conn, body.ghlContactId);
    return { ghlContactId: remote.id, lastName: remote.lastName, dateUpdated: remote.dateUpdated };
  }
}
