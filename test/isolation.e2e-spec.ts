import { PrismaClient } from '@prisma/client';
import { type Client, createTestApp, login, NORTE, resetDb, SUR, type TestApp } from './helpers';

describe('Aislamiento multiempresa (IDOR/BOLA), roles y contactos', () => {
  let t: TestApp;
  let norte: Client;
  let sur: Client;
  let norteContactId: string;

  beforeAll(async () => {
    t = await createTestApp();
  });
  beforeEach(async () => {
    await resetDb(t.prisma);
    norte = await login(t.app, 'demo@aida.test');
    sur = await login(t.app, 'sur@aida.test');
    norteContactId = (await t.prisma.contact.findFirstOrThrow({ where: { companyId: NORTE } })).id;
  });
  afterAll(() => t.close());

  it('cada empresa sólo ve sus contactos', async () => {
    const a = await norte.get('/contacts?limit=100');
    const b = await sur.get('/contacts?limit=100');
    expect(a.body.total).toBe(5);
    expect(b.body.total).toBe(3);
    const southIds = new Set(b.body.items.map((c: { id: string }) => c.id));
    expect(a.body.items.some((c: { id: string }) => southIds.has(c.id))).toBe(false);
  });

  it('acceso a un contacto de otra empresa responde 404 (lectura, edición, historial)', async () => {
    expect((await sur.get(`/contacts/${norteContactId}`)).status).toBe(404);
    expect((await sur.get(`/contacts/${norteContactId}/history`)).status).toBe(404);
    expect((await sur.patch(`/contacts/${norteContactId}`, { firstName: 'Hack' })).status).toBe(404);
    const untouched = await t.prisma.contact.findUniqueOrThrow({ where: { id: norteContactId } });
    expect(untouched.firstName).not.toBe('Hack');
  });

  it('no se puede exportar ni previsualizar contactos ajenos', async () => {
    expect((await sur.post('/sync/export/preview', { contactIds: [norteContactId] })).status).toBe(404);
    expect((await sur.post('/sync/export', { contactIds: [norteContactId], confirmed: true, previewToken: '1.ab' })).status).toBe(404);
  });

  it('trabajos y auditoría de otra empresa no son accesibles', async () => {
    const job = await norte.post('/sync/import', {});
    expect((await sur.get(`/sync/jobs/${job.body.id}`)).status).toBe(404);
    expect((await sur.get('/sync/jobs')).body.total).toBe(0);
    const audit = await sur.get('/audit?limit=100');
    expect(audit.body.items.every((a: { action: string }) => a.action !== 'sync.import')).toBe(true);
  });

  it('la empresa sale de la sesión: parámetros companyId/locationId del cliente se rechazan', async () => {
    expect((await sur.get(`/contacts?companyId=${NORTE}`)).status).toBe(400);
    expect((await sur.patch(`/contacts/${(await t.prisma.contact.findFirstOrThrow({ where: { companyId: SUR } })).id}`, { companyId: NORTE })).status).toBe(400);
    expect((await sur.get('/companies/current')).body.id).toBe(SUR);
  });

  it('permisos insuficientes: viewer no puede editar ni sincronizar; editor no puede administrar', async () => {
    const viewer = await login(t.app, 'viewer@aida.test');
    expect((await viewer.get('/contacts')).status).toBe(200);
    const denied = await viewer.patch(`/contacts/${norteContactId}`, { firstName: 'X' });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('INSUFFICIENT_ROLE');
    expect((await viewer.post('/sync/import', {})).status).toBe(403);
    const editor = await login(t.app, 'editor@aida.test');
    expect((await editor.patch(`/contacts/${norteContactId}`, { firstName: 'Editado' })).status).toBe(200);
    expect((await editor.get('/audit')).status).toBe(403);
    expect((await editor.post('/integrations/ghl/oauth/start')).status).toBe(403);
    expect((await editor.post('/sync/import', { overwriteLocalChanges: true })).status).toBe(403);
  });

  it('paginación, búsqueda y filtro por estado', async () => {
    const p1 = await norte.get('/contacts?limit=2&page=1&sort=lastName');
    const p3 = await norte.get('/contacts?limit=2&page=3&sort=lastName');
    expect(p1.body).toMatchObject({ page: 1, limit: 2, total: 5, pages: 3 });
    expect(p1.body.items).toHaveLength(2);
    expect(p3.body.items).toHaveLength(1);
    const first = p1.body.items[0];
    expect((await norte.get(`/contacts?q=${encodeURIComponent(first.email)}`)).body.items[0].id).toBe(first.id);
    await norte.patch(`/contacts/${first.id}`, { lastName: 'Cambiado' });
    const pending = await norte.get('/contacts?status=pending');
    expect(pending.body.items.map((c: { id: string }) => c.id)).toEqual([first.id]);
    expect((await norte.get('/contacts?status=hackeado')).status).toBe(400);
    expect((await norte.get('/contacts?limit=1000')).status).toBe(400);
  });

  it('edición: sólo campos autorizados, validación, normalización y estado pending', async () => {
    const res = await norte.patch(`/contacts/${norteContactId}`, { email: ' NUEVO@Example.TEST ', phone: '' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: 'nuevo@example.test', phone: null, syncStatus: 'pending' });
    expect((await norte.patch(`/contacts/${norteContactId}`, { email: 'no-email' })).status).toBe(400);
    expect((await norte.patch(`/contacts/${norteContactId}`, { syncStatus: 'synced' })).status).toBe(400);
    expect((await norte.patch(`/contacts/${norteContactId}`, { ghlContactId: 'otro' })).status).toBe(400);
    expect((await norte.get('/contacts/no-es-uuid')).status).toBe(400);
  });

  it('conflicto de edición local: expectedUpdatedAt desactualizado → 409', async () => {
    const before = (await norte.get(`/contacts/${norteContactId}`)).body;
    await norte.patch(`/contacts/${norteContactId}`, { firstName: 'Primero' });
    const stale = await norte.patch(`/contacts/${norteContactId}`, { firstName: 'Segundo', expectedUpdatedAt: before.updatedAt });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_CONTACT');
  });

  it('persistencia: los cambios se leen desde otra conexión a PostgreSQL', async () => {
    await norte.patch(`/contacts/${norteContactId}`, { firstName: 'Persistido' });
    const other = new PrismaClient();
    try {
      expect((await other.contact.findUniqueOrThrow({ where: { id: norteContactId } })).firstName).toBe('Persistido');
    } finally {
      await other.$disconnect();
    }
  });

  it('auditoría registra la edición con nombres de campo, sin valores personales', async () => {
    await norte.patch(`/contacts/${norteContactId}`, { email: 'privado@example.test' });
    const audit = await norte.get('/audit?action=contact.updated');
    expect(audit.body.items[0]).toMatchObject({ action: 'contact.updated', resourceId: norteContactId, metadata: { fields: ['email'] } });
    expect(JSON.stringify(audit.body)).not.toContain('privado@example.test');
  });
});
