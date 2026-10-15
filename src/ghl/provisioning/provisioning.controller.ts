import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { badRequest } from '../../common/errors';
import { CorrelationId, CurrentPrincipal, type Principal, RequireRole } from '../../common/request-context';
import { ProvisioningService } from './provisioning.service';

@ApiTags('integrations')
@ApiCookieAuth('aida_session')
@Controller('integrations/ghl/provisioning')
export class ProvisioningController {
  constructor(private readonly provisioning: ProvisioningService) {}

  @Get()
  @ApiOperation({ summary: 'Estado de la configuración automática de la subcuenta de la empresa activa (manifiesto, recursos, scopes faltantes).' })
  status(@CurrentPrincipal() p: Principal) {
    return this.provisioning.status(p.companyId);
  }

  @Post('retry')
  @HttpCode(202)
  @RequireRole('admin')
  @ApiOperation({ summary: 'Reintenta la configuración (idempotente). La location sale de la sesión; si ya hay una ejecución activa se reutiliza.' })
  retry(@CurrentPrincipal() p: Principal, @Body() body: unknown, @CorrelationId() correlationId: string) {
    // La location NUNCA viene del cliente: cualquier propiedad (p. ej. locationId) se rechaza.
    if (body && typeof body === 'object' && Object.keys(body).length) throw badRequest('VALIDATION_FAILED', 'Esta operación no acepta parámetros');
    return this.provisioning.retry(p, correlationId);
  }
}
