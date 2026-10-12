import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (password: string, salt: string, keylen: number) => Promise<Buffer>;
const KEYLEN = 64;

/** Formato: "<salt hex>:<hash hex>" (scrypt N=16384, r=8, p=1 por defecto de Node). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(password, salt, KEYLEN)).toString('hex')}`;
}

const DUMMY = 'f0e1d2c3b4a5968778695a4b3c2d1e0f:' + '00'.repeat(KEYLEN);

/** Verificación en tiempo constante. Con hash nulo se calcula igualmente para no revelar si el usuario existe. */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const [salt, expectedHex] = (stored ?? DUMMY).split(':');
  if (!salt || !expectedHex) return false;
  const actual = await scrypt(password, salt, KEYLEN);
  const expected = Buffer.from(expectedHex, 'hex');
  return !!stored && expected.length === actual.length && timingSafeEqual(expected, actual);
}
