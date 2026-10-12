import type { ContactFields, ContactPatch, RemoteContact } from './ghl-contact.types';

/** Contexto de conexión resuelto en el backend a partir de la empresa autenticada (nunca del cliente). */
export type GhlConnection = { companyId: string; locationId: string; installationId: string | null };

export type RemoteContactPage = { contacts: RemoteContact[]; total: number | null; hasMore: boolean };
export type SearchParams = { page: number; pageLimit: number; query?: string };

/**
 * Puerto de acceso a la API oficial de Contactos de GHL.
 * Implementaciones: HttpGhlContactsClient (API real) y MockGhlContactsClient (adaptador simulado explícito).
 */
export abstract class GhlContactsClient {
  abstract readonly mode: 'mock' | 'real';
  abstract searchContacts(conn: GhlConnection, params: SearchParams): Promise<RemoteContactPage>;
  abstract getContact(conn: GhlConnection, contactId: string): Promise<RemoteContact>;
  /** PUT idempotente: sólo envía los campos autorizados que cambian. */
  abstract updateContact(conn: GhlConnection, contactId: string, patch: ContactPatch): Promise<RemoteContact>;
  /** Deshabilitado salvo GHL_ALLOW_CONTACT_CREATE=true. Nunca se reintenta tras un error ambiguo (evita duplicados). */
  abstract createContact(conn: GhlConnection, fields: ContactFields): Promise<RemoteContact>;
}
