import { GhlContactsClient } from '../src/ghl/contacts/ghl-contacts.client';
import { MockGhlContactsClient } from '../src/ghl/contacts/mock-ghl-contacts.client';
import { type Client, createTestApp, login, NORTE, resetDb, type TestApp } from './helpers';

/** Sincronización con el ADAPTADOR SIMULADO (GHL_MODE=mock). */
describe('Sincronización (adaptador simulado)', () => {
  let t: TestApp;
  let c: Client;

  beforeAll(async () => {
    t = await createTestApp({ GHL_MODE: 'mock' });
  });
  beforeEach(async () => {
    await resetDb(t.prisma);
    const mock = t.app.get(GhlContactsClient);
    if (!(mock instanceof MockGhlContactsClient)) throw new Error('se esperaba el adaptador simulado');
    mock.reset();
    c = await login(t.app, 'demo@aida.test');
  });
  afterAll(() => t.close());

  const contactByGhl = (ghlContactId: string) => t.prisma.contact.findUniqueOrThrow({ where: { companyId_ghlContactId: { companyId: NORTE, ghlContactId } } });

  it('importación completa: crea/actualiza por ID GHL y no duplica al repetir', async () => {
    const first = await c.post('/sync/import', {});
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'completed', direction: 'import', totalRecords: 36, successfulRecords: 36, failedRecords: 0 });
    expect(await t.prisma.contact.count({ where: { companyId: NORTE } })).toBe(36);

    const again = await c.post('/sync/import', {});
    expect(again.body.status).toBe('completed');
    expect(again.body.events.every((e: { operation: string }) => e.operation === 'import.unchanged')).toBe(true);
    expect(await t.prisma.contact.count({ where: { companyId: NORTE } })).toBe(36);
  });

  it('Idempotency-Key devuelve el mismo trabajo sin re-ejecutarlo', async () => {
    const a = await c.post('/sync/import', {}, { 'Idempotency-Key': 'same-key-0001' });
    const b = await c.post('/sync/import', {}, { 'Idempotency-Key': 'same-key-0001' });
    expect(b.body.id).toBe(a.body.id);
    expect(await t.prisma.syncJob.count({ where: { companyId: NORTE } })).toBe(1);
    expect((await c.post('/sync/import', {}, { 'Idempotency-Key': 'x' })).status).toBe(400);
  });

  it('impide dos sincronizaciones simultáneas por empresa', async () => {
    await t.prisma.syncJob.create({ data: { companyId: NORTE, direction: 'import', status: 'running', startedAt: new Date() } });
    const res = await c.post('/sync/import', {});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SYNC_IN_PROGRESS');
  });

  it('importación de contactos seleccionados e IDs inexistentes', async () => {
    const remote = await c.get('/integrations/ghl/contacts?limit=10&page=2');
    expect(remote.body.items).toHaveLength(10);
    const ids = remote.body.items.slice(0, 2).map((r: { ghlContactId: string }) => r.ghlContactId);
    const res = await c.post('/sync/import', { ghlContactIds: [...ids, 'no_existe_999'] });
    expect(res.body).toMatchObject({ status: 'partially_failed', successfulRecords: 2, failedRecords: 1 });
    expect(res.body.events.find((e: { ghlContactId: string }) => e.ghlContactId === 'no_existe_999').errorCode).toBe('GHL_NOT_FOUND');
  });

  it('la importación NO sobrescribe cambios locales pendientes', async () => {
    const local = (await t.prisma.contact.findFirstOrThrow({ where: { companyId: NORTE } }));
    await c.patch(`/contacts/${local.id}`, { firstName: 'Cambio local' });
    const res = await c.post('/sync/import', {});
    expect(res.body.status).toBe('partially_failed');
    const ev = res.body.events.find((e: { contactId: string }) => e.contactId === local.id);
    expect(ev).toMatchObject({ operation: 'import.skipped', errorCode: 'LOCAL_CHANGES_PENDING' });
    expect((await t.prisma.contact.findUniqueOrThrow({ where: { id: local.id } })).firstName).toBe('Cambio local');
  });

  it('exportación: vista previa → confirmación → GHL actualizado y contacto synced', async () => {
    const local = await t.prisma.contact.findFirstOrThrow({ where: { companyId: NORTE } });
    await c.patch(`/contacts/${local.id}`, { lastName: 'Exportado' });
    const preview = await c.post('/sync/export/preview', { contactIds: [local.id] });
    expect(preview.body.items[0]).toMatchObject({ conflict: null, changes: [{ field: 'lastName', local: 'Exportado' }] });

    expect((await c.post('/sync/export', { contactIds: [local.id], confirmed: false, previewToken: preview.body.previewToken })).status).toBe(400);
    const res = await c.post('/sync/export', { contactIds: [local.id], confirmed: true, previewToken: preview.body.previewToken });
    expect(res.body).toMatchObject({ status: 'completed', successfulRecords: 1 });
    expect((await contactByGhl(local.ghlContactId)).syncStatus).toBe('synced');

    // El simulador refleja el cambio: una importación posterior no lo revierte (sin bucles).
    const reimport = await c.post('/sync/import', { ghlContactIds: [local.ghlContactId] });
    expect(reimport.body.events[0].operation).toBe('import.unchanged');
    expect((await contactByGhl(local.ghlContactId)).lastName).toBe('Exportado');
  });

  it('la vista previa caduca si el contacto cambia después (PREVIEW_STALE)', async () => {
    const local = await t.prisma.contact.findFirstOrThrow({ where: { companyId: NORTE } });
    await c.patch(`/contacts/${local.id}`, { lastName: 'Uno' });
    const preview = await c.post('/sync/export/preview', { contactIds: [local.id] });
    await c.patch(`/contacts/${local.id}`, { lastName: 'Dos' });
    const res = await c.post('/sync/export', { contactIds: [local.id], confirmed: true, previewToken: preview.body.previewToken });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PREVIEW_STALE');
  });

  it('conflicto: cambio en GHL + cambio local → no se sobrescribe sin decisión de un admin', async () => {
    const local = await t.prisma.contact.findFirstOrThrow({ where: { companyId: NORTE } });
    await c.patch(`/contacts/${local.id}`, { lastName: 'Versión local' });
    await c.post('/integrations/ghl/mock/remote-edit', { ghlContactId: local.ghlContactId });

    const preview = await c.post('/sync/export/preview', { contactIds: [local.id] });
    expect(preview.body.items[0].conflict).toBe('REMOTE_CHANGED');
    expect(preview.body.summary.conflicts).toBe(1);

    const blocked = await c.post('/sync/export', { contactIds: [local.id], confirmed: true, previewToken: preview.body.previewToken });
    expect(blocked.body).toMatchObject({ status: 'failed', failedRecords: 1 });
    expect(blocked.body.events[0].errorCode).toBe('CONFLICT_REMOTE_CHANGED');
    expect((await contactByGhl(local.ghlContactId)).syncStatus).toBe('conflict');

    const editor = await login(t.app, 'editor@aida.test');
    const p2 = await editor.post('/sync/export/preview', { contactIds: [local.id] });
    expect((await editor.post('/sync/export', { contactIds: [local.id], confirmed: true, previewToken: p2.body.previewToken, overwriteConflicts: true })).status).toBe(403);

    const p3 = await c.post('/sync/export/preview', { contactIds: [local.id] });
    const forced = await c.post('/sync/export', { contactIds: [local.id], confirmed: true, previewToken: p3.body.previewToken, overwriteConflicts: true });
    expect(forced.body.status).toBe('completed');
    expect((await contactByGhl(local.ghlContactId)).syncStatus).toBe('synced');
  });

  it('resolver conflicto conservando GHL (overwriteLocalChanges, admin)', async () => {
    const local = await t.prisma.contact.findFirstOrThrow({ where: { companyId: NORTE } });
    await c.patch(`/contacts/${local.id}`, { lastName: 'Local' });
    await c.post('/integrations/ghl/mock/remote-edit', { ghlContactId: local.ghlContactId });
    const res = await c.post('/sync/import', { ghlContactIds: [local.ghlContactId], overwriteLocalChanges: true });
    expect(res.body.events[0].operation).toBe('import.updated');
    const after = await contactByGhl(local.ghlContactId);
    expect(after.syncStatus).toBe('synced');
    expect(after.lastName).toContain('(editado en GHL)');
  });

  it('historial de trabajos paginado y detalle con eventos', async () => {
    await c.post('/sync/import', {});
    const jobs = await c.get('/sync/jobs?limit=5');
    expect(jobs.body.total).toBe(1);
    expect(jobs.body.items[0]).not.toHaveProperty('idempotencyKey');
    const detail = await c.get(`/sync/jobs/${jobs.body.items[0].id}`);
    expect(detail.body.events).toHaveLength(36);
    const summary = await c.get('/companies/current/summary');
    expect(summary.body.contacts).toMatchObject({ total: 36, synced: 36 });
    expect(summary.body.lastSync.status).toBe('completed');
  });

  it('estado de la integración en modo simulado lo declara explícitamente', async () => {
    const res = await c.get('/integrations/ghl/status');
    expect(res.body).toMatchObject({ mode: 'mock', simulated: true, status: 'simulated' });
    const diag = await c.get('/diagnostics');
    expect(diag.body).toMatchObject({ database: { status: 'ok' }, ghl: { mode: 'mock' } });
    expect(diag.body.correlationId).toBe(diag.headers['x-correlation-id']);
  });
});
