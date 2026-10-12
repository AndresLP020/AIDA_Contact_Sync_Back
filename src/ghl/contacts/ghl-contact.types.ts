import { createHash } from 'node:crypto';
import { z } from 'zod';
import { GhlApiError } from './ghl-errors';

/** Campos que la aplicación puede leer de GHL y escribir de vuelta. Cualquier otro campo se ignora. */
export const SYNCABLE_FIELDS = ['firstName', 'lastName', 'email', 'phone'] as const;
export type SyncableField = (typeof SYNCABLE_FIELDS)[number];
export type ContactFields = Record<SyncableField, string | null>;

export type RemoteContact = ContactFields & {
  id: string;
  locationId: string | null;
  source: string | null;
  dateUpdated: Date | null;
};

export type ContactPatch = Partial<ContactFields>;

/** Esquema de validación de un contacto recibido de GHL (los campos desconocidos se descartan). */
export const remoteContactSchema = z.object({
  id: z.string().min(1).max(128),
  locationId: z.string().max(128).nullish(),
  firstName: z.string().max(500).nullish(),
  lastName: z.string().max(500).nullish(),
  email: z.string().max(500).nullish(),
  phone: z.string().max(100).nullish(),
  source: z.string().max(500).nullish(),
  dateUpdated: z.string().max(64).nullish(),
});

const LIMITS: Record<SyncableField, number> = { firstName: 100, lastName: 100, email: 254, phone: 40 };

export function normalizeField(field: SyncableField, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let v = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!v) return null;
  if (field === 'email') v = v.toLowerCase();
  return v.slice(0, LIMITS[field]);
}

export function normalizeFields(input: Partial<Record<SyncableField, unknown>>): ContactFields {
  return {
    firstName: normalizeField('firstName', input.firstName),
    lastName: normalizeField('lastName', input.lastName),
    email: normalizeField('email', input.email),
    phone: normalizeField('phone', input.phone),
  };
}

/** Valida y normaliza un contacto remoto. Lanza GHL_INVALID_RESPONSE si el formato no es el esperado. */
export function parseRemoteContact(raw: unknown): RemoteContact {
  const parsed = remoteContactSchema.safeParse(raw);
  if (!parsed.success) throw new GhlApiError('GHL_INVALID_RESPONSE');
  const c = parsed.data;
  const date = c.dateUpdated ? new Date(c.dateUpdated) : null;
  return {
    id: c.id,
    locationId: c.locationId ?? null,
    source: c.source?.trim().slice(0, 120) || null,
    dateUpdated: date && !Number.isNaN(date.getTime()) ? date : null,
    ...normalizeFields(c),
  };
}

/** Comparación semántica: el teléfono se compara por dígitos porque GHL lo normaliza a E.164. */
export function sameValue(field: SyncableField, a: string | null, b: string | null) {
  if (field === 'phone') return (a ?? '').replace(/\D/g, '') === (b ?? '').replace(/\D/g, '');
  return (a ?? null) === (b ?? null);
}

/** Huella de los campos sincronizables: permite detectar cambios remotos aunque GHL no exponga versión. */
export function fieldsHash(fields: ContactFields): string {
  const canonical = SYNCABLE_FIELDS.map(f => (f === 'phone' ? (fields.phone ?? '').replace(/\D/g, '') : fields[f] ?? ''));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export type FieldChange = { field: SyncableField; local: string | null; remote: string | null };

export function diffFields(local: ContactFields, remote: ContactFields): FieldChange[] {
  return SYNCABLE_FIELDS.filter(f => !sameValue(f, local[f], remote[f])).map(f => ({ field: f, local: local[f], remote: remote[f] }));
}

export function pickFields(c: Partial<Record<SyncableField, string | null>>): ContactFields {
  return { firstName: c.firstName ?? null, lastName: c.lastName ?? null, email: c.email ?? null, phone: c.phone ?? null };
}
