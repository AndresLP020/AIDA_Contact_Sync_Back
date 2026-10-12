import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';

@Module({ imports: [AuditModule], controllers: [ContactsController], providers: [ContactsService], exports: [ContactsService] })
export class ContactsModule {}
