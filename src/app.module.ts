import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { CompaniesModule } from './companies/companies.module';
import { ConfigModule } from './config/config.module';
import { ContactsModule } from './contacts/contacts.module';
import { GhlModule } from './ghl/ghl.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.service';
import { SyncModule } from './synchronization/sync.module';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    // Límite global por IP; las rutas sensibles (login, callback OAuth) aplican límites más estrictos.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: () => Number(process.env.RATE_LIMIT_PER_MINUTE ?? 300) }]),
    AuditModule,
    AuthModule,
    HealthModule,
    CompaniesModule,
    ContactsModule,
    GhlModule,
    SyncModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
  ],
})
export class AppModule {}
