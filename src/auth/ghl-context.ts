import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * Payload que GHL entrega a una Custom Page vía postMessage (REQUEST_USER_DATA_RESPONSE), cifrado con
 * CryptoJS.AES.encrypt(json, SharedSecret) — formato OpenSSL "Salted__" + EVP_BytesToKey(MD5) + AES-256-CBC.
 */
export const ghlUserContextSchema = z.object({
  userId: z.string().min(1).max(128),
  companyId: z.string().max(128).optional(),
  role: z.string().max(64).optional(),
  type: z.string().max(32).optional(),
  activeLocation: z.string().min(1).max(128).optional(),
  userName: z.string().max(200).optional(),
  email: z.string().email().max(254),
});
export type GhlUserContext = z.infer<typeof ghlUserContextSchema>;

function evpBytesToKey(secret: Buffer, salt: Buffer) {
  let material = Buffer.alloc(0);
  let previous = Buffer.alloc(0);
  while (material.length < 48) {
    previous = createHash('md5').update(Buffer.concat([previous, secret, salt])).digest();
    material = Buffer.concat([material, previous]);
  }
  return { key: material.subarray(0, 32), iv: material.subarray(32, 48) };
}

export function decryptGhlContext(encrypted: string, sharedSecret: string): GhlUserContext {
  const raw = Buffer.from(encrypted, 'base64');
  if (raw.length < 32 || raw.subarray(0, 8).toString('latin1') !== 'Salted__') throw new Error('Formato de contexto inválido');
  const { key, iv } = evpBytesToKey(Buffer.from(sharedSecret, 'utf8'), raw.subarray(8, 16));
  const decipher = createDecipheriv('aes-256-cbc', key, iv);
  const json = Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString('utf8');
  return ghlUserContextSchema.parse(JSON.parse(json));
}

/** Inverso compatible con CryptoJS; se usa en pruebas para generar payloads como los de GHL. */
export function encryptGhlContextForTests(payload: object, sharedSecret: string): string {
  const salt = randomBytes(8);
  const { key, iv } = evpBytesToKey(Buffer.from(sharedSecret, 'utf8'), salt);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from('Salted__', 'latin1'), salt, data]).toString('base64');
}
