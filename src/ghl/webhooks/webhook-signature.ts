import { createPublicKey, verify } from 'node:crypto';

/**
 * Verifica X-GHL-Signature: firma Ed25519 (base64) sobre el cuerpo crudo, con la clave pública oficial de HighLevel.
 * El encabezado RSA heredado X-WH-Signature quedó obsoleto el 1 de septiembre de 2026 y no se acepta.
 */
export function verifyGhlSignature(rawBody: Buffer, signatureB64: string | undefined, publicKeyPem: string): boolean {
  if (!signatureB64 || signatureB64.length > 512) return false;
  try {
    const signature = Buffer.from(signatureB64, 'base64');
    if (signature.length !== 64) return false;
    return verify(null, rawBody, createPublicKey(publicKeyPem), signature);
  } catch {
    return false;
  }
}
