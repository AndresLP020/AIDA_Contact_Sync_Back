import { execSync } from 'node:child_process';

/**
 * Aplica las migraciones reales a la base de PRUEBAS (nunca la de desarrollo). No es destructivo:
 * cada suite limpia sus tablas con TRUNCATE (test/helpers.ts → resetDb).
 */
export default async function globalSetup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('Define TEST_DATABASE_URL (ver .env.example). Las pruebas e2e necesitan PostgreSQL.');
  if (!new URL(url).pathname.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL debe apuntar a una base cuyo nombre termine en _test (protección contra borrar datos reales).');
  }
  execSync('npx prisma migrate deploy', { stdio: 'inherit', env: { ...process.env, DATABASE_URL: url, PRISMA_HIDE_UPDATE_MESSAGE: '1' } });
}
