import type { RemoteCustomField, RemoteCustomValue } from './ghl-provisioning.client';
import type { CustomFieldSpec, CustomValueSpec } from './provisioning.manifest';

/**
 * Decisión de reconciliación cuando NO hay un ID remoto registrado (o el registrado ya no existe).
 *  - create:    confirmado que falta (ninguna coincidencia por nombre).
 *  - adopt:     exactamente una coincidencia inequívoca y compatible.
 *  - conflict:  coincidencia incompatible (tipo/modelo) o varias coincidencias: no se elige arbitrariamente.
 */
export type Decision<T> = { action: 'create' } | { action: 'adopt'; remote: T } | { action: 'conflict'; code: 'AMBIGUOUS_MATCH' | 'INCOMPATIBLE_TYPE' };

export const sameName = (a: string, b: string) => a.normalize('NFC').trim().toLowerCase() === b.normalize('NFC').trim().toLowerCase();

/** Un campo es compatible sólo si su tipo es el esperado y, si GHL informa el modelo, también coincide. */
export function isCompatibleField(spec: CustomFieldSpec, remote: RemoteCustomField) {
  return (remote.dataType ?? '').toUpperCase() === spec.dataType && (remote.model === null || remote.model === spec.model);
}

export function decideField(spec: CustomFieldSpec, remotes: RemoteCustomField[]): Decision<RemoteCustomField> {
  const matches = remotes.filter(r => sameName(r.name, spec.displayName));
  if (!matches.length) return { action: 'create' };
  if (matches.length > 1) return { action: 'conflict', code: 'AMBIGUOUS_MATCH' };
  return isCompatibleField(spec, matches[0]) ? { action: 'adopt', remote: matches[0] } : { action: 'conflict', code: 'INCOMPATIBLE_TYPE' };
}

export function decideValue(spec: CustomValueSpec, remotes: RemoteCustomValue[]): Decision<RemoteCustomValue> {
  const matches = remotes.filter(r => sameName(r.name, spec.displayName));
  if (!matches.length) return { action: 'create' };
  if (matches.length > 1) return { action: 'conflict', code: 'AMBIGUOUS_MATCH' };
  return { action: 'adopt', remote: matches[0] };
}

/** Errores transitorios: se reprograma la ejecución con backoff (no requieren intervención). */
export const TRANSIENT_CODES = new Set(['GHL_RATE_LIMITED', 'GHL_UNAVAILABLE', 'GHL_NETWORK', 'DB_WRITE_FAILED']);
/** Errores que requieren acción del cliente/administrador (reautorizar, conceder scopes). */
export const ACTION_CODES = new Set(['GHL_FORBIDDEN', 'GHL_UNAUTHORIZED', 'GHL_REFRESH_REJECTED', 'GHL_NOT_CONNECTED', 'GHL_FOREIGN_LOCATION', 'GHL_VALIDATION']);

/** Backoff exponencial con jitter completo, respetando un mínimo (p. ej. Retry-After). */
export function retryDelayMs(attempt: number, random: () => number = Math.random, minimumMs = 0, baseMs = 5_000, maxMs = 15 * 60_000) {
  const jitter = Math.round(random() * Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1)));
  return Math.max(minimumMs, Math.max(1_000, jitter));
}
