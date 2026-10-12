/**
 * Servidor GHL FALSO para pruebas de integración: emula los contratos oficiales usados por la app
 * (POST /oauth/token, POST /contacts/search, GET/PUT /contacts/{id}) e inyecta fallos (429, 5xx, red, 401).
 * Sustituye a `fetch` vía el token de inyección FETCH; ninguna prueba llama a GoHighLevel real.
 */
export type FakeContact = { id: string; locationId: string; firstName?: string; lastName?: string; email?: string; phone?: string; dateUpdated: string };

export class FakeGhl {
  readonly locationId = 'loc_test_123';
  contacts = new Map<string, FakeContact>();
  calls: { method: string; path: string; headers: Record<string, string>; body: string }[] = [];
  /** Fallos a devolver (en orden) para una ruta "METHOD path-prefix". */
  failures: { match: string; status?: number; network?: boolean; headers?: Record<string, string> }[] = [];
  tokenCounter = 0;
  refreshCalls = 0;
  validAccessTokens = new Set<string>();
  validRefreshTokens = new Set<string>();
  rejectRefresh = false;
  tokenResponseOverride: Record<string, unknown> | null = null;
  tokenDelayMs = 0;

  seedContacts(n: number) {
    for (let i = 1; i <= n; i++) {
      const id = `ghl_${String(i).padStart(4, '0')}`;
      this.contacts.set(id, { id, locationId: this.locationId, firstName: `Nombre${i}`, lastName: `Apellido${i}`, email: `c${i}@example.test`, phone: `+52 55 0000 ${String(i).padStart(4, '0')}`, dateUpdated: '2026-09-01T00:00:00.000Z' });
    }
  }

  private issue() {
    this.tokenCounter++;
    const access = `fake-access-${this.tokenCounter}-${Math.random().toString(36).slice(2)}`;
    const refresh = `fake-refresh-${this.tokenCounter}-${Math.random().toString(36).slice(2)}`;
    this.validAccessTokens.add(access);
    this.validRefreshTokens.add(refresh);
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
      if (f.network) throw new TypeError('fetch failed');
      return this.json(f.status ?? 500, { message: 'fallo simulado' }, f.headers);
    }

    if (url.pathname === '/oauth/token' && method === 'POST') {
      const form = new URLSearchParams(body);
      if (this.tokenDelayMs) await new Promise(r => setTimeout(r, this.tokenDelayMs));
      if (form.get('client_id') !== 'test-client' || form.get('client_secret') !== 'test-secret') return this.json(401, { error: 'invalid_client' });
      if (form.get('grant_type') === 'authorization_code') {
        if (form.get('code') !== 'valid-code') return this.json(400, { error: 'invalid_grant' });
        const t = this.issue();
        return this.json(200, this.tokenResponseOverride ?? { access_token: t.access, refresh_token: t.refresh, expires_in: 86399, token_type: 'Bearer', scope: 'contacts.readonly contacts.write', userType: 'Location', locationId: this.locationId, companyId: 'agency_1', userId: 'ghl_user_1' });
      }
      if (form.get('grant_type') === 'refresh_token') {
        this.refreshCalls++;
        const rt = form.get('refresh_token') ?? '';
        if (this.rejectRefresh || !this.validRefreshTokens.has(rt)) return this.json(400, { error: 'invalid_grant' });
        this.validRefreshTokens.delete(rt); // refresh token de un solo uso (como GHL)
        const t = this.issue();
        return this.json(200, { access_token: t.access, refresh_token: t.refresh, expires_in: 86399, scope: 'contacts.readonly contacts.write', userType: 'Location', locationId: this.locationId });
      }
      return this.json(400, { error: 'unsupported_grant_type' });
    }

    const token = headers.authorization?.replace(/^Bearer /, '') ?? '';
    if (!this.validAccessTokens.has(token)) return this.json(401, { message: 'Invalid JWT' });
    if (!headers.version) return this.json(400, { message: 'Version header required' });

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
        const patch = JSON.parse(body) as Partial<FakeContact>;
        if ('locationId' in patch || 'id' in patch) return this.json(422, { message: 'property should not exist' });
        if (patch.phone) patch.phone = '+' + patch.phone.replace(/\D/g, ''); // GHL normaliza a E.164
        Object.assign(c, patch, { dateUpdated: new Date().toISOString() });
        return this.json(200, { succeded: true, contact: c });
      }
    }
    return this.json(404, { message: 'not found' });
  };

  /** Simula una edición hecha por alguien directamente en GHL. */
  editRemotely(id: string, fields: Partial<FakeContact>) {
    Object.assign(this.contacts.get(id)!, fields, { dateUpdated: new Date().toISOString() });
  }
}
