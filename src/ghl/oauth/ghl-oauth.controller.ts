import { Controller, Get, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { type AppRequest, CorrelationId, CurrentPrincipal, type Principal, Public, RequireRole } from '../../common/request-context';
import { GhlOAuthService, STATE_TTL_MS } from './ghl-oauth.service';

export const OAUTH_STATE_COOKIE = 'aida_oauth_state';
const OAUTH_COOKIE_PATH = '/api/v1';

@ApiTags('integrations')
@Controller('integrations/ghl')
export class GhlOAuthController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly oauth: GhlOAuthService,
  ) {}

  @Post('oauth/start')
  @HttpCode(200)
  @RequireRole('admin')
  @ApiCookieAuth('aida_session')
  @ApiOperation({ summary: 'Inicia OAuth 2.0 (Authorization Code) con GHL. Devuelve la URL oficial de autorización.' })
  async start(@CurrentPrincipal() p: Principal, @Res({ passthrough: true }) res: Response) {
    const { authorizationUrl, state } = await this.oauth.start(p);
    // Respaldo del state en cookie SameSite=Lax (se envía en la redirección de GHL al callback).
    res.cookie(OAUTH_STATE_COOKIE, state, { httpOnly: true, secure: this.config.cookieSecure, sameSite: 'lax', path: OAUTH_COOKIE_PATH, maxAge: STATE_TTL_MS });
    return { authorizationUrl };
  }

  @Get('oauth/callback')
  @Public()
  @Throttle({ default: { limit: () => Number(process.env.OAUTH_CALLBACK_RATE_LIMIT_PER_MINUTE ?? 20), ttl: 60_000 } })
  @ApiOperation({ summary: 'Redirect URI registrada en GHL. Intercambia el code en el servidor y redirige al frontend.' })
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Req() req: AppRequest,
    @CorrelationId() correlationId: string,
    @Res() res: Response,
  ) {
    const cookieState = typeof req.cookies?.[OAUTH_STATE_COOKIE] === 'string' ? (req.cookies[OAUTH_STATE_COOKIE] as string) : undefined;
    const outcome = await this.oauth.callback({ code: typeof code === 'string' ? code : undefined, queryState: typeof state === 'string' ? state : undefined, cookieState, error: typeof error === 'string' ? error : undefined }, correlationId);
    res.clearCookie(OAUTH_STATE_COOKIE, { path: OAUTH_COOKIE_PATH });
    // Sólo se devuelve un código de resultado: nunca tokens ni el code en la URL del frontend.
    res.redirect(302, `${this.config.frontendOrigins[0]}/integrations?oauth=${outcome}`);
  }

  @Post('disconnect')
  @HttpCode(200)
  @RequireRole('admin')
  @ApiCookieAuth('aida_session')
  @ApiOperation({ summary: 'Elimina las credenciales cifradas y marca la instalación como revocada' })
  async disconnect(@CurrentPrincipal() p: Principal, @CorrelationId() correlationId: string) {
    await this.oauth.disconnect(p, correlationId);
    return { ok: true };
  }
}

@ApiTags('integrations')
@Controller('integrations/oauth')
export class GhlOAuthAliasController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly oauth: GhlOAuthService,
  ) {}

  @Get('callback')
  @Public()
  @Throttle({ default: { limit: () => Number(process.env.OAUTH_CALLBACK_RATE_LIMIT_PER_MINUTE ?? 20), ttl: 60_000 } })
  @ApiOperation({ summary: 'Redirect URI sin la palabra ghl, para poder registrarla en HighLevel.' })
  callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Req() req: AppRequest,
    @CorrelationId() correlationId: string,
    @Res() res: Response,
  ) {
    const cookieState = typeof req.cookies?.[OAUTH_STATE_COOKIE] === 'string' ? (req.cookies[OAUTH_STATE_COOKIE] as string) : undefined;
    return this.oauth.callback({ code: typeof code === 'string' ? code : undefined, queryState: typeof state === 'string' ? state : undefined, cookieState, error: typeof error === 'string' ? error : undefined }, correlationId).then(outcome => {
      res.clearCookie(OAUTH_STATE_COOKIE, { path: OAUTH_COOKIE_PATH });
      res.redirect(302, `${this.config.frontendOrigins[0]}/integrations?oauth=${outcome}`);
    });
  }
}

