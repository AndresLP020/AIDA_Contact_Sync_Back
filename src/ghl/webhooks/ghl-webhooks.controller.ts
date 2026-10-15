import { Controller, Headers, HttpCode, Inject, Logger, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { type AppRequest, Public } from '../../common/request-context';
import { PrismaService } from '../../prisma/prisma.service';
import { GhlOAuthService } from '../oauth/ghl-oauth.service';
import { ProvisioningService } from '../provisioning/provisioning.service';
import { verifyGhlSignature } from './webhook-signature';

const eventSchema = z.object({
  type: z.string().max(64),
  appId: z.string().max(128).optional(),
  locationId: z.string().max(128).optional(),
  companyId: z.string().max(128).optional(),
  webhookId: z.string().max(128).optional(),
});

/**
 * Webhooks de la app Marketplace (Build > Advanced Settings > Webhooks): INSTALL y UNINSTALL.
 * La autenticidad se verifica con X-GHL-Signature (Ed25519). Un webhook NUNCA concede acceso por sí solo:
 * INSTALL sólo encola la configuración de una instalación que ya tiene credenciales activas obtenidas por OAuth.
 */
@ApiExcludeController()
@Controller('integrations/ghl/webhooks')
export class GhlWebhooksController {
  private readonly logger = new Logger('GhlWebhooks');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly oauth: GhlOAuthService,
    private readonly provisioning: ProvisioningService,
  ) {}

  @Post()
  @Public()
  @SkipThrottle()
  @HttpCode(200)
  async receive(@Req() req: AppRequest, @Headers('x-ghl-signature') signature?: string) {
    const raw = req.rawBody;
    if (!raw || !verifyGhlSignature(raw, signature, this.config.ghl.webhookPublicKey)) {
      this.logger.warn({ msg: 'ghl_webhook_rejected', reason: 'invalid_signature', correlationId: req.correlationId });
      throw new UnauthorizedException({ code: 'INVALID_SIGNATURE', message: 'Firma de webhook inválida' });
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return { received: true, ignored: 'invalid_json' };
    }
    const parsed = eventSchema.safeParse(body);
    if (!parsed.success) return { received: true, ignored: 'unrecognized_payload' };
    const event = parsed.data;
    if (this.config.ghl.appId && event.appId && event.appId !== this.config.ghl.appId) return { received: true, ignored: 'other_app' };

    // GHL reintenta hasta 12 veces: se deduplica por hash del cuerpo firmado y, si viene, por webhookId.
    let stored;
    try {
      stored = await this.prisma.ghlWebhookEvent.create({
        data: { bodyHash: createHash('sha256').update(raw).digest('hex'), webhookId: event.webhookId ?? null, type: event.type, locationId: event.locationId ?? null, ghlCompanyId: event.companyId ?? null },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return { received: true, duplicate: true };
      throw e;
    }

    if (event.type === 'UNINSTALL') {
      const revoked = event.locationId ? await this.oauth.handleUninstall(event.locationId) : event.companyId ? (await this.oauth.handleAgencyUninstall(event.companyId)) > 0 : false;
      this.logger.log({ msg: 'ghl_uninstall_processed', revoked, correlationId: req.correlationId });
      return { received: true };
    }

    if (event.type === 'INSTALL') {
      const status = await this.handleInstall(event, req.correlationId);
      await this.prisma.ghlWebhookEvent.update({ where: { id: stored.id }, data: { processingStatus: status, processedAt: status === 'pending' ? null : new Date() } });
      this.logger.log({ msg: 'ghl_install_webhook', status, correlationId: req.correlationId });
    }
    return { received: true };
  }

  /**
   * INSTALL: converge en el mismo servicio idempotente de configuración. No asume orden de llegada:
   *  - Instalación activa de la misma location (y agencia compatible): encola configuración si la generación vigente
   *    aún no tiene ejecución.
   *  - Sin instalación activa (el token aún no llegó, o fue revocada): queda pendiente; nunca reactiva una baja.
   */
  private async handleInstall(event: z.infer<typeof eventSchema>, correlationId: string): Promise<'processed' | 'pending' | 'ignored'> {
    if (!event.locationId) return 'ignored'; // INSTALL a nivel agencia: las locations se registran al autorizar el token.
    const installation = await this.prisma.ghlInstallation.findUnique({ where: { ghlLocationId: event.locationId } });
    if (!installation || installation.installationStatus !== 'active') return 'pending';
    if (installation.ghlCompanyId && event.companyId && installation.ghlCompanyId !== event.companyId) return 'ignored';
    await this.prisma.$transaction(tx => this.provisioning.enqueueInTx(tx, { installationId: installation.id, trigger: 'webhook_install', correlationId, onlyIfNoneForGeneration: true }));
    return 'processed';
  }
}
