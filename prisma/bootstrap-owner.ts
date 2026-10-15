/**
 * Crea la primera empresa y su owner si BOOTSTRAP_OWNER_EMAIL y BOOTSTRAP_OWNER_PASSWORD están definidos.
 * Idempotente: si el email ya existe, no cambia la contraseña ni la empresa. No carga datos de demostración.
 */
import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/auth/password';

async function main() {
  const email = process.env.BOOTSTRAP_OWNER_EMAIL?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_OWNER_PASSWORD ?? '';
  const companyName = process.env.BOOTSTRAP_COMPANY_NAME?.trim() || 'AIDA';
  if (!email && !password) return;
  if (!email || password.length < 8 || password.length > 128) {
    console.error('BOOTSTRAP_OWNER_EMAIL y BOOTSTRAP_OWNER_PASSWORD (8 a 128 caracteres) deben definirse juntos.');
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      console.log('Bootstrap: el usuario ya existe; no se modifica.');
      return;
    }
    const passwordHash = await hashPassword(password);
    await prisma.user.create({
      data: {
        email,
        displayName: email,
        passwordHash,
        memberships: { create: { role: 'owner', company: { create: { name: companyName } } } },
      },
    });
    console.log('Bootstrap: empresa y usuario owner creados.');
  } finally {
    await prisma.$disconnect();
  }
}

void main();
