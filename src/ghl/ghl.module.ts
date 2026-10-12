import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { GhlContactsClient } from './contacts/ghl-contacts.client';
import { GHL_HTTP_TUNING, HttpGhlContactsClient } from './contacts/http-ghl-contacts.client';
import { MockGhlContactsClient } from './contacts/mock-ghl-contacts.client';
import { GhlConnectionService } from './ghl-connection.service';
import { IntegrationsController } from './integrations.controller';
import { GhlOAuthController } from './oauth/ghl-oauth.controller';
import { GhlOAuthService } from './oauth/ghl-oauth.service';
import { FETCH, GhlTokenService } from './tokens/ghl-token.service';
import { TokenCipher } from './tokens/token-cipher.service';
import { GhlWebhooksController } from './webhooks/ghl-webhooks.controller';

@Module({
  imports: [AuditModule],
  controllers: [IntegrationsController, GhlOAuthController, GhlWebhooksController],
  providers: [
    { provide: FETCH, useValue: (...args: Parameters<typeof fetch>) => fetch(...args) },
    // Ajustes del transporte HTTP (vacío = valores por defecto). Las pruebas lo sustituyen para no esperar.
    { provide: GHL_HTTP_TUNING, useValue: {} },
    TokenCipher,
    GhlTokenService,
    GhlConnectionService,
    GhlOAuthService,
    HttpGhlContactsClient,
    {
      // Selección explícita del adaptador. La configuración impide GHL_MODE=mock en producción.
      provide: GhlContactsClient,
      inject: [APP_CONFIG, HttpGhlContactsClient],
      useFactory: (config: AppConfig, real: HttpGhlContactsClient) => (config.ghl.mode === 'real' ? real : new MockGhlContactsClient()),
    },
  ],
  exports: [GhlContactsClient, GhlConnectionService, TokenCipher, GhlTokenService],
})
export class GhlModule {}
