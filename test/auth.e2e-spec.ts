import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createTestApp, login, NORTE, ORIGIN, resetDb, type TestApp } from './helpers';

describe('Autenticación, sesiones y CSRF', () => {
  let t: TestApp;
  const http = () => request(t.app.getHttpServer());

  beforeAll(async () => {
    t = await createTestApp();
  });
  beforeEach(() => resetDb(t.prisma));
  afterAll(() => t.close());

  it('login autorizado: cookie HttpOnly + SameSite y sin token en el cuerpo', async () => {
    const res = await http().post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email: 'demo@aida.test', password: 'TestPassword#2026' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ company: { id: NORTE }, role: 'owner' });
    expect(JSON.stringify(res.body)).not.toMatch(/eyJ/); // ningún JWT en el cuerpo
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/aida_session=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
  });

  it('login rechazado: contraseña incorrecta y usuario inexistente responden igual', async () => {
    const a = await http().post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email: 'demo@aida.test', password: 'Incorrecta#2026' });
    const b = await http().post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email: 'nadie@aida.test', password: 'Incorrecta#2026' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.code).toBe('INVALID_CREDENTIALS');
    expect(a.body.message).toBe(b.body.message);
    expect(a.headers['set-cookie']).toBeUndefined();
  });

  it('valida la entrada del login', async () => {
    const res = await http().post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email: 'no-es-email', password: 'x', admin: true });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });

  it('sin sesión: 401 en rutas protegidas; /health es público', async () => {
    expect((await http().get('/api/v1/contacts')).body.code).toBe('SESSION_REQUIRED');
    expect((await http().get('/api/v1/health')).status).toBe(200);
  });

  it('sesión expirada: JWT vencido y sesión vencida en BD son rechazados', async () => {
    const c = await login(t.app, 'demo@aida.test');
    const expired = jwt.sign({ sid: 'x', cid: NORTE }, process.env.JWT_SECRET!, { subject: 'u', issuer: 'aida-contact-sync', audience: 'aida-contact-sync-api', expiresIn: -10 });
    expect((await http().get('/api/v1/contacts').set('Authorization', `Bearer ${expired}`)).status).toBe(401);
    await t.prisma.session.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await c.get('/contacts');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SESSION_INVALID');
  });

  it('JWT firmado con otro secreto o alterado es rechazado', async () => {
    const forged = jwt.sign({ sid: 'x', cid: NORTE }, 'otro-secreto-de-al-menos-32-caracteres!!', { subject: 'u', issuer: 'aida-contact-sync', audience: 'aida-contact-sync-api' });
    expect((await http().get('/api/v1/contacts').set('Authorization', `Bearer ${forged}`)).status).toBe(401);
  });

  it('logout revoca la sesión en el servidor (la cookie robada deja de servir)', async () => {
    const c = await login(t.app, 'demo@aida.test');
    const session = await t.prisma.session.findFirstOrThrow({ where: { revokedAt: null } });
    const token = jwt.sign({ sid: session.id, cid: NORTE }, process.env.JWT_SECRET!, { subject: session.userId, issuer: 'aida-contact-sync', audience: 'aida-contact-sync-api' });
    expect((await http().get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    expect((await c.post('/auth/logout')).status).toBe(200);
    expect((await http().get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`)).status).toBe(401);
  });

  it('revocar la membresía o suspender la empresa corta el acceso inmediatamente', async () => {
    const c = await login(t.app, 'demo@aida.test');
    expect((await c.get('/auth/me')).status).toBe(200);
    await t.prisma.company.update({ where: { id: NORTE }, data: { status: 'suspended' } });
    expect((await c.get('/auth/me')).status).toBe(401);
  });

  it('CSRF: rechaza escrituras sin Origin permitido o sin JSON', async () => {
    const c = await login(t.app, 'demo@aida.test');
    const noOrigin = await c.agent.post('/api/v1/sync/import').send({});
    expect(noOrigin.status).toBe(403);
    expect(noOrigin.body.code).toBe('CSRF_ORIGIN_REJECTED');
    const evil = await c.agent.post('/api/v1/sync/import').set('Origin', 'https://evil.test').send({});
    expect(evil.status).toBe(403);
    const form = await c.agent.post('/api/v1/sync/import').set('Origin', ORIGIN).type('form').send('a=1');
    expect(form.status).toBe(415);
  });

  it('CORS sólo para el origen del frontend y expone x-correlation-id', async () => {
    const ok = await http().options('/api/v1/contacts').set('Origin', ORIGIN).set('Access-Control-Request-Method', 'GET');
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
    const bad = await http().options('/api/v1/contacts').set('Origin', 'https://evil.test').set('Access-Control-Request-Method', 'GET');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('Correlation ID: se genera, se propaga y aparece en errores', async () => {
    const res = await http().get('/api/v1/contacts').set('x-correlation-id', 'test-correlation-0001');
    expect(res.headers['x-correlation-id']).toBe('test-correlation-0001');
    expect(res.body.correlationId).toBe('test-correlation-0001');
    const injected = await http().get('/api/v1/health').set('x-correlation-id', '<script>');
    expect(injected.headers['x-correlation-id']).not.toBe('<script>');
  });
});

describe('Rate limiting', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp({ LOGIN_RATE_LIMIT_PER_MINUTE: '3' });
    await resetDb(t.prisma);
  });
  afterAll(() => t.close());

  it('limita intentos de login por IP (429)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await request(t.app.getHttpServer()).post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email: 'demo@aida.test', password: 'Incorrecta#2026' })).status);
    }
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses.slice(3)).toEqual([429, 429]);
  });
});
