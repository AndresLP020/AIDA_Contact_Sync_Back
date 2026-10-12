import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { ContactFields, ContactPatch, RemoteContact } from './ghl-contact.types';
import { normalizeFields } from './ghl-contact.types';
import { type GhlConnection, GhlContactsClient, type RemoteContactPage, type SearchParams } from './ghl-contacts.client';
import { GhlApiError } from './ghl-errors';

const FIRST = ['Lucía', 'Mateo', 'Sofía', 'Diego', 'Valentina', 'Santiago', 'Camila', 'Emiliano', 'Regina', 'Leonardo', 'Ximena', 'Sebastián', 'Renata', 'Nicolás', 'Daniela', 'Gael', 'Mariana', 'Andrés'];
const LAST = ['Ramírez', 'Santos', 'Herrera', 'Morales', 'Castillo', 'Vargas', 'Ortega', 'Navarro', 'Delgado', 'Rojas', 'Mendoza', 'Silva', 'Guerrero', 'Cruz', 'Paredes'];
const SOURCES = ['web form', 'referral', 'manual', 'facebook', 'landing page'];
export const MOCK_BASE_DATE = new Date('2026-09-01T12:00:00.000Z');
export const MOCK_CONTACTS_PER_COMPANY = 36;

/** Identificador de contacto simulado: determinista por empresa para que el seed y el simulador coincidan. */
export function mockContactId(companyId: string, n: number) {
  return `mock_${companyId.slice(0, 8)}_${String(n).padStart(3, '0')}`;
}

/** Dataset simulado determinista (datos ficticios, dominio .test reservado). */
export function mockDataset(companyId: string): RemoteContact[] {
  const offset = createHash('sha256').update(companyId).digest()[0];
  return Array.from({ length: MOCK_CONTACTS_PER_COMPANY }, (_, i) => {
    const first = FIRST[(i + offset) % FIRST.length];
    const last = LAST[(i * 7 + offset) % LAST.length];
    const fields = normalizeFields({
      firstName: first,
      lastName: last,
      email: `${first}.${last}.${i + 1}@example.test`.normalize('NFD').replace(/[̀-ͯ]/g, ''),
      phone: `+52 55 5${String(100 + ((i * 37 + offset) % 900)).padStart(3, '0')} ${String(1000 + i).slice(-4)}`,
    });
    return { id: mockContactId(companyId, i + 1), locationId: `mock-location-${companyId}`, source: SOURCES[i % SOURCES.length], dateUpdated: MOCK_BASE_DATE, ...fields };
  });
}

/**
 * ADAPTADOR SIMULADO — no contacta a HighLevel.
 * Sólo se instancia con GHL_MODE=mock, que la configuración rechaza en producción.
 * Mantiene un estado en memoria por empresa para que importar/exportar/conflictos sean demostrables.
 */
@Injectable()
export class MockGhlContactsClient extends GhlContactsClient {
  readonly mode = 'mock' as const;
  private readonly logger = new Logger('MockGhl');
  private readonly stores = new Map<string, Map<string, RemoteContact>>();

  constructor() {
    super();
    this.logger.warn({ msg: 'ghl_mock_adapter_active', detail: 'GHL_MODE=mock: se usan contactos ficticios en memoria' });
  }

  private store(conn: GhlConnection) {
    let store = this.stores.get(conn.companyId);
    if (!store) {
      store = new Map(mockDataset(conn.companyId).map(c => [c.id, c]));
      this.stores.set(conn.companyId, store);
    }
    return store;
  }

  async searchContacts(conn: GhlConnection, params: SearchParams): Promise<RemoteContactPage> {
    const q = params.query?.toLowerCase();
    const all = [...this.store(conn).values()].filter(c => !q || [c.firstName, c.lastName, c.email, c.phone].some(v => v?.toLowerCase().includes(q)));
    const start = (params.page - 1) * params.pageLimit;
    return { contacts: all.slice(start, start + params.pageLimit), total: all.length, hasMore: start + params.pageLimit < all.length };
  }

  async getContact(conn: GhlConnection, contactId: string): Promise<RemoteContact> {
    const c = this.store(conn).get(contactId);
    if (!c) throw new GhlApiError('GHL_NOT_FOUND', 404);
    return { ...c };
  }

  async updateContact(conn: GhlConnection, contactId: string, patch: ContactPatch): Promise<RemoteContact> {
    const current = await this.getContact(conn, contactId);
    const next: RemoteContact = { ...current, ...normalizeFields({ ...current, ...patch }), dateUpdated: new Date() };
    this.store(conn).set(contactId, next);
    return { ...next };
  }

  async createContact(_conn: GhlConnection, _fields: ContactFields): Promise<RemoteContact> {
    throw new GhlApiError('GHL_FEATURE_DISABLED');
  }

  /** Restablece el dataset simulado (usado por las pruebas). */
  reset() {
    this.stores.clear();
  }

  /** Sólo demostración: simula que alguien editó el contacto directamente en GHL para provocar un conflicto. */
  async simulateRemoteEdit(conn: GhlConnection, contactId: string): Promise<RemoteContact> {
    const current = await this.getContact(conn, contactId);
    const next: RemoteContact = { ...current, lastName: `${current.lastName ?? ''} (editado en GHL)`.trim(), dateUpdated: new Date() };
    this.store(conn).set(contactId, next);
    return { ...next };
  }
}
