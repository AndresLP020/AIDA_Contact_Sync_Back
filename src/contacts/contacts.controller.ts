import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CorrelationId, CurrentPrincipal, type Principal, RequireRole } from '../common/request-context';
import { ListContactsQueryDto, UpdateContactDto } from './contacts.dto';
import { ContactsService } from './contacts.service';

@ApiTags('contacts')
@ApiCookieAuth('aida_session')
@Controller('contacts')
export class ContactsController {
  constructor(private readonly contacts: ContactsService) {}

  @Get()
  @ApiOperation({ summary: 'Contactos locales de la empresa activa (búsqueda, filtro por estado, paginación)' })
  list(@CurrentPrincipal() p: Principal, @Query() q: ListContactsQueryDto) {
    return this.contacts.list(p.companyId, q);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalle de un contacto local' })
  detail(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.contacts.get(p.companyId, id);
  }

  @Get(':id/history')
  @ApiOperation({ summary: 'Últimos eventos de sincronización del contacto' })
  history(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.contacts.history(p.companyId, id);
  }

  @Patch(':id')
  @RequireRole('editor')
  @ApiOperation({ summary: 'Edita campos autorizados (firstName, lastName, email, phone). No escribe en GHL.' })
  update(@CurrentPrincipal() p: Principal, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() body: UpdateContactDto, @CorrelationId() correlationId: string) {
    return this.contacts.update(p, id, body, correlationId);
  }
}
