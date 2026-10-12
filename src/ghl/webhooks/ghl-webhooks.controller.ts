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
import { verifyGhlSignature } from './webhook-signature';

const eventSchema = z.object({ type: z.string().max(64), appId: z.string().max(128).optional(), locationId: z.string().max(128).optional(), companyId: z.string().max(128).optional() });

/** Webhooks de la app Marketplace (Build > Advanced Settings > Webhooks). Hoy se procesa UNINSTALL. */
@ApiExcludeController()
@Controller('integrations/ghl/webhooks')
export class GhlWebhooksController {
  private readonly logger = new Logger('GhlWebhooks');

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly prisma: PrismaService,
    private readonly oauth: GhlOAuthService,
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

    // GHL reintenta hasta 12 veces: se deduplica por hash del cuerpo firmado.
    try {
      await this.prisma.ghlWebhookEvent.create({ data: { bodyHash: createHash('sha256').update(raw).digest('hex'), type: event.type, locationId: event.locationId ?? null } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return { received: true, duplicate: true };
      throw e;
    }

    if (event.type === 'UNINSTALL' && event.locationId) {
      const revoked = await this.oauth.handleUninstall(event.locationId);
      this.logger.log({ msg: 'ghl_uninstall_processed', revoked, correlationId: req.correlationId });
    }
    return { received: true };
  }
}
