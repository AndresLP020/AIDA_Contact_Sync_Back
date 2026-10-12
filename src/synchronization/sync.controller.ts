import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { badRequest } from '../common/errors';
import { CorrelationId, CurrentPrincipal, type Principal, RequireRole } from '../common/request-context';
import { ExportDto, ExportPreviewDto, ImportDto, ListJobsQueryDto } from './sync.dto';
import { SyncService } from './sync.service';

const IDEMPOTENCY_FORMAT = /^[A-Za-z0-9-]{8,100}$/;
function idempotency(key?: string) {
  if (key === undefined) return undefined;
  if (!IDEMPOTENCY_FORMAT.test(key)) throw badRequest('INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key inválida (8-100 caracteres alfanuméricos o guiones)');
  return key;
}

@ApiTags('sync')
@ApiCookieAuth('aida_session')
@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Post('import')
  @HttpCode(200)
  @RequireRole('editor')
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Repetir la misma clave devuelve el mismo trabajo sin re-ejecutarlo' })
  @ApiOperation({ summary: 'Importa contactos GHL → PostgreSQL (todos o seleccionados). Responde cuando el trabajo terminó.' })
  import(@CurrentPrincipal() p: Principal, @Body() body: ImportDto, @Headers('idempotency-key') key: string | undefined, @CorrelationId() correlationId: string) {
    return this.sync.importContacts(p, body, idempotency(key), correlationId);
  }

  @Post('export/preview')
  @HttpCode(200)
  @RequireRole('editor')
  @ApiOperation({ summary: 'Vista previa de exportación: diferencias y conflictos frente al estado remoto. No escribe nada.' })
  preview(@CurrentPrincipal() p: Principal, @Body() body: ExportPreviewDto) {
    return this.sync.previewExport(p, body.contactIds);
  }

  @Post('export')
  @HttpCode(200)
  @RequireRole('editor')
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({ summary: 'Exporta cambios locales → GHL. Requiere confirmed=true y el previewToken de la vista previa.' })
  export(@CurrentPrincipal() p: Principal, @Body() body: ExportDto, @Headers('idempotency-key') key: string | undefined, @CorrelationId() correlationId: string) {
    return this.sync.exportContacts(p, body, idempotency(key), correlationId);
  }

  @Get('jobs')
  @ApiOperation({ summary: 'Historial de trabajos de sincronización' })
  jobs(@CurrentPrincipal() p: Principal, @Query() q: ListJobsQueryDto) {
    return this.sync.listJobs(p.companyId, q);
  }

  @Get('jobs/:id')
  @ApiOperation({ summary: 'Detalle de un trabajo con el resultado por contacto' })
  job(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.sync.getJob(p.companyId, id);
  }
}
