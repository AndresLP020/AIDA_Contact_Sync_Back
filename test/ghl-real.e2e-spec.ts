import { generateKeyPairSync, sign } from 'node:crypto';
import request from 'supertest';
import { encryptGhlContextForTests } from '../src/auth/ghl-context';
import { GhlTokenService } from '../src/ghl/tokens/ghl-token.service';
import { FakeGhl } from './fake-ghl';
import { type Client, createTestApp, login, NORTE, ORIGIN, resetDb, SUR, type TestApp } from './helpers';

/**
 * Integración en MODO REAL contra un GHL simulado por HTTP (mismos contratos oficiales).
 * Verifica OAuth, cifrado de tokens, rotación concurrente, reintentos y webhooks sin llamar a GoHighLevel.
 */
const webhookKeys = generateKeyPairSync('ed25519');
const ENV = {
  GHL_MODE: 'real',
  GHL_CLIENT_ID: 'test-client',
  GHL_CLIENT_SECRET: 'test-secret',
  GHL_REDIRECT_URI: 'http://localhost:4100/api/v1/integrations/ghl/oauth/callback',
  GHL_API_BASE: 'https://fake-ghl.test',
  GHL_APP_SHARED_SECRET: 'shared-secret-de-prueba',
  GHL_WEBHOOK_PUBLIC_KEY: webhookKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
};

describe('Integración GHL en modo real (API simulada por HTTP)', () => {
  let t: TestApp;
  let ghl: FakeGhl;
  let owner: Client;
  const responses: string[] = [];

  beforeAll(async () => {
    ghl = new FakeGhl();
    t = await createTestApp(ENV, ghl.fetch);
  });
  beforeEach(async () => {
    await resetDb(t.prisma);
    Object.assign(ghl, new FakeGhl(), { fetch: ghl.fetch });
    ghl.contacts.clear();
    ghl.calls.length = 0;
    ghl.failures.length = 0;
    owner = await login(t.app, 'demo@aida.test');
  });
  afterAll(async () => {
    // Ninguna respuesta de nuestra API debe contener tokens emitidos por GHL ni el client secret.
    const leaked = responses.filter(r => /fake-(access|refresh)-|test-secret|shared-secret-de-prueba/.test(r));
    expect(leaked).toEqual([]);
    await t.close();
  });

  const track = <T extends { body: unknown; headers: Record<string, unknown> }>(res: T) => {
    responses.push(JSON.stringify(res.body) + JSON.stringify(res.headers));
    return res;
  };

  /** Ejecuta el flujo OAuth completo y devuelve la instalación creada. */
  async function connect(client: Client = owner) {
    const start = track(await client.post('/integrations/ghl/oauth/start'));
    expect(start.status).toBe(200);
    const url = new URL(start.body.authorizationUrl);
    const stateCookie = String(start.headers['set-cookie']).match(/aida_oauth_state=([^;]+)/)![1];
    const cb = track(await request(t.app.getHttpServer()).get(`/api/v1/integrations/ghl/oauth/callback?code=valid-code&state=${url.searchParams.get('state')}`).set('Cookie', `aida_oauth_state=${stateCookie}`));
    return { start, url, cb };
  }

  describe('OAuth 2.0', () => {
    it('start genera la URL oficial con client_id, redirect_uri, scopes y state; cookie de respaldo HttpOnly Lax', async () => {
      const { url, start } = await connect();
      expect(url.origin + url.pathname).toBe('https://marketplace.gohighlevel.com/v2/oauth/chooselocation');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('client_id')).toBe('test-client');
      expect(url.searchParams.get('redirect_uri')).toBe(ENV.GHL_REDIRECT_URI);
      expect(url.searchParams.get('scope')).toBe('contacts.readonly contacts.write');
      expect(url.searchParams.get('state')).toMatch(/^[\w-]{40,}$/);
      expect(url.toString()).not.toContain('test-secret');
      expect(String(start.headers['set-cookie'])).toMatch(/HttpOnly.*SameSite=Lax|SameSite=Lax.*HttpOnly/);
    });

    it('callback válido: intercambia el code en el servidor, vincula la location y guarda tokens CIFRADOS', async () => {
      const { cb } = await connect();
      expect(cb.status).toBe(302);
      expect(cb.headers.location).toBe(`${ORIGIN}/integrations?oauth=connected`);
      const exchange = ghl.calls.find(c => c.path === '/oauth/token')!;
      expect(new URLSearchParams(exchange.body).get('grant_type')).toBe('authorization_code');

      const installation = await t.prisma.ghlInstallation.findUniqueOrThrow({ where: { companyId: NORTE }, include: { credential: true } });
      expect(installation).toMatchObject({ ghlLocationId: ghl.locationId, installationStatus: 'active', grantedScopes: ['contacts.readonly', 'contacts.write'] });
      const raw = JSON.stringify(installation.credential);
      expect(raw).not.toMatch(/fake-access-|fake-refresh-/);
      expect(installation.credential!.encryptedAccessToken).toMatch(/^v1\./);

      const status = track(await owner.get('/integrations/ghl/status'));
      expect(status.body).toMatchObject({ mode: 'real', connected: true, locationId: ghl.locationId, credential: { present: true, tokenVersion: 1 } });
      expect(JSON.stringify(status.body)).not.toMatch(/access|refresh/i);
    });

    it('acepta el state sólo por cookie (si GHL no lo devuelve en el callback)', async () => {
      const start = await owner.post('/integrations/ghl/oauth/start');
      const cookie = String(start.headers['set-cookie']).match(/aida_oauth_state=([^;]+)/)![1];
      const cb = await request(t.app.getHttpServer()).get('/api/v1/integrations/ghl/oauth/callback?code=valid-code').set('Cookie', `aida_oauth_state=${cookie}`);
      expect(cb.headers.location).toMatch(/oauth=connected$/);
    });

    it.each([
      ['state inexistente', '?code=valid-code&state=inventado-123456', 'invalid_state'],
      ['sin state', '?code=valid-code', 'invalid_state'],
      ['sin code', '?state=abc', 'invalid_request'],
      ['usuario denegó', '?error=access_denied', 'denied'],
    ])('callback inválido (%s) → %s sin crear instalación', async (_name, query, outcome) => {
      const cb = await request(t.app.getHttpServer()).get(`/api/v1/integrations/ghl/oauth/callback${query}`);
      expect(cb.headers.location).toBe(`${ORIGIN}/integrations?oauth=${outcome}`);
      expect(await t.prisma.ghlInstallation.count()).toBe(0);
    });

    it('state de un solo uso, ligado al navegador y expirable', async () => {
      const start = await owner.post('/integrations/ghl/oauth/start');
      const state = new URL(start.body.authorizationUrl).searchParams.get('state')!;
      const cookie = String(start.headers['set-cookie']).match(/aida_oauth_state=([^;]+)/)![1];
      const mismatch = await request(t.app.getHttpServer()).get(`/api/v1/integrations/ghl/oauth/callback?code=valid-code&state=${state}`).set('Cookie', 'aida_oauth_state=otro-valor');
      expect(mismatch.headers.location).toMatch(/invalid_state$/);
      const ok = await request(t.app.getHttpServer()).get(`/api/v1/integrations/ghl/oauth/callback?code=valid-code&state=${state}`).set('Cookie', `aida_oauth_state=${cookie}`);
      expect(ok.headers.location).toMatch(/connected$/);
      const replay = await request(t.app.getHttpServer()).get(`/api/v1/integrations/ghl/oauth/callback?code=valid-code&state=${state}`).set('Cookie', `aida_oauth_state=${cookie}`);
      expect(replay.headers.location).toMatch(/invalid_state$/);

      const s2 = await owner.post('/integrations/ghl/oauth/start');
      const state2 = new URL(s2.body.authorizationUrl).searchParams.get('state')!;
      await t.prisma.oAuthState.updateMany({ where: { consumedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const expired = await request(t.app.getHttpServer()).get(`/api/v1/integrations/ghl/oauth/callback?code=valid-code&state=${state2}`);
      expect(expired.headers.location).toMatch(/invalid_state$/);
    });

    it('code rechazado por GHL → exchange_failed; respuesta sin locationId → not_location_install', async () => {
      const s = await owner.post('/integrations/ghl/oauth/start');
      const st = new URL(s.body.authorizationUrl).searchParams.get('state');
      const bad = await request(t.app.getHttpServer()).get(`/api/v1/integrations/ghl/oauth/callback?code=codigo-falso&state=${st}`);
      expect(bad.headers.location).toMatch(/exchange_failed$/);
      ghl.tokenResponseOverride = { access_token: 'fake-access-agency-0001', refresh_token: 'fake-refresh-agency-0001', expires_in: 86399, userType: 'Company', companyId: 'agency_1' };
      const { cb } = await connect();
      expect(cb.headers.location).toMatch(/not_location_install$/);
      expect(await t.prisma.ghlInstallation.count()).toBe(0);
    });

    it('una location ya vinculada a otra empresa no se puede reutilizar', async () => {
      await connect();
      const sur = await login(t.app, 'sur@aida.test');
      const { cb } = await connect(sur);
      expect(cb.headers.location).toMatch(/location_already_linked$/);
      expect(await t.prisma.ghlInstallation.count({ where: { companyId: SUR } })).toBe(0);
    });
  });

  describe('Tokens', () => {
    it('token expirado: se renueva, se rota el refresh token (un solo uso) y sube tokenVersion', async () => {
      await connect();
      ghl.seedContacts(3);
      await t.prisma.oAuthCredential.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
      const before = await t.prisma.oAuthCredential.findFirstOrThrow();
      const res = await owner.post('/sync/import', {});
      expect(res.body.status).toBe('completed');
      expect(ghl.refreshCalls).toBe(1);
      const after = await t.prisma.oAuthCredential.findFirstOrThrow();
      expect(after.tokenVersion).toBe(before.tokenVersion + 1);
      expect(after.encryptedRefreshToken).not.toBe(before.encryptedRefreshToken);
    });

    it('renovación concurrente: 6 solicitudes simultáneas producen UNA sola llamada de refresh', async () => {
      await connect();
      await t.prisma.oAuthCredential.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
      ghl.tokenDelayMs = 150;
      const installation = await t.prisma.ghlInstallation.findFirstOrThrow();
      const tokens = t.app.get(GhlTokenService);
      const results = await Promise.all(Array.from({ length: 6 }, () => tokens.getAccessToken(installation.id)));
      expect(ghl.refreshCalls).toBe(1);
      expect(new Set(results.map(r => r.token)).size).toBe(1);
    });

    it('refresh rechazado: instalación en error y operación fallida con código claro', async () => {
      await connect();
      await t.prisma.oAuthCredential.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
      ghl.rejectRefresh = true;
      const res = await owner.post('/sync/import', {});
      expect(res.body).toMatchObject({ status: 'failed', errorCode: 'GHL_REFRESH_REJECTED' });
      expect((await t.prisma.ghlInstallation.findFirstOrThrow()).installationStatus).toBe('error');
      expect((await owner.get('/integrations/ghl/status')).body.connected).toBe(false);
    });

    it('401 inesperado de la API: renueva una vez y reintenta con el token nuevo', async () => {
      await connect();
      ghl.seedContacts(2);
      ghl.validAccessTokens.clear(); // GHL invalidó el token vigente
      const res = await owner.post('/sync/import', {});
      expect(res.body.status).toBe('completed');
      expect(ghl.refreshCalls).toBe(1);
    });
  });

  describe('Cliente de contactos', () => {
    beforeEach(async () => {
      await connect();
    });

    it('importa con paginación de /contacts/search y encabezados oficiales', async () => {
      ghl.seedContacts(150);
      const res = await owner.post('/sync/import', {});
      expect(res.body).toMatchObject({ status: 'completed', successfulRecords: 150 });
      const searches = ghl.calls.filter(c => c.path === '/contacts/search');
      expect(searches).toHaveLength(2);
      expect(JSON.parse(searches[1].body)).toMatchObject({ locationId: ghl.locationId, page: 2, pageLimit: 100 });
      expect(searches[0].headers.version).toBe('2021-07-28');
      expect(await t.prisma.contact.count({ where: { companyId: NORTE, ghlContactId: { startsWith: 'ghl_' } } })).toBe(150);
    });

    it('reintenta 429 y 5xx en lecturas y termina con éxito', async () => {
      ghl.seedContacts(5);
      ghl.failures.push({ match: 'POST /contacts/search', status: 429, headers: { 'retry-after': '1' } }, { match: 'POST /contacts/search', status: 503 });
      const res = await owner.post('/sync/import', {});
      expect(res.body.status).toBe('completed');
      expect(ghl.calls.filter(c => c.path === '/contacts/search')).toHaveLength(3);
    });

    it('429 persistente → trabajo failed con GHL_RATE_LIMITED (no se reporta éxito)', async () => {
      ghl.seedContacts(5);
      for (let i = 0; i < 4; i++) ghl.failures.push({ match: 'POST /contacts/search', status: 429 });
      const res = await owner.post('/sync/import', {});
      expect(res.body).toMatchObject({ status: 'failed', errorCode: 'GHL_RATE_LIMITED', successfulRecords: 0 });
      expect((await owner.get('/diagnostics')).body.lastError.code).toBe('GHL_RATE_LIMITED');
    });

    it('error de conexión → GHL_NETWORK', async () => {
      for (let i = 0; i < 4; i++) ghl.failures.push({ match: 'POST /contacts/search', network: true });
      const res = await owner.post('/sync/import', {});
      expect(res.body).toMatchObject({ status: 'failed', errorCode: 'GHL_NETWORK' });
    });

    it('respuesta con formato inválido o de otra location se descarta', async () => {
      ghl.seedContacts(1);
      ghl.contacts.get('ghl_0001')!.locationId = 'otra_location';
      const res = await owner.post('/sync/import', {});
      expect(res.body).toMatchObject({ status: 'failed', errorCode: 'GHL_FOREIGN_LOCATION' });
      expect(await t.prisma.contact.count({ where: { ghlContactId: 'ghl_0001' } })).toBe(0);
    });

    it('exportación real: PUT sólo con campos cambiados, verifica la respuesta y adopta el formato E.164', async () => {
      ghl.seedContacts(2);
      await owner.post('/sync/import', {});
      const local = await t.prisma.contact.findFirstOrThrow({ where: { ghlContactId: 'ghl_0001' } });
      await owner.patch(`/contacts/${local.id}`, { phone: '+52 55 9999 0000' });
      const preview = await owner.post('/sync/export/preview', { contactIds: [local.id] });
      const res = await owner.post('/sync/export', { contactIds: [local.id], confirmed: true, previewToken: preview.body.previewToken });
      expect(res.body.status).toBe('completed');
      const put = ghl.calls.find(c => c.method === 'PUT')!;
      expect(JSON.parse(put.body)).toEqual({ phone: '+52 55 9999 0000' });
      expect(ghl.contacts.get('ghl_0001')!.phone).toBe('+525599990000');
      expect((await t.prisma.contact.findUniqueOrThrow({ where: { id: local.id } }))).toMatchObject({ phone: '+525599990000', syncStatus: 'synced', origin: 'local' });
    });

    it('conflicto real: si el contacto cambió en GHL no se envía el PUT', async () => {
      ghl.seedContacts(1);
      await owner.post('/sync/import', {});
      const local = await t.prisma.contact.findFirstOrThrow({ where: { ghlContactId: 'ghl_0001' } });
      await owner.patch(`/contacts/${local.id}`, { firstName: 'Local' });
      ghl.editRemotely('ghl_0001', { firstName: 'Remoto' });
      const preview = await owner.post('/sync/export/preview', { contactIds: [local.id] });
      const res = await owner.post('/sync/export', { contactIds: [local.id], confirmed: true, previewToken: preview.body.previewToken });
      expect(res.body.events[0].errorCode).toBe('CONFLICT_REMOTE_CHANGED');
      expect(ghl.calls.some(c => c.method === 'PUT')).toBe(false);
      expect(ghl.contacts.get('ghl_0001')!.firstName).toBe('Remoto');
    });

    it('PUT con 5xx se reintenta (idempotente) sin duplicar', async () => {
      ghl.seedContacts(1);
      await owner.post('/sync/import', {});
      const local = await t.prisma.contact.findFirstOrThrow({ where: { ghlContactId: 'ghl_0001' } });
      await owner.patch(`/contacts/${local.id}`, { lastName: 'Nuevo' });
      const preview = await owner.post('/sync/export/preview', { contactIds: [local.id] });
      ghl.failures.push({ match: 'PUT /contacts/', status: 502 });
      const res = await owner.post('/sync/export', { contactIds: [local.id], confirmed: true, previewToken: preview.body.previewToken });
      expect(res.body.status).toBe('completed');
      expect(ghl.calls.filter(c => c.method === 'PUT')).toHaveLength(2);
      expect(ghl.contacts.size).toBe(1);
    });

    it('lista remota para seleccionar qué importar (marca los ya importados)', async () => {
      ghl.seedContacts(3);
      await owner.post('/sync/import', { ghlContactIds: ['ghl_0002'] });
      const res = track(await owner.get('/integrations/ghl/contacts?limit=10'));
      expect(res.body.items.find((i: { ghlContactId: string }) => i.ghlContactId === 'ghl_0002').localStatus).toBe('synced');
      expect(res.body.items.find((i: { ghlContactId: string }) => i.ghlContactId === 'ghl_0001').localId).toBeNull();
    });
  });

  describe('Desconexión, desinstalación y modo mock deshabilitado', () => {
    const signed = (body: object) => {
      const raw = JSON.stringify(body);
      return { raw, signature: sign(null, Buffer.from(raw), webhookKeys.privateKey).toString('base64') };
    };

    it('webhook UNINSTALL firmado revoca la instalación y borra credenciales; deduplica reintentos', async () => {
      await connect();
      const { raw, signature } = signed({ type: 'UNINSTALL', appId: 'app_1', locationId: ghl.locationId });
      const send = () => request(t.app.getHttpServer()).post('/api/v1/integrations/ghl/webhooks').set('Content-Type', 'application/json').set('x-ghl-signature', signature).send(raw);
      expect((await send()).body).toEqual({ received: true });
      expect((await send()).body).toEqual({ received: true, duplicate: true });
      const inst = await t.prisma.ghlInstallation.findFirstOrThrow({ include: { credential: true } });
      expect(inst.installationStatus).toBe('revoked');
      expect(inst.credential).toBeNull();
      expect((await owner.post('/sync/import', {})).body.code).toBe('GHL_NOT_CONNECTED');
    });

    it('webhook con firma inválida o ausente → 401 y sin cambios', async () => {
      await connect();
      const { raw } = signed({ type: 'UNINSTALL', locationId: ghl.locationId });
      const forged = generateKeyPairSync('ed25519');
      const bad = await request(t.app.getHttpServer()).post('/api/v1/integrations/ghl/webhooks').set('Content-Type', 'application/json').set('x-ghl-signature', sign(null, Buffer.from(raw), forged.privateKey).toString('base64')).send(raw);
      expect(bad.status).toBe(401);
      expect((await request(t.app.getHttpServer()).post('/api/v1/integrations/ghl/webhooks').set('Content-Type', 'application/json').send(raw)).status).toBe(401);
      expect((await t.prisma.ghlInstallation.findFirstOrThrow()).installationStatus).toBe('active');
    });

    it('desconexión manual (admin) elimina credenciales', async () => {
      await connect();
      expect((await owner.post('/integrations/ghl/disconnect')).status).toBe(200);
      expect(await t.prisma.oAuthCredential.count()).toBe(0);
      expect((await owner.get('/integrations/ghl/status')).body).toMatchObject({ connected: false, status: 'revoked' });
    });

    it('el endpoint de simulación no existe en modo real', async () => {
      expect((await owner.post('/integrations/ghl/mock/remote-edit', { ghlContactId: 'x' })).status).toBe(403);
    });
  });

  describe('Acceso incrustado (Custom Page): contexto cifrado → sesión propia', () => {
    const ctx = (over: object = {}) => encryptGhlContextForTests({ userId: 'ghl_user_1', companyId: 'agency_1', role: 'admin', type: 'agency', activeLocation: 'loc_test_123', userName: 'Ana', email: 'demo@aida.test', ...over }, ENV.GHL_APP_SHARED_SECRET);
    const post = (encryptedData: string, locationName?: string) => request(t.app.getHttpServer()).post('/api/v1/auth/ghl-context').set('Origin', ORIGIN).send({ encryptedData, ...(locationName ? { locationName } : {}) });

    it('contexto válido abre la sesión de la subcuenta instalada', async () => {
      await connect();
      const payload = ctx({ type: 'account' });
      const res = await post(payload);
      expect(res.status).toBe(200);
      const cookie = String(res.headers['set-cookie']);
      expect(cookie).toMatch(/aida_session=/);
      const me = await request(t.app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', cookie.split(';')[0]);
      expect(me.body.company.id).toBe(NORTE);
      expect(me.body.user.email).toBe('loc_test_123@subcuenta.aida');
      expect((await t.prisma.user.findUniqueOrThrow({ where: { email: 'demo@aida.test' } })).ghlUserId).toBeNull();
      expect((await post(payload)).status).toBe(200); // HighLevel reenvía el mismo contexto al reabrir la página
    });

    it('una subcuenta instalada entra con su propio usuario, no con el correo de quien abre la página', async () => {
      const company = await t.prisma.company.create({ data: { name: 'Subcuenta nueva', ghlLocationId: 'loc_sin_miembros' } });
      await t.prisma.ghlInstallation.create({ data: { companyId: company.id, ghlLocationId: 'loc_sin_miembros', installationStatus: 'active', grantedScopes: ['contacts.readonly'], installedAt: new Date() } });
      const res = await post(ctx({ type: 'account', activeLocation: 'loc_sin_miembros', email: 'persona@subcuenta.test', userId: 'ghl_persona', userName: 'Persona' }));
      expect(res.status).toBe(200);
      const membership = await t.prisma.membership.findFirstOrThrow({ where: { companyId: company.id, user: { email: 'loc_sin_miembros@subcuenta.aida' } }, include: { user: true } });
      expect(membership.role).toBe('owner');
      expect(membership.user.passwordHash).toBeNull();
      expect(membership.user.displayName).toBe('Subcuenta nueva');
      expect(await t.prisma.user.findUnique({ where: { email: 'persona@subcuenta.test' } })).toBeNull();
    });

    it('usa el nombre de la subcuenta que HighLevel pone en la URL de la Custom Page', async () => {
      const company = await t.prisma.company.create({ data: { name: null, ghlLocationId: 'loc_jazomin' } });
      await t.prisma.ghlInstallation.create({ data: { companyId: company.id, ghlLocationId: 'loc_jazomin', installationStatus: 'active', grantedScopes: ['contacts.readonly'], installedAt: new Date() } });
      const res = await post(ctx({ activeLocation: 'loc_jazomin', userName: 'Andrés' }), 'Jazomin');
      expect(res.status).toBe(200);
      const me = await request(t.app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', String(res.headers['set-cookie']).split(';')[0]);
      expect(me.body.user.displayName).toBe('Jazomin');
      expect(me.body.company.name).toBe('Jazomin');
    });

    it('un administrador de agencia entra como la subcuenta, no con su correo', async () => {
      const company = await t.prisma.company.create({ data: { name: 'San Salvador', ghlLocationId: 'loc_agencia' } });
      await t.prisma.ghlInstallation.create({ data: { companyId: company.id, ghlLocationId: 'loc_agencia', installationStatus: 'active', grantedScopes: ['contacts.readonly'], installedAt: new Date() } });
      const payload = ctx({ activeLocation: 'loc_agencia', email: 'andres@agencia.test', userId: 'ghl_andres', userName: 'Andrés' });
      const res = await post(payload);
      expect(res.status).toBe(200);
      const me = await request(t.app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', String(res.headers['set-cookie']).split(';')[0]);
      expect(me.body.user.email).toBe('loc_agencia@subcuenta.aida');
      expect(me.body.user.displayName).toBe('San Salvador');
      expect(me.body.company.id).toBe(company.id);
      expect(await t.prisma.user.findUnique({ where: { email: 'andres@agencia.test' } })).toBeNull();
      const again = await post(payload);
      expect(again.status).toBe(200);
    });

    it('rechaza location no vinculada, secreto incorrecto y sin subcuenta activa', async () => {
      await connect();
      expect((await post(ctx({ activeLocation: 'otra' }))).status).toBe(401);
      expect((await post(ctx({ activeLocation: 'otra' }))).body.message).toBe('Esta subcuenta no está registrada en AIDA.');
      expect((await post(encryptGhlContextForTests({ userId: 'u', email: 'demo@aida.test', activeLocation: 'loc_test_123' }, 'otro-secreto'))).status).toBe(401);
      expect((await post(ctx({ activeLocation: undefined }))).status).toBe(401);
    });
  });
});
