import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { configureApp } from '../src/app.factory';
import { AppModule } from '../src/app.module';
import { JsonLogger } from '../src/common/json-logger';
import { GHL_HTTP_TUNING } from '../src/ghl/contacts/http-ghl-contacts.client';
import { FETCH, type FetchFn } from '../src/ghl/tokens/ghl-token.service';
import { seed, SEED_COMPANIES } from '../prisma/seed';

export const ORIGIN = 'http://localhost:3100';
export const PASSWORD = 'TestPassword#2026';
export const NORTE = SEED_COMPANIES.norte.id;
export const SUR = SEED_COMPANIES.sur.id;

export type TestApp = { app: NestExpressApplication; prisma: PrismaClient; close: () => Promise<void> };

/** Levanta la app real (mismo pipeline de seguridad que producción) con variables y fetch opcionalmente sustituidos. */
export async function createTestApp(env: Record<string, string> = {}, fetchFn?: FetchFn): Promise<TestApp> {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    previous[k] = process.env[k];
    process.env[k] = v;
  }
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(GHL_HTTP_TUNING)
    .useValue({ sleep: async () => undefined, baseDelayMs: 1 });
  if (fetchFn) builder = builder.overrideProvider(FETCH).useValue(fetchFn);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true, logger: false });
  configureApp(app, new JsonLogger(true));
  await app.init();
  const prisma = new PrismaClient();
  return {
    app,
    prisma,
    close: async () => {
      await app.close();
      await prisma.$disconnect();
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

const TABLES = ['AuditLog', 'SyncEvent', 'SyncJob', 'Contact', 'OAuthCredential', 'GhlInstallation', 'OAuthState', 'GhlContextGrant', 'GhlWebhookEvent', 'Session', 'Membership', 'User', 'Company'];

export async function resetDb(prisma: PrismaClient) {
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map(t => `"${t}"`).join(', ')} CASCADE`);
  await seed(prisma, PASSWORD);
}

/** Agente con cookie de sesión, que envía Origin y Content-Type JSON como el frontend real. */
export async function login(app: NestExpressApplication, email: string, password = PASSWORD) {
  const agent = request.agent(app.getHttpServer());
  const res = await agent.post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email, password });
  if (res.status !== 200) throw new Error(`login ${email} falló: ${res.status} ${JSON.stringify(res.body)}`);
  return {
    agent,
    get: (url: string) => agent.get(`/api/v1${url}`),
    post: (url: string, body: object = {}, headers: Record<string, string> = {}) => agent.post(`/api/v1${url}`).set('Origin', ORIGIN).set(headers).send(body),
    patch: (url: string, body: object) => agent.patch(`/api/v1${url}`).set('Origin', ORIGIN).send(body),
  };
}
export type Client = Awaited<ReturnType<typeof login>>;
