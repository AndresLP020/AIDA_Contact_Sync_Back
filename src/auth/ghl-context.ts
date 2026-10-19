import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * Payload que GHL entrega a una Custom Page vía postMessage (REQUEST_USER_DATA_RESPONSE), cifrado con
 * CryptoJS.AES.encrypt(json, SharedSecret) — formato OpenSSL "Salted__" + EVP_BytesToKey(MD5) + AES-256-CBC.
 */
const ghlUserContextSchema = z.object({
  userId: z.string().max(128).nullish(),
  companyId: z.string().max(128).nullish(),
  role: z.string().max(64).nullish(),
  type: z.string().max(64).nullish(),
  activeLocation: z.string().min(1).max(128),
  userName: z.string().max(200).nullish(),
  locationName: z.string().max(200).nullish(),
  activeLocationName: z.string().max(200).nullish(),
  email: z.string().max(254).nullish(),
});
export type GhlUserContext = z.infer<typeof ghlUserContextSchema>;

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function evpBytesToKey(secret: Buffer, salt: Buffer) {
  let material = Buffer.alloc(0);
  let previous = Buffer.alloc(0);
  while (material.length < 48) {
    previous = createHash('md5').update(Buffer.concat([previous, secret, salt])).digest();
    material = Buffer.concat([material, previous]);
  }
  return { key: material.subarray(0, 32), iv: material.subarray(32, 48) };
}

function openSslDecrypt(encrypted: string, sharedSecret: string): string {
  const raw = Buffer.from(encrypted, 'base64');
  if (raw.length < 32 || raw.subarray(0, 8).toString('latin1') !== 'Salted__') throw new Error('Formato de contexto inválido');
  const { key, iv } = evpBytesToKey(Buffer.from(sharedSecret, 'utf8'), raw.subarray(8, 16));
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString('utf8');
}

function parseContext(json: string): GhlUserContext {
  const raw = JSON.parse(json) as unknown;
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const nested = record.user && typeof record.user === 'object' ? (record.user as Record<string, unknown>) : {};
  const activeLocation = firstString(record.activeLocation, record.locationId, record.activeLocationId, nested.activeLocation, nested.locationId);
  const parsed = ghlUserContextSchema.safeParse({
    userId: firstString(record.userId, nested.userId, nested.id) ?? null,
    companyId: firstString(record.companyId, nested.companyId) ?? null,
    role: firstString(record.role, nested.role) ?? null,
    type: firstString(record.type, nested.type) ?? null,
    activeLocation,
    userName: firstString(record.userName, record.name, nested.userName, nested.name) ?? null,
    locationName: firstString(record.locationName, nested.locationName) ?? null,
    activeLocationName: firstString(record.activeLocationName, nested.activeLocationName) ?? null,
    email: firstString(record.email, nested.email) ?? null,
  });
  if (!parsed.success) {
    const paths = parsed.error.issues.map(issue => issue.path.join('.') || issue.code).join(',');
    throw new Error(`schema:${paths || 'invalid'}`);
  }
  return parsed.data;
}

function cipherCandidates(encrypted: string): string[] {
  const trimmed = encrypted.trim().replace(/^"|"$/g, '');
  const compact = trimmed.replace(/\s/g, '');
  let decoded = compact;
  try {
    if (compact.includes('%')) decoded = decodeURIComponent(compact);
  } catch {
    decoded = compact;
  }
  return [...new Set([trimmed, compact, decoded])];
}

export function decryptGhlContext(encrypted: string, sharedSecret: string): GhlUserContext {
  let lastError: unknown;
  for (const candidate of cipherCandidates(encrypted)) {
    try {
      return parseContext(openSslDecrypt(candidate, sharedSecret));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Formato de contexto inválido');
}

/** Inverso compatible con CryptoJS; se usa en pruebas para generar payloads como los de GHL. */
export function encryptGhlContextForTests(payload: object, sharedSecret: string): string {
  const salt = randomBytes(8);
  const { key, iv } = evpBytesToKey(Buffer.from(sharedSecret, 'utf8'), salt);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from('Salted__', 'latin1'), salt, data]).toString('base64');
}
