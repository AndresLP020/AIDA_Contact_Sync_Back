import { Controller, Get, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { PaginationQueryDto, paginated } from '../common/pagination';
import { CurrentPrincipal, type Principal, RequireRole } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';

class AuditQueryDto extends PaginationQueryDto {
  @IsOptional() @IsString() @MaxLength(80) @Matches(/^[a-z0-9_.]+$/)
  action?: string;
}

@ApiTags('audit')
@ApiCookieAuth('aida_session')
@Controller('audit')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @RequireRole('admin')
  @ApiOperation({ summary: 'Bitácora de auditoría de la empresa activa (admin/owner)' })
  async list(@CurrentPrincipal() p: Principal, @Query() q: AuditQueryDto) {
    const where = { companyId: p.companyId, ...(q.action ? { action: { startsWith: q.action } } : {}) };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        select: { id: true, action: true, resourceType: true, resourceId: true, metadata: true, correlationId: true, createdAt: true, actor: { select: { id: true, displayName: true } } },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return paginated(items, total, q);
  }
}
