import { generateKeyPairSync, sign } from 'node:crypto';
import request from 'supertest';
import { APP_CONFIG, type AppConfig } from '../src/config/app-config';
import { GhlProvisioningClient, MockGhlProvisioningClient } from '../src/ghl/provisioning/ghl-provisioning.client';
import { INTEGRATION_VERSION, RESOURCE_KEYS } from '../src/ghl/provisioning/provisioning.manifest';
import { ProvisioningRunner } from '../src/ghl/provisioning/provisioning.runner';
import { ProvisioningWorker } from '../src/ghl/provisioning/provisioning.worker';
import { GhlTokenService } from '../src/ghl/tokens/ghl-token.service';
import { FakeGhl, FULL_SCOPE } from './fake-ghl';
import { type Client, createTestApp, login, NORTE, ORIGIN, resetDb, type TestApp } from './helpers';

/**
 * Configuración automática de subcuentas (aprovisionamiento) en MODO REAL contra un GHL simulado por HTTP.
 * Ninguna prueba contacta a GoHighLevel real.
 */
const webhookKeys = generateKeyPairSync('ed25519');
const ENV = {
  GHL_MODE: 'real',
  GHL_CLIENT_ID: 'test-client',
  GHL_CLIENT_SECRET: 'test-secret',
  GHL_REDIRECT_URI: 'http://localhost:4100/api/v1/integrations/ghl/oauth/callback',
  GHL_API_BASE: 'https://fake-ghl.test',
  GHL_APP_ID: 'app_1',
  GHL_MARKETPLACE_INSTALL_ENABLED: 'true',
  GHL_WEBHOOK_PUBLIC_KEY: webhookKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
};
const LOC = 'loc_test_123';
const FIELD_NAMES = ['AIDA - ID externo', 'AIDA - Estado de sincronización'];

describe('Configuración automática de subcuentas (GHL simulado por HTTP)', () => {
  let t: TestApp;
  let ghl: FakeGhl;
  let worker: ProvisioningWorker;
  let runner: ProvisioningRunner;
  const responses: string[] = [];

  beforeAll(async () => {
    ghl = new FakeGhl();
    t = await createTestApp(ENV, ghl.fetch);
    worker = t.app.get(ProvisioningWorker);
    runner = t.app.get(ProvisioningRunner);
  });
  beforeEach(async () => {
    await resetDb(t.prisma);
    Object.assign(ghl, new FakeGhl(), { fetch: ghl.fetch });
    ghl.scope = FULL_SCOPE;
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    const leaked = responses.filter(r => /fake-(access|refresh)-|test-secret/.test(r));
    expect(leaked).toEqual([]);
    await t.close();
  });

  const http = () => request(t.app.getHttpServer());
  const track = <T extends { body: unknown; headers: Record<string, unknown> }>(res: T) => {
    responses.push(JSON.stringify(res.body) + JSON.stringify(res.headers));
    return res;
  };
  /** Instalación iniciada desde Marketplace: callback SIN state. */
  const marketplaceInstall = async (code = 'valid-code') => track(await http().get(`/api/v1/integrations/ghl/oauth/callback?code=${code}`)).headers.location as string;
  /** Flujo iniciado desde Contact Sync (state + cookie). */
  async function connect(client: Client) {
    const start = await client.post('/integrations/ghl/oauth/start');
    const state = new URL(start.body.authorizationUrl).searchParams.get('state');
    const cookie = String(start.headers['set-cookie']).match(/aida_oauth_state=([^;]+)/)![1];
    return track(await http().get(`/api/v1/integrations/ghl/oauth/callback?code=valid-code&state=${state}`).set('Cookie', `aida_oauth_state=${cookie}`)).headers.location as string;
  }
  const makeDue = () => t.prisma.provisioningExecution.updateMany({ where: { status: 'pending' }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
  const installationOf = (loc = LOC) => t.prisma.ghlInstallation.findUniqueOrThrow({ where: { ghlLocationId: loc } });
  const lastExecution = async (loc = LOC) => t.prisma.provisioningExecution.findFirstOrThrow({ where: { ghlLocationId: loc }, orderBy: { createdAt: 'desc' }, include: { steps: true } });
  const resources = (loc = LOC) => t.prisma.provisionedResource.findMany({ where: { ghlLocationId: loc } });
  const signedWebhook = (body: object) => {
    const raw = JSON.stringify(body);
    return http().post('/api/v1/integrations/ghl/webhooks').set('Content-Type', 'application/json').set('x-ghl-signature', sign(null, Buffer.from(raw), webhookKeys.privateKey).toString('base64')).send(raw);
  };
  const remoteCalls = () => ghl.calls.filter(c => c.path.startsWith('/locations/'));

  // ─── 1. Locación autorizada sin registro local ───
  it('1. instalación desde Marketplace crea la empresa local, la instalación y configura 2 campos + 2 valores', async () => {
    const companiesBefore = await t.prisma.company.count();
    expect(await marketplaceInstall()).toBe(`${ORIGIN}/integrations?oauth=installed`);

    const inst = await installationOf();
    expect(inst).toMatchObject({ installationStatus: 'active', installSource: 'marketplace', ghlCompanyId: 'agency_1', generation: 1, configurationStatus: 'pending' });
    const company = await t.prisma.company.findUniqueOrThrow({ where: { id: inst.companyId } });
    expect(company.ghlLocationId).toBe(LOC);
    expect(company.name).toBeNull(); // sin locations.readonly no se inventa un nombre
    expect(await t.prisma.company.count()).toBe(companiesBefore + 1);
    // Crear el registro NO concede acceso a nadie.
    expect(await t.prisma.membership.count({ where: { companyId: company.id } })).toBe(0);
    expect((await t.prisma.oAuthCredential.findUniqueOrThrow({ where: { installationId: inst.id } })).encryptedAccessToken).toMatch(/^v1\./);
    expect(await t.prisma.provisioningExecution.count({ where: { status: 'pending' } })).toBe(1);

    await worker.drain();
    const exec = await lastExecution();
    expect(exec.status).toBe('ready');
    expect(exec.steps.every(s => s.status === 'succeeded' && s.outcome === 'created')).toBe(true);
    expect((await installationOf()).configurationStatus).toBe('ready');
    expect(ghl.fieldsOf(LOC).map(f => f.name).sort()).toEqual([...FIELD_NAMES].sort());
    expect(ghl.fieldsOf(LOC).every(f => f.dataType === 'TEXT' && f.model === 'contact')).toBe(true);
    expect(Object.fromEntries(ghl.valuesOf(LOC).map(v => [v.name, v.value]))).toEqual({ 'AIDA - Versión de integración': INTEGRATION_VERSION, 'AIDA - Estado de configuración': 'ready' });
    const rows = await resources();
    expect(rows).toHaveLength(4);
    expect(rows.every(r => r.status === 'active' && r.origin === 'created' && r.remoteId && r.manifestVersion === 1)).toBe(true);
    // Encabezado Version oficial en todas las llamadas de configuración.
    expect(remoteCalls().every(c => c.headers.version === '2021-07-28')).toBe(true);
  });

  it('1b. con locations.readonly concedido el nombre se obtiene de GHL (fuente verificada)', async () => {
    ghl.scope = `${FULL_SCOPE} locations.readonly`;
    ghl.locationNames.set(LOC, 'Clínica Demo');
    await marketplaceInstall();
    expect((await t.prisma.company.findUniqueOrThrow({ where: { ghlLocationId: LOC } })).name).toBe('Clínica Demo');
  });

  it('1c. con GHL_MARKETPLACE_INSTALL_ENABLED=false un callback sin state sigue siendo invalid_state', async () => {
    const config = t.app.get<AppConfig>(APP_CONFIG);
    config.ghl.marketplaceInstallEnabled = false;
    try {
      expect(await marketplaceInstall()).toMatch(/oauth=invalid_state$/);
      expect(await t.prisma.ghlInstallation.count()).toBe(0);
      expect(ghl.calls.some(c => c.path === '/oauth/token')).toBe(false);
    } finally {
      config.ghl.marketplaceInstallEnabled = true;
    }
  });

  // ─── 2. Locación existente ───
  it('2. location ya representada localmente: se reutiliza la empresa sin tocar contactos ni historial', async () => {
    const owner = await login(t.app, 'demo@aida.test');
    expect(await connect(owner)).toMatch(/oauth=connected$/);
    const contactsBefore = await t.prisma.contact.count({ where: { companyId: NORTE } });
    await worker.drain();
    expect((await installationOf()).companyId).toBe(NORTE);

    const companies = await t.prisma.company.count();
    expect(await marketplaceInstall()).toMatch(/oauth=installed$/);
    expect(await t.prisma.company.count()).toBe(companies);
    const inst = await installationOf();
    expect(inst).toMatchObject({ companyId: NORTE, generation: 1, installationStatus: 'active' });
    expect(await t.prisma.contact.count({ where: { companyId: NORTE } })).toBe(contactsBefore);
    // Las membresías existentes no cambian.
    expect(await t.prisma.membership.count({ where: { companyId: NORTE } })).toBe(3);

    const status = track(await owner.get('/integrations/ghl/provisioning'));
    expect(status.body).toMatchObject({ manifestVersion: 1, installation: { locationId: LOC, status: 'active' } });
  });

  // ─── 3. Instalación repetida ───
  it('3. instalaciones repetidas no duplican empresa, instalación, ejecuciones activas ni recursos', async () => {
    await marketplaceInstall();
    await marketplaceInstall(); // segunda llegada con la ejecución aún pendiente: se reutiliza
    expect(await t.prisma.company.count({ where: { ghlLocationId: LOC } })).toBe(1);
    expect(await t.prisma.provisioningExecution.count()).toBe(1);
    await worker.drain();
    await marketplaceInstall(); // tras "ready": nueva verificación idempotente
    await worker.drain();
    expect(await t.prisma.provisioningExecution.count()).toBe(2);
    const exec = await lastExecution();
    expect(exec.status).toBe('ready');
    expect(exec.steps.map(s => s.outcome).sort()).toEqual(['verified', 'verified', 'verified', 'verified']);
    expect(ghl.fieldsOf(LOC)).toHaveLength(2);
    expect(ghl.valuesOf(LOC)).toHaveLength(2);
    expect(await t.prisma.provisionedResource.count()).toBe(4);
  });

  // ─── 4. Callback y webhook duplicados o fuera de orden ───
  it('4. INSTALL antes del token queda pendiente; el callback converge en una sola ejecución; duplicados y eventos viejos no reactivan', async () => {
    const install = { type: 'INSTALL', appId: 'app_1', locationId: LOC, companyId: 'agency_1', userId: 'u1' };
    expect((await signedWebhook(install)).body).toEqual({ received: true });
    expect(await t.prisma.ghlInstallation.count()).toBe(0); // un webhook no concede acceso
    expect((await t.prisma.ghlWebhookEvent.findFirstOrThrow()).processingStatus).toBe('pending');
    expect((await signedWebhook(install)).body).toEqual({ received: true, duplicate: true });

    await marketplaceInstall();
    expect((await t.prisma.ghlWebhookEvent.findFirstOrThrow()).processingStatus).toBe('processed');
    expect(await t.prisma.provisioningExecution.count()).toBe(1);

    // INSTALL posterior (reintento con otro cuerpo): no crea otra ejecución para la misma generación.
    await signedWebhook({ ...install, userId: 'u2' });
    await worker.drain();
    expect(await t.prisma.provisioningExecution.count()).toBe(1);

    // UNINSTALL y luego un INSTALL atrasado: la baja se mantiene.
    await signedWebhook({ type: 'UNINSTALL', appId: 'app_1', locationId: LOC });
    await signedWebhook({ ...install, userId: 'u3' });
    expect((await installationOf()).installationStatus).toBe('revoked');
    expect(await t.prisma.provisioningExecution.count({ where: { status: { in: ['pending', 'running'] } } })).toBe(0);
  });

  // ─── 5. Ejecuciones concurrentes ───
  it('5. dos reintentos simultáneos y dos trabajadores simultáneos: una sola ejecución activa y un solo reclamo', async () => {
    const owner = await login(t.app, 'demo@aida.test');
    await connect(owner);
    await worker.drain();
    const [a, b, c] = await Promise.all([owner.post('/integrations/ghl/provisioning/retry'), owner.post('/integrations/ghl/provisioning/retry'), owner.post('/integrations/ghl/provisioning/retry')]);
    expect([a.status, b.status, c.status]).toEqual([202, 202, 202]);
    expect(new Set([a.body.executionId, b.body.executionId, c.body.executionId]).size).toBe(1);
    expect(await t.prisma.provisioningExecution.count({ where: { status: { in: ['pending', 'running'] } } })).toBe(1);
    const claims = await Promise.all([worker.claimNext(), worker.claimNext(), worker.claimNext()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  // ─── 6. Token expirado y renovación ───
  it('6. token expirado durante la configuración: se renueva una vez y la configuración termina', async () => {
    await marketplaceInstall();
    await t.prisma.oAuthCredential.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await worker.drain();
    expect(ghl.refreshCalls).toBe(1);
    expect((await lastExecution()).status).toBe('ready');
  });

  // ─── 7. Scopes insuficientes ───
  it('7. sin scopes de aprovisionamiento: requires_action con permisos faltantes; la sincronización sigue funcionando; reautorizar lo resuelve', async () => {
    ghl.scope = 'contacts.readonly contacts.write';
    ghl.seedContacts(2);
    const owner = await login(t.app, 'demo@aida.test');
    expect(await connect(owner)).toMatch(/oauth=connected$/);
    await worker.drain();
    const exec = await lastExecution();
    expect(exec).toMatchObject({ status: 'requires_action', lastErrorCode: 'MISSING_SCOPES' });
    expect(exec.missingScopes.sort()).toEqual(['locations/customFields.readonly', 'locations/customFields.write', 'locations/customValues.readonly', 'locations/customValues.write']);
    expect(remoteCalls()).toHaveLength(0);
    const status = track(await owner.get('/integrations/ghl/provisioning'));
    expect(status.body).toMatchObject({ configurationStatus: 'requires_action', canRetry: true });
    expect(status.body.missingScopes).toHaveLength(4);
    // La conexión y la sincronización existentes no se rompen.
    expect((await owner.get('/integrations/ghl/status')).body.connected).toBe(true);
    expect((await owner.post('/sync/import', {})).body.status).toBe('completed');
    // Renovar el token NO concede scopes nuevos; sólo una nueva autorización.
    await t.prisma.oAuthCredential.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    await owner.post('/integrations/ghl/provisioning/retry');
    await worker.drain();
    expect((await lastExecution()).status).toBe('requires_action');
    ghl.scope = FULL_SCOPE;
    await connect(owner);
    await worker.drain();
    expect((await lastExecution()).status).toBe('ready');
  });

  // ─── 8. Recurso preexistente compatible ───
  it('8. recursos preexistentes compatibles se adoptan sin duplicar y sin sobrescribir el valor ajeno', async () => {
    const pre = ghl.addField(LOC, 'AIDA - ID externo');
    const preValue = ghl.addValue(LOC, 'AIDA - Versión de integración', 'valor del cliente');
    await marketplaceInstall();
    await worker.drain();
    const exec = await lastExecution();
    expect(exec.status).toBe('ready');
    expect(ghl.fieldsOf(LOC).filter(f => f.name === 'AIDA - ID externo')).toHaveLength(1);
    const rows = await resources();
    expect(rows.find(r => r.resourceKey === RESOURCE_KEYS.externalId)).toMatchObject({ remoteId: pre.id, origin: 'adopted', status: 'active' });
    expect(rows.find(r => r.resourceKey === RESOURCE_KEYS.integrationVersion)).toMatchObject({ remoteId: preValue.id, origin: 'adopted' });
    expect(exec.steps.find(s => s.resourceKey === RESOURCE_KEYS.integrationVersion)!.outcome).toBe('adopted_unmanaged');
    expect(ghl.values.get(preValue.id)!.value).toBe('valor del cliente');
  });

  // ─── 9. Recurso incompatible ───
  it('9. nombre coincidente con tipo incompatible: conflicto, requires_action y sin crear un duplicado', async () => {
    ghl.addField(LOC, 'AIDA - Estado de sincronización', 'NUMERICAL');
    await marketplaceInstall();
    await worker.drain();
    const exec = await lastExecution();
    expect(exec.status).toBe('requires_action');
    const step = exec.steps.find(s => s.resourceKey === RESOURCE_KEYS.syncStatus)!;
    expect(step).toMatchObject({ status: 'requires_action', outcome: 'conflict_incompatible_type', errorCode: 'INCOMPATIBLE_TYPE' });
    expect(ghl.fieldsOf(LOC).filter(f => f.name === 'AIDA - Estado de sincronización')).toHaveLength(1);
    // Los demás recursos sí se configuran y el valor informativo refleja requires_action.
    expect(ghl.fieldsOf(LOC).some(f => f.name === 'AIDA - ID externo')).toBe(true);
    expect(ghl.valuesOf(LOC).find(v => v.name === 'AIDA - Estado de configuración')!.value).toBe('requires_action');
    expect((await installationOf()).configurationStatus).toBe('requires_action');
  });

  // ─── 10. Recurso renombrado con ID conocido ───
  it('10. un campo renombrado por el cliente se conserva por ID y no se duplica', async () => {
    const owner = await login(t.app, 'demo@aida.test');
    await connect(owner);
    await worker.drain();
    const field = ghl.fieldsOf(LOC).find(f => f.name === 'AIDA - ID externo')!;
    field.name = 'ID AIDA (renombrado)';
    await owner.post('/integrations/ghl/provisioning/retry');
    await worker.drain();
    const exec = await lastExecution();
    expect(exec.status).toBe('ready');
    expect(exec.steps.find(s => s.resourceKey === RESOURCE_KEYS.externalId)!.outcome).toBe('verified_renamed');
    expect(ghl.fieldsOf(LOC)).toHaveLength(2);
    expect(field.name).toBe('ID AIDA (renombrado)'); // la app no revierte el nombre
  });

  // ─── 11. Coincidencias ambiguas ───
  it('11. varias coincidencias posibles: no se elige arbitrariamente', async () => {
    ghl.addField(LOC, 'AIDA - ID externo');
    ghl.addField(LOC, 'aida - id externo ');
    await marketplaceInstall();
    await worker.drain();
    const exec = await lastExecution();
    expect(exec.steps.find(s => s.resourceKey === RESOURCE_KEYS.externalId)).toMatchObject({ status: 'requires_action', outcome: 'ambiguous_match' });
    expect(ghl.fieldsOf(LOC).filter(f => f.name.toLowerCase().trim() === 'aida - id externo')).toHaveLength(2);
    expect((await resources()).find(r => r.resourceKey === RESOURCE_KEYS.externalId)!.remoteId).toBeNull();
  });

  // ─── 12. Timeout después de creación remota ───
  it('12. POST con respuesta perdida: no se repite de inmediato, se reconcilia consultando GHL y no se duplica', async () => {
    await marketplaceInstall();
    ghl.failures.push({ match: `POST /locations/${LOC}/customFields`, network: true, commitThenFail: true });
    await worker.drain();
    let exec = await lastExecution();
    expect(exec).toMatchObject({ status: 'pending', lastErrorCode: 'GHL_NETWORK' });
    expect(exec.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000); // no se repite de inmediato
    expect(exec.steps.find(s => s.resourceKey === RESOURCE_KEYS.externalId)).toMatchObject({ status: 'ambiguous', outcome: 'pending_reconciliation' });
    expect((await resources()).find(r => r.resourceKey === RESOURCE_KEYS.externalId)).toMatchObject({ status: 'pending_reconciliation', ambiguousCount: 1 });
    expect(ghl.calls.filter(c => c.method === 'POST' && c.path.endsWith('/customFields'))).toHaveLength(1);

    await makeDue();
    await worker.drain();
    exec = await lastExecution();
    expect(exec.status).toBe('ready');
    expect(exec.steps.find(s => s.resourceKey === RESOURCE_KEYS.externalId)!.outcome).toBe('reconciled_created');
    expect(ghl.fieldsOf(LOC).filter(f => f.name === 'AIDA - ID externo')).toHaveLength(1);
    expect((await resources()).find(r => r.resourceKey === RESOURCE_KEYS.externalId)).toMatchObject({ origin: 'created', status: 'active', ambiguousCount: 0 });
  });

  // ─── 13. Fallo al guardar el ID remoto ───
  it('13. si falla el guardado local del ID remoto, la siguiente ejecución lo recupera sin duplicar', async () => {
    await marketplaceInstall();
    const original = runner.saveResource.bind(runner);
    let failed = false;
    jest.spyOn(runner, 'saveResource').mockImplementation(async (ctx, spec, data) => {
      if (!failed && spec.resourceKey === RESOURCE_KEYS.syncStatus && typeof data.remoteId === 'string') {
        failed = true;
        throw new (await import('@prisma/client')).Prisma.PrismaClientKnownRequestError('simulado', { code: 'P1001', clientVersion: 'test' });
      }
      return original(ctx, spec, data);
    });
    await worker.drain();
    expect((await lastExecution())).toMatchObject({ status: 'pending', lastErrorCode: 'DB_WRITE_FAILED' });
    expect((await resources()).find(r => r.resourceKey === RESOURCE_KEYS.syncStatus)).toMatchObject({ status: 'creating', remoteId: null });
    await makeDue();
    await worker.drain();
    const exec = await lastExecution();
    expect(exec.status).toBe('ready');
    expect(exec.steps.find(s => s.resourceKey === RESOURCE_KEYS.syncStatus)!.outcome).toBe('reconciled_created');
    expect(ghl.fieldsOf(LOC).filter(f => f.name === 'AIDA - Estado de sincronización')).toHaveLength(1);
  });

  // ─── 14 y 15. Reinicio y bloqueo vencido ───
  it('14-15. reinicio durante la configuración: el lease vigente bloquea, al vencer se recupera y el trabajador obsoleto no escribe', async () => {
    await marketplaceInstall();
    const first = await worker.claimNext(); // trabajador que "muere" sin terminar
    expect(first).not.toBeNull();
    expect(await worker.drain()).toBe(0); // lease vigente: nadie más la toma
    await t.prisma.provisioningExecution.updateMany({ where: { id: first!.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    const second = await worker.claimNext();
    expect(second).toEqual({ id: first!.id, leaseToken: first!.leaseToken + 1 });
    // El trabajador obsoleto (lease anterior) se detiene sin llamadas remotas ni escrituras.
    const callsBefore = remoteCalls().length;
    expect(await runner.run(first!.id, first!.leaseToken)).toBe('lost');
    expect(remoteCalls()).toHaveLength(callsBefore);
    expect(await runner.run(second!.id, second!.leaseToken)).toBe('ready');
    expect((await lastExecution()).attempts).toBe(2);
  });

  // ─── 16. Desinstalación con trabajos pendientes ───
  it('16. desinstalar cancela trabajos pendientes y en curso, invalida credenciales y no borra datos', async () => {
    const owner = await login(t.app, 'demo@aida.test');
    await connect(owner);
    await worker.drain();
    const fieldsBefore = ghl.fieldsOf(LOC).length;
    const contactsBefore = await t.prisma.contact.count({ where: { companyId: NORTE } });
    await owner.post('/integrations/ghl/provisioning/retry');
    const claimed = await worker.claimNext(); // en curso al llegar la baja

    await signedWebhook({ type: 'UNINSTALL', appId: 'app_1', locationId: LOC });
    const inst = await installationOf();
    expect(inst).toMatchObject({ installationStatus: 'revoked', configurationStatus: 'cancelled' });
    expect(await t.prisma.oAuthCredential.count()).toBe(0);
    expect((await t.prisma.provisioningExecution.findUniqueOrThrow({ where: { id: claimed!.id } }))).toMatchObject({ status: 'cancelled', lastErrorCode: 'INSTALLATION_REVOKED' });

    const callsBefore = remoteCalls().length;
    expect(await runner.run(claimed!.id, claimed!.leaseToken)).toBe('lost');
    expect(await worker.drain()).toBe(0);
    expect(remoteCalls()).toHaveLength(callsBefore);
    // No se borran recursos remotos, registros ni contactos.
    expect(ghl.fieldsOf(LOC)).toHaveLength(fieldsBefore);
    expect(await t.prisma.provisionedResource.count()).toBe(4);
    expect(await t.prisma.contact.count({ where: { companyId: NORTE } })).toBe(contactsBefore);
    expect((await owner.post('/integrations/ghl/provisioning/retry')).status).toBe(409);
  });

  // ─── 17. Reinstalación con trabajos antiguos ───
  it('17. reinstalación: nueva generación, trabajos antiguos bloqueados y recursos recuperados por ID', async () => {
    await marketplaceInstall();
    await worker.drain();
    const firstIds = (await resources()).map(r => r.remoteId).sort();
    await signedWebhook({ type: 'UNINSTALL', appId: 'app_1', locationId: LOC });
    // Trabajo "fantasma" de la generación 1 (p. ej. encolado justo antes de la baja).
    const inst1 = await installationOf();
    const ghost = await t.prisma.provisioningExecution.create({ data: { installationId: inst1.id, installationGeneration: 1, companyId: inst1.companyId, ghlLocationId: LOC, manifestVersion: 1, trigger: 'user_retry', correlationId: 'ghost' } });

    expect(await marketplaceInstall()).toMatch(/oauth=installed$/);
    const inst2 = await installationOf();
    expect(inst2).toMatchObject({ generation: 2, installationStatus: 'active', companyId: inst1.companyId });
    expect((await t.prisma.provisioningExecution.findUniqueOrThrow({ where: { id: ghost.id } }))).toMatchObject({ status: 'cancelled', lastErrorCode: 'STALE_GENERATION' });

    await worker.drain();
    const exec = await lastExecution();
    expect(exec).toMatchObject({ status: 'ready', installationGeneration: 2 });
    expect(exec.steps.every(s => s.outcome === 'verified')).toBe(true);
    expect((await resources()).map(r => r.remoteId).sort()).toEqual(firstIds);
    expect(ghl.fieldsOf(LOC)).toHaveLength(2);
  });

  // ─── 18. Aislamiento entre locaciones y agencias ───
  it('18. locations aisladas: IDs propios por location; otra agencia no puede reasignar una location', async () => {
    ghl.codeLocations.set('code-b', { locationId: 'loc_b' });
    await marketplaceInstall();
    await marketplaceInstall('code-b');
    await worker.drain();
    const a = await resources(LOC);
    const b = await resources('loc_b');
    expect(a).toHaveLength(4);
    expect(b).toHaveLength(4);
    expect(a.some(r => b.some(x => x.remoteId === r.remoteId))).toBe(false);
    expect(ghl.fieldsOf('loc_b')).toHaveLength(2);
    expect(new Set(a.map(r => r.companyId)).size).toBe(1);
    expect(a[0].companyId).not.toBe(b[0].companyId);

    ghl.codeLocations.set('code-other-agency', { locationId: LOC, companyId: 'agency_2' });
    expect(await marketplaceInstall('code-other-agency')).toMatch(/oauth=agency_conflict$/);
    expect((await installationOf()).ghlCompanyId).toBe('agency_1');
    expect(await t.prisma.auditLog.count({ where: { action: 'ghl.install_conflict' } })).toBe(1);

    // Una empresa sin instalación no ve la configuración de otra.
    const sur = await login(t.app, 'sur@aida.test');
    const st = track(await sur.get('/integrations/ghl/provisioning'));
    expect(st.body).toMatchObject({ installation: null, resources: [] });
    expect(JSON.stringify(st.body)).not.toContain(LOC);
  });

  it('18b. token de agencia: sólo locations con la app instalada; un fallo en una location no detiene las demás', async () => {
    ghl.installedLocations = [
      { _id: 'loc_x', name: 'Sucursal X', isInstalled: true },
      { _id: 'loc_y', name: 'Sucursal Y', isInstalled: true },
      { _id: 'loc_z', name: 'Sucursal Z', isInstalled: false },
    ];
    ghl.failures.push({ match: 'POST /oauth/locationToken', status: 500 }); // falla loc_x
    expect(await marketplaceInstall('agency-code')).toMatch(/oauth=agency_installed$/);
    expect(await t.prisma.ghlInstallation.findUnique({ where: { ghlLocationId: 'loc_x' } })).toBeNull();
    expect(await t.prisma.ghlInstallation.findUnique({ where: { ghlLocationId: 'loc_z' } })).toBeNull();
    const y = await installationOf('loc_y');
    expect(y).toMatchObject({ installSource: 'agency', ghlCompanyId: 'agency_1' });
    expect(y.agencyGrantId).not.toBeNull();
    expect((await t.prisma.company.findUniqueOrThrow({ where: { id: y.companyId } })).name).toBe('Sucursal Y');
    const cred = await t.prisma.oAuthCredential.findUniqueOrThrow({ where: { installationId: y.id } });
    expect(cred.encryptedRefreshToken).toBeNull();
    const grant = await t.prisma.ghlAgencyGrant.findFirstOrThrow();
    expect(grant.encryptedAccessToken).toMatch(/^v1\./);
    expect(ghl.calls.find(c => c.path === '/oauth/installedLocations')!.headers.version).toBe('2021-07-28');

    await worker.drain();
    expect((await lastExecution('loc_y')).status).toBe('ready');
    // Token de location vencido: se emite otro con el token de agencia (no hay refresh token de location).
    await t.prisma.oAuthCredential.updateMany({ where: { installationId: y.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const before = ghl.calls.filter(c => c.path === '/oauth/locationToken').length;
    const access = await t.app.get(GhlTokenService).getAccessToken(y.id);
    expect(access.version).toBe(cred.tokenVersion + 1);
    expect(ghl.calls.filter(c => c.path === '/oauth/locationToken')).toHaveLength(before + 1);
  });

  // ─── 19. Reintento no autorizado ───
  it('19. reintento: exige rol admin, resuelve la location desde la sesión y rechaza locationId del cliente', async () => {
    const owner = await login(t.app, 'demo@aida.test');
    await connect(owner);
    const editor = await login(t.app, 'editor@aida.test');
    const viewer = await login(t.app, 'viewer@aida.test');
    expect((await editor.post('/integrations/ghl/provisioning/retry')).status).toBe(403);
    expect((await viewer.post('/integrations/ghl/provisioning/retry')).status).toBe(403);
    expect((await owner.post('/integrations/ghl/provisioning/retry', { locationId: 'loc_b' })).status).toBe(400);
    const sur = await login(t.app, 'sur@aida.test');
    expect((await sur.post('/integrations/ghl/provisioning/retry')).body.code).toBe('GHL_NOT_CONNECTED');
    const ok = await owner.post('/integrations/ghl/provisioning/retry');
    expect(ok.body).toMatchObject({ alreadyActive: true }); // la del callback sigue pendiente
    expect((await http().post('/api/v1/integrations/ghl/provisioning/retry').set('Origin', ORIGIN).send({})).status).toBe(401);
  });

  // ─── 20. No exposición de secretos ───
  it('20. estado, auditoría y registros de configuración no contienen tokens ni secretos', async () => {
    const owner = await login(t.app, 'demo@aida.test');
    await connect(owner);
    await worker.drain();
    const status = track(await owner.get('/integrations/ghl/provisioning'));
    expect(status.body.configurationStatus).toBe('ready');
    const serialized = JSON.stringify(status.body) + JSON.stringify(await t.prisma.provisioningExecution.findMany({ include: { steps: true } })) + JSON.stringify(await t.prisma.provisionedResource.findMany()) + JSON.stringify(await t.prisma.auditLog.findMany());
    expect(serialized).not.toMatch(/fake-(access|refresh)-|test-secret|valid-code/);
    expect(JSON.stringify(status.body)).not.toMatch(/remoteId|encrypted/);
  });

  // ─── 21. Sincronización sin regresiones + metadatos ───
  it('21. instalar no importa ni modifica contactos; los metadatos se escriben sólo en exportaciones confirmadas', async () => {
    ghl.seedContacts(2);
    const owner = await login(t.app, 'demo@aida.test');
    const before = await t.prisma.contact.count();
    await connect(owner);
    await worker.drain();
    expect(await t.prisma.contact.count()).toBe(before);
    expect(ghl.calls.some(c => c.path.startsWith('/contacts'))).toBe(false);

    const config = t.app.get<AppConfig>(APP_CONFIG);
    config.ghl.syncMetadataWrite = true;
    try {
      ghl.contacts.get('ghl_0001')!.customFields = [{ id: 'cf_cliente', value: 'no tocar' }];
      await owner.post('/sync/import', {});
      expect(ghl.calls.some(c => c.method === 'PUT')).toBe(false); // importar no escribe en GHL
      const local = await t.prisma.contact.findFirstOrThrow({ where: { ghlContactId: 'ghl_0001' } });
      await owner.patch(`/contacts/${local.id}`, { lastName: 'Exportado' });
      const preview = await owner.post('/sync/export/preview', { contactIds: [local.id] });
      const res = await owner.post('/sync/export', { contactIds: [local.id], confirmed: true, previewToken: preview.body.previewToken });
      expect(res.body).toMatchObject({ status: 'completed', successfulRecords: 1 });
      expect(res.body.events.map((e: { operation: string }) => e.operation)).toEqual(['export.update', 'export.metadata']);
      const ids = Object.fromEntries((await resources()).map(r => [r.resourceKey, r.remoteId]));
      const puts = ghl.calls.filter(c => c.method === 'PUT');
      expect(JSON.parse(puts[0].body)).toEqual({ lastName: 'Exportado' });
      expect(JSON.parse(puts[1].body)).toEqual({ customFields: [{ id: ids[RESOURCE_KEYS.externalId], field_value: local.id }, { id: ids[RESOURCE_KEYS.syncStatus], field_value: 'synced' }] });
      expect(ghl.contacts.get('ghl_0001')!.customFields).toContainEqual({ id: 'cf_cliente', value: 'no tocar' });

      // Un fallo de metadatos se registra aparte y no cambia el resultado real de la exportación.
      await owner.patch(`/contacts/${local.id}`, { lastName: 'Otra vez' });
      const p2 = await owner.post('/sync/export/preview', { contactIds: [local.id] });
      ghl.rejectCustomFieldWrites = true;
      const r2 = await owner.post('/sync/export', { contactIds: [local.id], confirmed: true, previewToken: p2.body.previewToken });
      expect(r2.body).toMatchObject({ status: 'completed', successfulRecords: 1, failedRecords: 0 });
      expect(r2.body.events.find((e: { operation: string }) => e.operation === 'export.metadata')).toMatchObject({ status: 'failed', errorCode: 'GHL_VALIDATION' });
      expect(ghl.contacts.get('ghl_0001')!.lastName).toBe('Otra vez');
    } finally {
      config.ghl.syncMetadataWrite = false;
    }
  });
});

// ─── 22. Modo mock sin llamadas accidentales a GHL real ───
describe('Configuración automática en GHL_MODE=mock', () => {
  let t: TestApp;
  const fetchSpy = jest.fn(async () => new Response('{}', { status: 599 }));

  beforeAll(async () => {
    t = await createTestApp({ GHL_MODE: 'mock' }, fetchSpy as unknown as typeof fetch);
  });
  beforeEach(() => resetDb(t.prisma));
  afterAll(() => t.close());

  it('22. usa el adaptador simulado, declara el modo y nunca invoca fetch', async () => {
    expect(t.app.get(GhlProvisioningClient)).toBeInstanceOf(MockGhlProvisioningClient);
    const owner = await login(t.app, 'demo@aida.test');
    const status = await owner.get('/integrations/ghl/provisioning');
    expect(status.body).toMatchObject({ mode: 'mock', simulated: true, installation: null });
    expect((await owner.post('/integrations/ghl/provisioning/retry')).body.code).toBe('GHL_MOCK_MODE');
    await t.app.get(ProvisioningWorker).drain();
    await owner.post('/sync/import', {});
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
