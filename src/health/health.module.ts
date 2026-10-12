import { Controller, Get, Inject, Module } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { CorrelationId, CurrentPrincipal, type Principal, Public } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
  ) {}

  private async database() {
    const started = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' as const, latencyMs: Date.now() - started };
    } catch {
      return { status: 'error' as const, latencyMs: null };
    }
  }

  @Get('health')
  @Public()
  @SkipThrottle()
  @ApiOperation({ summary: 'Salud pública (sin datos sensibles). Usada por Docker/ALB.' })
  async health() {
    const database = await this.database();
    return { status: database.status === 'ok' ? 'ok' : 'degraded', service: 'aida-contact-sync-api', database: database.status, timestamp: new Date().toISOString() };
  }

  @Get('diagnostics')
  @ApiCookieAuth('aida_session')
  @ApiOperation({ summary: 'Diagnóstico de la empresa activa: BD, modo/estado GHL y último error sanitizado' })
  async diagnostics(@CurrentPrincipal() p: Principal, @CorrelationId() correlationId: string) {
    const [database, installation, lastFailure] = await Promise.all([
      this.database(),
      this.prisma.ghlInstallation.findUnique({ where: { companyId: p.companyId }, select: { installationStatus: true, lastCommunicationAt: true, lastErrorCode: true } }),
      this.prisma.syncEvent.findFirst({ where: { syncJob: { companyId: p.companyId }, status: 'failed' }, orderBy: { createdAt: 'desc' }, select: { errorCode: true, operation: true, createdAt: true, syncJobId: true } }),
    ]);
    const lastJobError = await this.prisma.syncJob.findFirst({ where: { companyId: p.companyId, errorCode: { not: null } }, orderBy: { createdAt: 'desc' }, select: { errorCode: true, direction: true, createdAt: true, id: true } });
    const candidates = [
      lastFailure && { code: lastFailure.errorCode, source: `sync.${lastFailure.operation}`, at: lastFailure.createdAt, jobId: lastFailure.syncJobId },
      lastJobError && { code: lastJobError.errorCode, source: `sync.${lastJobError.direction}`, at: lastJobError.createdAt, jobId: lastJobError.id },
    ].filter(Boolean) as { code: string | null; source: string; at: Date; jobId: string }[];
    const lastError = candidates.sort((a, b) => b.at.getTime() - a.at.getTime())[0] ?? null;
    return {
      backend: { status: 'ok', environment: this.config.env },
      database,
      ghl: {
        mode: this.config.ghl.mode,
        apiBase: this.config.ghl.mode === 'real' ? this.config.ghl.apiBase : null,
        apiVersion: this.config.ghl.apiVersion,
        installationStatus: this.config.ghl.mode === 'mock' ? 'simulated' : installation?.installationStatus ?? 'not_connected',
        lastCommunicationAt: installation?.lastCommunicationAt ?? null,
        lastErrorCode: installation?.lastErrorCode ?? null,
      },
      lastError,
      correlationId,
    };
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
