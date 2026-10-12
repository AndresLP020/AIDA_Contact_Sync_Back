/**
 * Datos FICTICIOS para desarrollo y demostración. Idempotente (upsert). Nunca se ejecuta en producción.
 * Dos empresas aisladas para comprobar el aislamiento multiempresa:
 *   - AIDA Demo Norte: owner (demo@aida.test), editor (editor@aida.test), viewer (viewer@aida.test)
 *   - AIDA Demo Sur:   owner (sur@aida.test)
 */
import { PrismaClient, type MemberRole } from '@prisma/client';
import { hashPassword } from '../src/auth/password';
import { fieldsHash, pickFields } from '../src/ghl/contacts/ghl-contact.types';
import { mockDataset } from '../src/ghl/contacts/mock-ghl-contacts.client';

export const SEED_COMPANIES = {
  norte: { id: '11111111-1111-4111-8111-111111111111', name: 'AIDA Demo Norte' },
  sur: { id: '22222222-2222-4222-8222-222222222222', name: 'AIDA Demo Sur' },
};
export const DEFAULT_DEMO_PASSWORD = 'AidaDemo#2026';

const USERS: { email: string; displayName: string; company: keyof typeof SEED_COMPANIES; role: MemberRole }[] = [
  { email: 'demo@aida.test', displayName: 'Ana Demo (owner)', company: 'norte', role: 'owner' },
  { email: 'editor@aida.test', displayName: 'Eduardo Editor', company: 'norte', role: 'editor' },
  { email: 'viewer@aida.test', displayName: 'Valeria Lectura', company: 'norte', role: 'viewer' },
  { email: 'sur@aida.test', displayName: 'Sergio Sur (owner)', company: 'sur', role: 'owner' },
];

export async function seed(prisma: PrismaClient, password = process.env.SEED_DEMO_PASSWORD || DEFAULT_DEMO_PASSWORD) {
  for (const c of Object.values(SEED_COMPANIES)) {
    await prisma.company.upsert({ where: { id: c.id }, update: {}, create: { id: c.id, name: c.name } });
  }
  for (const u of USERS) {
    const passwordHash = await hashPassword(password);
    const user = await prisma.user.upsert({ where: { email: u.email }, update: { passwordHash, status: 'active' }, create: { email: u.email, displayName: u.displayName, passwordHash } });
    const companyId = SEED_COMPANIES[u.company].id;
    await prisma.membership.upsert({ where: { userId_companyId: { userId: user.id, companyId } }, update: { role: u.role, status: 'active' }, create: { userId: user.id, companyId, role: u.role } });
  }
  // Algunos contactos ya "importados" (coinciden con el dataset del adaptador simulado).
  for (const [key, count] of [['norte', 5], ['sur', 3]] as const) {
    const companyId = SEED_COMPANIES[key].id;
    for (const remote of mockDataset(companyId).slice(0, count)) {
      await prisma.contact.upsert({
        where: { companyId_ghlContactId: { companyId, ghlContactId: remote.id } },
        update: {},
        create: { companyId, ghlContactId: remote.id, ...pickFields(remote), source: remote.source ?? 'seed', origin: 'ghl', syncStatus: 'synced', lastSyncedAt: new Date(), lastRemoteUpdate: remote.dateUpdated, remoteHash: fieldsHash(remote) },
      });
    }
  }
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    console.error('Seed de datos ficticios bloqueado en producción.');
    process.exit(1);
  }
  const prisma = new PrismaClient();
  try {
    await seed(prisma);
    console.log(`Seed listo: 2 empresas aisladas, ${USERS.length} usuarios ficticios, contactos de ejemplo.`);
    if (!process.env.SEED_DEMO_PASSWORD) console.log(`Contraseña demo por defecto (sólo local): ${DEFAULT_DEMO_PASSWORD}`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) void main();
