import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { GhlModule } from '../ghl/ghl.module';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

@Module({ imports: [AuditModule, GhlModule], controllers: [SyncController], providers: [SyncService] })
export class SyncModule {}
