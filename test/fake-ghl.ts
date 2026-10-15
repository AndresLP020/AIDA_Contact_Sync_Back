/**
 * Servidor GHL FALSO para pruebas de integración: emula los contratos oficiales usados por la app
 * (POST /oauth/token, POST /oauth/locationToken, GET /oauth/installedLocations, GET /locations/{id},
 * POST /contacts/search, GET/PUT /contacts/{id}, custom fields y custom values de una location)
 * e inyecta fallos (429, 5xx, red, 401, respuesta perdida tras crear).
 * Sustituye a `fetch` vía el token de inyección FETCH; ninguna prueba llama a GoHighLevel real.
 */
export type FakeContact = { id: string; locationId: string; firstName?: string; lastName?: string; email?: string; phone?: string; dateUpdated: string; customFields?: { id: string; value: string }[] };
export type FakeField = { id: string; name: string; fieldKey: string; dataType: string; model: string; locationId: string };
export type FakeValue = { id: string; name: string; fieldKey: string; value: string; locationId: string };

export const PROVISIONING_SCOPE = 'locations/customFields.readonly locations/customFields.write locations/customValues.readonly locations/customValues.write';
export const FULL_SCOPE = `contacts.readonly contacts.write ${PROVISIONING_SCOPE}`;

const slug = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

export class FakeGhl {
  readonly locationId = 'loc_test_123';
  contacts = new Map<string, FakeContact>();
  calls: { method: string; path: string; headers: Record<string, string>; body: string }[] = [];
  /**
   * Fallos a devolver (en orden) para una ruta "METHOD path-prefix".
   * commitThenFail: la operación SÍ se aplica en GHL pero la respuesta se pierde (timeout/5xx ambiguo).
   */
  failures: { match: string; status?: number; network?: boolean; headers?: Record<string, string>; commitThenFail?: boolean }[] = [];
  tokenCounter = 0;
  refreshCalls = 0;
  validAccessTokens = new Set<string>();
  validRefreshTokens = new Set<string>();
  rejectRefresh = false;
  tokenResponseOverride: Record<string, unknown> | null = null;
  tokenDelayMs = 0;
  /** Scopes concedidos en el intercambio del code (por defecto, sólo contactos: como las instalaciones existentes). */
  scope = 'contacts.readonly contacts.write';
  agencyId = 'agency_1';
  /** code → location autorizada (además de 'valid-code' → locationId). */
  codeLocations = new Map<string, { locationId: string; companyId?: string }>();
  /** Token de agencia: code que devuelve userType=Company. */
  agencyCode = 'agency-code';
  agencyScope = 'oauth.readonly oauth.write';
  /** Locations donde la app está instalada (para /oauth/installedLocations). */
  installedLocations: { _id: string; name: string; isInstalled: boolean }[] = [];
  locationNames = new Map<string, string>();
  /** location (o "agency:<id>") y scopes de cada access token emitido. */
  tokenInfo = new Map<string, { subject: string; scope: string }>();
  rejectCustomFieldWrites = false;
  fields = new Map<string, FakeField>();
  values = new Map<string, FakeValue>();
  private seq = 0;

  seedContacts(n: number) {
    for (let i = 1; i <= n; i++) {
      const id = `ghl_${String(i).padStart(4, '0')}`;
      this.contacts.set(id, { id, locationId: this.locationId, firstName: `Nombre${i}`, lastName: `Apellido${i}`, email: `c${i}@example.test`, phone: `+52 55 0000 ${String(i).padStart(4, '0')}`, dateUpdated: '2026-09-01T00:00:00.000Z' });
    }
  }

  /** Crea un campo directamente "en GHL" (preexistente, creado por el cliente). */
  addField(locationId: string, name: string, dataType = 'TEXT', model = 'contact') {
    const f: FakeField = { id: `cf_pre_${++this.seq}`, name, fieldKey: `contact.${slug(name)}`, dataType, model, locationId };
    this.fields.set(f.id, f);
    return f;
  }
  addValue(locationId: string, name: string, value: string) {
    const v: FakeValue = { id: `cv_pre_${++this.seq}`, name, fieldKey: `{{ custom_values.${slug(name)} }}`, value, locationId };
    this.values.set(v.id, v);
    return v;
  }
  fieldsOf(locationId: string) {
    return [...this.fields.values()].filter(f => f.locationId === locationId);
  }
  valuesOf(locationId: string) {
    return [...this.values.values()].filter(v => v.locationId === locationId);
  }

  private issue(subject: string, scope: string, withRefresh = true) {
    this.tokenCounter++;
    const access = `fake-access-${this.tokenCounter}-${Math.random().toString(36).slice(2)}`;
    const refresh = `fake-refresh-${this.tokenCounter}-${Math.random().toString(36).slice(2)}`;
    this.validAccessTokens.add(access);
    this.tokenInfo.set(access, { subject, scope });
    if (withRefresh) {
      this.validRefreshTokens.add(refresh);
      this.tokenInfo.set(refresh, { subject, scope });
    }
    return { access, refresh };
  }

  private json(status: number, body: unknown, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = typeof init.body === 'string' ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : '';
    this.calls.push({ method, path: url.pathname, headers, body });

    const failureIndex = this.failures.findIndex(f => `${method} ${url.pathname}`.startsWith(f.match));
    if (failureIndex >= 0) {
      const [f] = this.failures.splice(failureIndex, 1);
      if (f.commitThenFail) await this.handle(url, method, headers, body);
      if (f.network) throw new TypeError('fetch failed');
      return this.json(f.status ?? 500, { message: 'fallo simulado' }, f.headers);
    }
    return this.handle(url, method, headers, body);
  };

  private async handle(url: URL, method: string, headers: Record<string, string>, body: string): Promise<Response> {
    if (url.pathname === '/oauth/token' && method === 'POST') {
      const form = new URLSearchParams(body);
      if (this.tokenDelayMs) await new Promise(r => setTimeout(r, this.tokenDelayMs));
      if (form.get('client_id') !== 'test-client' || form.get('client_secret') !== 'test-secret') return this.json(401, { error: 'invalid_client' });
      if (form.get('grant_type') === 'authorization_code') {
        const code = form.get('code') ?? '';
        if (code === this.agencyCode) {
          const t = this.issue(`agency:${this.agencyId}`, this.agencyScope);
          return this.json(200, { access_token: t.access, refresh_token: t.refresh, expires_in: 86399, token_type: 'Bearer', scope: this.agencyScope, userType: 'Company', companyId: this.agencyId, userId: 'ghl_user_1', isBulkInstallation: true });
        }
        const target = code === 'valid-code' ? { locationId: this.locationId, companyId: this.agencyId } : this.codeLocations.get(code);
        if (!target) return this.json(400, { error: 'invalid_grant' });
        const t = this.issue(target.locationId, this.scope);
        return this.json(200, this.tokenResponseOverride ?? { access_token: t.access, refresh_token: t.refresh, expires_in: 86399, token_type: 'Bearer', scope: this.scope, userType: 'Location', locationId: target.locationId, companyId: target.companyId ?? this.agencyId, userId: 'ghl_user_1' });
      }
      if (form.get('grant_type') === 'refresh_token') {
        this.refreshCalls++;
        const rt = form.get('refresh_token') ?? '';
        if (this.rejectRefresh || !this.validRefreshTokens.has(rt)) return this.json(400, { error: 'invalid_grant' });
        this.validRefreshTokens.delete(rt); // refresh token de un solo uso (como GHL)
        const info = this.tokenInfo.get(rt) ?? { subject: this.locationId, scope: this.scope };
        const t = this.issue(info.subject, info.scope);
        return this.json(200, { access_token: t.access, refresh_token: t.refresh, expires_in: 86399, scope: info.scope, userType: info.subject.startsWith('agency:') ? 'Company' : 'Location', ...(info.subject.startsWith('agency:') ? {} : { locationId: info.subject }) });
      }
      return this.json(400, { error: 'unsupported_grant_type' });
    }

    const token = headers.authorization?.replace(/^Bearer /, '') ?? '';
    if (!this.validAccessTokens.has(token)) return this.json(401, { message: 'Invalid JWT' });
    if (!headers.version) return this.json(400, { message: 'Version header required' });
    const info = this.tokenInfo.get(token) ?? { subject: this.locationId, scope: this.scope };

    // ── Endpoints de agencia ──
    if (url.pathname === '/oauth/installedLocations' && method === 'GET') {
      if (!info.subject.startsWith('agency:') || !info.scope.includes('oauth.readonly')) return this.json(401, { message: 'not authorized for this scope' });
      if (url.searchParams.get('companyId') !== this.agencyId || !url.searchParams.get('appId')) return this.json(422, { message: 'companyId/appId required' });
      const skip = Number(url.searchParams.get('skip') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 20);
      const list = this.installedLocations.filter(l => url.searchParams.get('isInstalled') !== 'true' || l.isInstalled);
      return this.json(200, { locations: list.slice(skip, skip + limit).map(l => ({ ...l, address: '' })), count: list.length });
    }
    if (url.pathname === '/oauth/locationToken' && method === 'POST') {
      if (!info.subject.startsWith('agency:') || !info.scope.includes('oauth.write')) return this.json(401, { message: 'not authorized for this scope' });
      const form = new URLSearchParams(body);
      const loc = form.get('locationId') ?? '';
      if (form.get('companyId') !== this.agencyId || !this.installedLocations.some(l => l._id === loc && l.isInstalled)) return this.json(400, { message: 'app not installed in location' });
      const t = this.issue(loc, FULL_SCOPE, false);
      return this.json(200, { access_token: t.access, token_type: 'Bearer', expires_in: 86399, scope: FULL_SCOPE, locationId: loc, userId: 'ghl_user_1' });
    }

    // ── Location ──
    const locMatch = /^\/locations\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (locMatch) {
      const loc = decodeURIComponent(locMatch[1]);
      if (info.subject !== loc) return this.json(403, { message: 'token does not belong to this location' });
      const rest = locMatch[2] ?? '';
      const parsed = body ? (JSON.parse(body) as Record<string, string>) : {};
      if (rest === '' && method === 'GET') {
        if (!info.scope.includes('locations.readonly')) return this.json(401, { message: 'not authorized for this scope' });
        return this.json(200, { location: { id: loc, name: this.locationNames.get(loc) ?? 'Sin nombre', companyId: this.agencyId } });
      }
      const fieldsMatch = /^\/customFields(?:\/([^/]+))?$/.exec(rest);
      if (fieldsMatch) {
        const need = method === 'GET' ? 'locations/customFields.readonly' : 'locations/customFields.write';
        if (!info.scope.includes(need)) return this.json(401, { message: 'not authorized for this scope' });
        const id = fieldsMatch[1] && decodeURIComponent(fieldsMatch[1]);
        if (!id && method === 'GET') return this.json(200, { customFields: this.fieldsOf(loc) });
        if (!id && method === 'POST') {
          if (!parsed.name || !parsed.dataType) return this.json(422, { message: 'name and dataType required' });
          const f: FakeField = { id: `cf_${++this.seq}`, name: parsed.name, fieldKey: `contact.${slug(parsed.name)}`, dataType: parsed.dataType, model: parsed.model ?? 'contact', locationId: loc };
          this.fields.set(f.id, f);
          return this.json(201, { customField: f });
        }
        const f = id ? this.fields.get(id) : undefined;
        if (!f || f.locationId !== loc) return this.json(404, { message: 'Custom field not found' });
        if (method === 'GET') return this.json(200, { customField: f });
      }
      const valuesMatch = /^\/customValues(?:\/([^/]+))?$/.exec(rest);
      if (valuesMatch) {
        const need = method === 'GET' ? 'locations/customValues.readonly' : 'locations/customValues.write';
        if (!info.scope.includes(need)) return this.json(401, { message: 'not authorized for this scope' });
        const id = valuesMatch[1] && decodeURIComponent(valuesMatch[1]);
        if (!id && method === 'GET') return this.json(200, { customValues: this.valuesOf(loc) });
        if (!id && method === 'POST') {
          if (!parsed.name || parsed.value === undefined) return this.json(422, { message: 'name and value required' });
          const v: FakeValue = { id: `cv_${++this.seq}`, name: parsed.name, fieldKey: `{{ custom_values.${slug(parsed.name)} }}`, value: parsed.value, locationId: loc };
          this.values.set(v.id, v);
          return this.json(201, { customValue: v });
        }
        const v = id ? this.values.get(id) : undefined;
        if (!v || v.locationId !== loc) return this.json(404, { message: 'Custom value not found' });
        if (method === 'GET') return this.json(200, { customValue: v });
        if (method === 'PUT') {
          Object.assign(v, { name: parsed.name ?? v.name, value: parsed.value ?? v.value });
          return this.json(200, { customValue: v });
        }
      }
      return this.json(404, { message: 'not found' });
    }

    // ── Contactos ──
    if (url.pathname === '/contacts/search' && method === 'POST') {
      const q = JSON.parse(body) as { locationId: string; page: number; pageLimit: number };
      if (q.locationId !== this.locationId) return this.json(403, { message: 'location mismatch' });
      const all = [...this.contacts.values()].filter(c => c.locationId === this.locationId || q.locationId);
      const start = (q.page - 1) * q.pageLimit;
      return this.json(200, { contacts: all.slice(start, start + q.pageLimit), total: all.length });
    }
    const m = /^\/contacts\/([^/]+)$/.exec(url.pathname);
    if (m) {
      const c = this.contacts.get(decodeURIComponent(m[1]));
      if (!c) return this.json(404, { message: 'Contact not found' });
      if (method === 'GET') return this.json(200, { contact: c });
      if (method === 'PUT') {
        const patch = JSON.parse(body) as Partial<FakeContact> & { customFields?: { id: string; field_value: string }[] };
        if ('locationId' in patch || 'id' in patch) return this.json(422, { message: 'property should not exist' });
        if (patch.customFields && this.rejectCustomFieldWrites) return this.json(422, { message: 'customFields rechazados (simulado)' });
        if (patch.customFields) {
          // Sólo modifica los custom fields enviados; conserva los demás.
          const current = new Map((c.customFields ?? []).map(cf => [cf.id, cf.value]));
          for (const cf of patch.customFields) current.set(cf.id, cf.field_value);
          c.customFields = [...current].map(([id, value]) => ({ id, value }));
          delete patch.customFields;
        }
        if (patch.phone) patch.phone = '+' + patch.phone.replace(/\D/g, ''); // GHL normaliza a E.164
        Object.assign(c, patch, { dateUpdated: new Date().toISOString() });
        return this.json(200, { succeded: true, contact: c });
      }
    }
    return this.json(404, { message: 'not found' });
  }

  /** Simula una edición hecha por alguien directamente en GHL. */
  editRemotely(id: string, fields: Partial<FakeContact>) {
    Object.assign(this.contacts.get(id)!, fields, { dateUpdated: new Date().toISOString() });
  }
}
