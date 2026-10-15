import { Inject, Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import { FETCH, type FetchFn, GhlTokenService } from '../tokens/ghl-token.service';
import { type ContactFields, type ContactPatch, parseRemoteContact, type RemoteContact } from './ghl-contact.types';
import { type CustomFieldWrite, type GhlConnection, GhlContactsClient, type RemoteContactPage, type SearchParams } from './ghl-contacts.client';
import { GhlApiError } from './ghl-errors';
import { GhlHttp, type GhlHttpOptions, type TokenProvider } from './ghl-http';

/** Ajustes opcionales del transporte (p. ej. esperas deterministas en pruebas). */
export const GHL_HTTP_TUNING = Symbol('GHL_HTTP_TUNING');
export type GhlHttpTuning = Partial<Omit<GhlHttpOptions, 'apiBase' | 'apiVersion' | 'fetchFn'>>;

const searchResponseSchema = z.object({ contacts: z.array(z.unknown()), total: z.number().int().nonnegative().optional() });
const singleResponseSchema = z.object({ contact: z.unknown() });

/**
 * Cliente de la API oficial de Contactos de HighLevel (https://services.leadconnectorhq.com).
 * Endpoints usados (documentación oficial):
 *   POST /contacts/search       (scope contacts.readonly)
 *   GET  /contacts/{contactId}  (scope contacts.readonly)
 *   PUT  /contacts/{contactId}  (scope contacts.write)
 *   POST /contacts/             (scope contacts.write; sólo si GHL_ALLOW_CONTACT_CREATE=true)
 *   PUT  /contacts/{contactId}  { customFields: [{ id, field_value }] } (contacts.write; sólo si GHL_SYNC_METADATA_WRITE=true)
 */
@Injectable()
export class HttpGhlContactsClient extends GhlContactsClient {
  readonly mode = 'real' as const;
  private readonly http: GhlHttp;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(FETCH) fetchFn: FetchFn,
    private readonly tokens: GhlTokenService,
    @Optional() @Inject(GHL_HTTP_TUNING) tuning?: GhlHttpTuning,
  ) {
    super();
    this.http = new GhlHttp({ ...tuning, apiBase: config.ghl.apiBase, apiVersion: config.ghl.apiVersion, fetchFn });
  }

  private tokenProvider(conn: GhlConnection): TokenProvider {
    if (!conn.installationId) throw new GhlApiError('GHL_NOT_CONNECTED');
    const installationId = conn.installationId;
    return stale => this.tokens.getAccessToken(installationId, stale);
  }

  async searchContacts(conn: GhlConnection, params: SearchParams): Promise<RemoteContactPage> {
    const pageLimit = Math.min(Math.max(params.pageLimit, 1), 100);
    const raw = await this.http.request(
      {
        method: 'POST',
        path: '/contacts/search',
        retry: 'safe',
        body: { locationId: conn.locationId, page: params.page, pageLimit, ...(params.query ? { query: params.query } : {}) },
      },
      this.tokenProvider(conn),
    );
    const parsed = searchResponseSchema.safeParse(raw);
    if (!parsed.success) throw new GhlApiError('GHL_INVALID_RESPONSE');
    const contacts = parsed.data.contacts.map(parseRemoteContact).map(c => this.assertLocation(conn, c));
    const total = parsed.data.total ?? null;
    const hasMore = total !== null ? params.page * pageLimit < total : contacts.length === pageLimit;
    return { contacts, total, hasMore };
  }

  async getContact(conn: GhlConnection, contactId: string): Promise<RemoteContact> {
    const raw = await this.http.request({ method: 'GET', path: `/contacts/${encodeURIComponent(contactId)}`, retry: 'safe' }, this.tokenProvider(conn));
    return this.assertLocation(conn, this.single(raw));
  }

  async updateContact(conn: GhlConnection, contactId: string, patch: ContactPatch): Promise<RemoteContact> {
    const raw = await this.http.request(
      { method: 'PUT', path: `/contacts/${encodeURIComponent(contactId)}`, retry: 'idempotent', body: patch },
      this.tokenProvider(conn),
    );
    return this.assertLocation(conn, this.single(raw));
  }

  async createContact(conn: GhlConnection, fields: ContactFields): Promise<RemoteContact> {
    if (!this.config.ghl.allowContactCreate) throw new GhlApiError('GHL_FEATURE_DISABLED');
    const raw = await this.http.request(
      { method: 'POST', path: '/contacts/', retry: 'no-retry', body: { locationId: conn.locationId, ...fields } },
      this.tokenProvider(conn),
    );
    return this.assertLocation(conn, this.single(raw));
  }

  async updateCustomFields(conn: GhlConnection, contactId: string, fields: CustomFieldWrite[]): Promise<void> {
    const raw = await this.http.request(
      { method: 'PUT', path: `/contacts/${encodeURIComponent(contactId)}`, retry: 'idempotent', body: { customFields: fields } },
      this.tokenProvider(conn),
    );
    this.assertLocation(conn, this.single(raw));
  }

  private single(raw: unknown): RemoteContact {
    const parsed = singleResponseSchema.safeParse(raw);
    if (!parsed.success) throw new GhlApiError('GHL_INVALID_RESPONSE');
    return parseRemoteContact(parsed.data.contact);
  }

  /** Defensa en profundidad: descarta cualquier contacto que GHL atribuya a otra subcuenta. */
  private assertLocation(conn: GhlConnection, c: RemoteContact): RemoteContact {
    if (c.locationId && c.locationId !== conn.locationId) throw new GhlApiError('GHL_FOREIGN_LOCATION');
    return c;
  }
}
