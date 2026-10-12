import { Controller, Get, Module } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, type Principal } from '../common/request-context';
import { ContactsModule } from '../contacts/contacts.module';
import { ContactsService } from '../contacts/contacts.service';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('companies')
@ApiCookieAuth('aida_session')
@Controller('companies')
export class CompaniesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contacts: ContactsService,
  ) {}

  @Get('current')
  @ApiOperation({ summary: 'Empresa activa resuelta desde la sesión (no acepta locationId del cliente)' })
  async current(@CurrentPrincipal() p: Principal) {
    const company = await this.prisma.company.findUniqueOrThrow({ where: { id: p.companyId }, select: { id: true, name: true, ghlLocationId: true, status: true, createdAt: true } });
    return { ...company, role: p.role };
  }

  @Get('current/summary')
  @ApiOperation({ summary: 'Indicadores del dashboard para la empresa activa' })
  summary(@CurrentPrincipal() p: Principal) {
    return this.contacts.summary(p.companyId);
  }
}

@Module({ imports: [ContactsModule], controllers: [CompaniesController] })
export class CompaniesModule {}
