import { Inject, Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';
import type { GhlConnection } from '../contacts/ghl-contacts.client';
import { GhlApiError } from '../contacts/ghl-errors';
import { GhlHttp, type TokenProvider } from '../contacts/ghl-http';
import { GHL_HTTP_TUNING, type GhlHttpTuning } from '../contacts/http-ghl-contacts.client';
import { FETCH, type FetchFn, GhlTokenService } from '../tokens/ghl-token.service';

export type RemoteCustomField = { id: string; name: string; fieldKey: string | null; dataType: string | null; model: string | null };
export type RemoteCustomValue = { id: string; name: string; fieldKey: string | null; value: string | null };
export type CreateCustomFieldInput = { name: string; dataType: string; model: 'contact'; placeholder?: string };

/**
 * Puerto de la API oficial de Custom Fields / Custom Values de una location (apps/locations.json, Version 2021-07-28).
 * Implementaciones: HttpGhlProvisioningClient (API real) y MockGhlProvisioningClient (GHL_MODE=mock, en memoria).
 */
export abstract class GhlProvisioningClient {
  abstract readonly mode: 'mock' | 'real';
  abstract listCustomFields(conn: GhlConnection): Promise<RemoteCustomField[]>;
  abstract getCustomField(conn: GhlConnection, id: string): Promise<RemoteCustomField>;
  /** NUNCA se reintenta tras un 5xx o timeout (resultado ambiguo): el llamador debe reconciliar. */
  abstract createCustomField(conn: GhlConnection, input: CreateCustomFieldInput): Promise<RemoteCustomField>;
  abstract listCustomValues(conn: GhlConnection): Promise<RemoteCustomValue[]>;
  abstract getCustomValue(conn: GhlConnection, id: string): Promise<RemoteCustomValue>;
  abstract createCustomValue(conn: GhlConnection, input: { name: string; value: string }): Promise<RemoteCustomValue>;
  /** PUT con valores absolutos (idempotente). */
  abstract updateCustomValue(conn: GhlConnection, id: string, input: { name: string; value: string }): Promise<RemoteCustomValue>;
}

const str = z.string().max(500);
const fieldSchema = z.object({ id: z.string().min(1).max(128), name: str, fieldKey: str.nullish(), dataType: z.string().max(64).nullish(), model: z.string().max(64).nullish(), locationId: z.string().max(128).nullish() });
const valueSchema = z.object({ id: z.string().min(1).max(128), name: str, fieldKey: str.nullish(), value: z.string().max(5000).nullish(), locationId: z.string().max(128).nullish() });

/** Errores que, en una creación, no permiten saber si GHL procesó la solicitud. */
export function isAmbiguousCreateError(e: unknown) {
  return e instanceof GhlApiError && (e.code === 'GHL_NETWORK' || e.code === 'GHL_UNAVAILABLE' || e.code === 'GHL_INVALID_RESPONSE');
}

/**
 * Endpoints oficiales (Version: 2021-07-28, token de location):
 *   GET  /locations/{locationId}/customFields?model=contact   locations/customFields.readonly → { customFields: [] }
 *   GET  /locations/{locationId}/customFields/{id}             → { customField }
 *   POST /locations/{locationId}/customFields                  locations/customFields.write → 201 { customField }
 *   GET  /locations/{locationId}/customValues                  locations/customValues.readonly → { customValues: [] }
 *   GET  /locations/{locationId}/customValues/{id}             → { customValue }
 *   POST /locations/{locationId}/customValues                  locations/customValues.write → 201 { customValue }
 *   PUT  /locations/{locationId}/customValues/{id}             { name, value } → { customValue }
 * La documentación no describe paginación para estos listados: se consume la lista completa devuelta.
 */
@Injectable()
export class HttpGhlProvisioningClient extends GhlProvisioningClient {
  readonly mode = 'real' as const;
  private readonly http: GhlHttp;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(FETCH) fetchFn: FetchFn,
    private readonly tokens: GhlTokenService,
    @Optional() @Inject(GHL_HTTP_TUNING) tuning?: GhlHttpTuning,
  ) {
    super();
    this.http = new GhlHttp({ ...tuning, apiBase: config.ghl.apiBase, apiVersion: config.ghl.apiVersion, fetchFn });
  }

  private provider(conn: GhlConnection): TokenProvider {
    if (!conn.installationId) throw new GhlApiError('GHL_NOT_CONNECTED');
    const id = conn.installationId;
    return stale => this.tokens.getAccessToken(id, stale);
  }

  private base(conn: GhlConnection) {
    return `/locations/${encodeURIComponent(conn.locationId)}`;
  }

  async listCustomFields(conn: GhlConnection) {
    const raw = await this.http.request({ method: 'GET', path: `${this.base(conn)}/customFields?model=contact`, retry: 'safe' }, this.provider(conn));
    const parsed = z.object({ customFields: z.array(z.unknown()) }).safeParse(raw);
    if (!parsed.success) throw new GhlApiError('GHL_INVALID_RESPONSE');
    return parsed.data.customFields.map(f => this.field(conn, f));
  }

  async getCustomField(conn: GhlConnection, id: string) {
    const raw = await this.http.request({ method: 'GET', path: `${this.base(conn)}/customFields/${encodeURIComponent(id)}`, retry: 'safe' }, this.provider(conn));
    return this.field(conn, this.unwrap(raw, 'customField'));
  }

  async createCustomField(conn: GhlConnection, input: CreateCustomFieldInput) {
    const raw = await this.http.request({ method: 'POST', path: `${this.base(conn)}/customFields`, retry: 'no-retry', body: input }, this.provider(conn));
    return this.field(conn, this.unwrap(raw, 'customField'));
  }

  async listCustomValues(conn: GhlConnection) {
    const raw = await this.http.request({ method: 'GET', path: `${this.base(conn)}/customValues`, retry: 'safe' }, this.provider(conn));
    const parsed = z.object({ customValues: z.array(z.unknown()) }).safeParse(raw);
    if (!parsed.success) throw new GhlApiError('GHL_INVALID_RESPONSE');
    return parsed.data.customValues.map(v => this.value(conn, v));
  }

  async getCustomValue(conn: GhlConnection, id: string) {
    const raw = await this.http.request({ method: 'GET', path: `${this.base(conn)}/customValues/${encodeURIComponent(id)}`, retry: 'safe' }, this.provider(conn));
    return this.value(conn, this.unwrap(raw, 'customValue'));
  }

  async createCustomValue(conn: GhlConnection, input: { name: string; value: string }) {
    const raw = await this.http.request({ method: 'POST', path: `${this.base(conn)}/customValues`, retry: 'no-retry', body: input }, this.provider(conn));
    return this.value(conn, this.unwrap(raw, 'customValue'));
  }

  async updateCustomValue(conn: GhlConnection, id: string, input: { name: string; value: string }) {
    const raw = await this.http.request({ method: 'PUT', path: `${this.base(conn)}/customValues/${encodeURIComponent(id)}`, retry: 'idempotent', body: input }, this.provider(conn));
    return this.value(conn, this.unwrap(raw, 'customValue'));
  }

  private unwrap(raw: unknown, key: 'customField' | 'customValue'): unknown {
    if (raw && typeof raw === 'object' && key in raw) return (raw as Record<string, unknown>)[key];
    throw new GhlApiError('GHL_INVALID_RESPONSE');
  }

  private field(conn: GhlConnection, raw: unknown): RemoteCustomField {
    const p = fieldSchema.safeParse(raw);
    if (!p.success) throw new GhlApiError('GHL_INVALID_RESPONSE');
    if (p.data.locationId && p.data.locationId !== conn.locationId) throw new GhlApiError('GHL_FOREIGN_LOCATION');
    return { id: p.data.id, name: p.data.name, fieldKey: p.data.fieldKey ?? null, dataType: p.data.dataType ?? null, model: p.data.model ?? null };
  }

  private value(conn: GhlConnection, raw: unknown): RemoteCustomValue {
    const p = valueSchema.safeParse(raw);
    if (!p.success) throw new GhlApiError('GHL_INVALID_RESPONSE');
    if (p.data.locationId && p.data.locationId !== conn.locationId) throw new GhlApiError('GHL_FOREIGN_LOCATION');
    return { id: p.data.id, name: p.data.name, fieldKey: p.data.fieldKey ?? null, value: p.data.value ?? null };
  }
}

/** ADAPTADOR SIMULADO (GHL_MODE=mock): estado en memoria por location; nunca contacta a GHL. */
@Injectable()
export class MockGhlProvisioningClient extends GhlProvisioningClient {
  readonly mode = 'mock' as const;
  private seq = 0;
  private readonly fields = new Map<string, Map<string, RemoteCustomField>>();
  private readonly values = new Map<string, Map<string, RemoteCustomValue>>();

  private bucket<T>(m: Map<string, Map<string, T>>, loc: string) {
    let b = m.get(loc);
    if (!b) m.set(loc, (b = new Map()));
    return b;
  }
  private slug = (name: string) => name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

  async listCustomFields(conn: GhlConnection) {
    return [...this.bucket(this.fields, conn.locationId).values()].map(f => ({ ...f }));
  }
  async getCustomField(conn: GhlConnection, id: string) {
    const f = this.bucket(this.fields, conn.locationId).get(id);
    if (!f) throw new GhlApiError('GHL_NOT_FOUND', 404);
    return { ...f };
  }
  async createCustomField(conn: GhlConnection, input: CreateCustomFieldInput) {
    const f: RemoteCustomField = { id: `mock_cf_${++this.seq}`, name: input.name, fieldKey: `contact.${this.slug(input.name)}`, dataType: input.dataType, model: input.model };
    this.bucket(this.fields, conn.locationId).set(f.id, f);
    return { ...f };
  }
  async listCustomValues(conn: GhlConnection) {
    return [...this.bucket(this.values, conn.locationId).values()].map(v => ({ ...v }));
  }
  async getCustomValue(conn: GhlConnection, id: string) {
    const v = this.bucket(this.values, conn.locationId).get(id);
    if (!v) throw new GhlApiError('GHL_NOT_FOUND', 404);
    return { ...v };
  }
  async createCustomValue(conn: GhlConnection, input: { name: string; value: string }) {
    const v: RemoteCustomValue = { id: `mock_cv_${++this.seq}`, name: input.name, fieldKey: `{{ custom_values.${this.slug(input.name)} }}`, value: input.value };
    this.bucket(this.values, conn.locationId).set(v.id, v);
    return { ...v };
  }
  async updateCustomValue(conn: GhlConnection, id: string, input: { name: string; value: string }) {
    const v = await this.getCustomValue(conn, id);
    const next = { ...v, ...input };
    this.bucket(this.values, conn.locationId).set(id, next);
    return { ...next };
  }
}
