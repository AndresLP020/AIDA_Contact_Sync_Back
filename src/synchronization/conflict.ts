import { createHmac, timingSafeEqual } from 'node:crypto';
import { fieldsHash, type RemoteContact } from '../ghl/contacts/ghl-contact.types';

/**
 * Motivo por el que NO se debe sobrescribir GHL sin una decisión explícita:
 *  - NO_BASELINE:     no hay huella de la última sincronización (información insuficiente).
 *  - REMOTE_CHANGED:  los campos sincronizables cambiaron en GHL desde la última importación/exportación.
 * La fecha dateUpdated de GHL se reporta como señal informativa (puede cambiar por campos que no sincronizamos).
 */
export type ConflictReason = 'NO_BASELINE' | 'REMOTE_CHANGED';

export function detectRemoteChange(baseline: { remoteHash: string | null }, remote: RemoteContact): ConflictReason | null {
  if (!baseline.remoteHash) return 'NO_BASELINE';
  if (fieldsHash(remote) !== baseline.remoteHash) return 'REMOTE_CHANGED';
  return null;
}

export function remoteTouchedSince(lastRemoteUpdate: Date | null, remote: RemoteContact) {
  return !!(remote.dateUpdated && lastRemoteUpdate && remote.dateUpdated.getTime() > lastRemoteUpdate.getTime());
}

/**
 * Token de vista previa: firma HMAC de (empresa, contactos, updatedAt locales, expiración).
 * Garantiza que la exportación confirmada corresponde exactamente a lo que el usuario revisó.
 */
export const PREVIEW_TTL_MS = 10 * 60_000;

function previewPayload(companyId: string, contacts: { id: string; updatedAt: Date }[], exp: number) {
  const items = contacts.map(c => `${c.id}:${c.updatedAt.toISOString()}`).sort();
  return `export-preview|${companyId}|${exp}|${items.join(',')}`;
}

export function signPreview(secret: string, companyId: string, contacts: { id: string; updatedAt: Date }[], now = Date.now()) {
  const exp = now + PREVIEW_TTL_MS;
  const sig = createHmac('sha256', secret).update(previewPayload(companyId, contacts, exp)).digest('hex');
  return { token: `${exp}.${sig}`, expiresAt: new Date(exp) };
}

export function verifyPreview(secret: string, token: string, companyId: string, contacts: { id: string; updatedAt: Date }[], now = Date.now()) {
  const [expRaw, sig] = token.split('.');
  const exp = Number(expRaw);
  if (!Number.isFinite(exp) || !sig || exp < now) return false;
  const expected = createHmac('sha256', secret).update(previewPayload(companyId, contacts, exp)).digest();
  const given = Buffer.from(sig, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
