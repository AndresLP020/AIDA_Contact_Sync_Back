import { backoffDelay, GhlHttp, type TokenProvider } from './ghl-http';
import { GhlApiError } from './ghl-errors';

const json = (status: number, body: unknown = {}, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function setup(responses: Array<Response | Error>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const sleeps: number[] = [];
  const fetchFn = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('sin respuesta preparada');
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  const http = new GhlHttp({ apiBase: 'https://ghl.test', apiVersion: '2021-07-28', fetchFn, sleep: async ms => void sleeps.push(ms), random: () => 0.5, baseDelayMs: 100 });
  let version = 1;
  const tokens: TokenProvider = jest.fn(async (stale?: number) => {
    if (stale !== undefined) version = stale + 1;
    return { token: `tok-${version}`, version };
  });
  return { http, calls, sleeps, tokens, fetchFn };
}

describe('GhlHttp — reintentos, backoff y manejo de errores HTTP', () => {
  it('envía Authorization Bearer y el encabezado Version oficial', async () => {
    const { http, calls, tokens } = setup([json(200, { ok: true })]);
    await http.request({ method: 'GET', path: '/contacts/abc', retry: 'safe' }, tokens);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(calls[0].url).toBe('https://ghl.test/contacts/abc');
    expect(headers.authorization).toBe('Bearer tok-1');
    expect(headers.Version).toBe('2021-07-28');
  });

  it('reintenta 429 respetando Retry-After y luego tiene éxito', async () => {
    const { http, sleeps, tokens } = setup([json(429, {}, { 'retry-after': '2' }), json(200, { ok: 1 })]);
    await expect(http.request({ method: 'GET', path: '/x', retry: 'safe' }, tokens)).resolves.toEqual({ ok: 1 });
    expect(sleeps).toEqual([2000]);
  });

  it('tras agotar intentos con 429 lanza GHL_RATE_LIMITED', async () => {
    const { http, fetchFn, tokens } = setup([json(429), json(429), json(429), json(429)]);
    await expect(http.request({ method: 'GET', path: '/x', retry: 'safe' }, tokens)).rejects.toMatchObject({ code: 'GHL_RATE_LIMITED' });
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('reintenta 5xx en operaciones seguras', async () => {
    const { http, fetchFn, tokens } = setup([json(502), json(503), json(200, { ok: 1 })]);
    await expect(http.request({ method: 'POST', path: '/contacts/search', retry: 'safe', body: {} }, tokens)).resolves.toEqual({ ok: 1 });
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it('NO reintenta un 5xx en creaciones (evita duplicados)', async () => {
    const { http, fetchFn, tokens } = setup([json(500), json(200)]);
    await expect(http.request({ method: 'POST', path: '/contacts/', retry: 'no-retry', body: {} }, tokens)).rejects.toMatchObject({ code: 'GHL_UNAVAILABLE' });
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('NO reintenta un error de red en creaciones, sí en lecturas', async () => {
    const a = setup([new TypeError('fetch failed')]);
    await expect(a.http.request({ method: 'POST', path: '/contacts/', retry: 'no-retry', body: {} }, a.tokens)).rejects.toMatchObject({ code: 'GHL_NETWORK' });
    const b = setup([new TypeError('fetch failed'), json(200, { ok: 1 })]);
    await expect(b.http.request({ method: 'GET', path: '/x', retry: 'safe' }, b.tokens)).resolves.toEqual({ ok: 1 });
  });

  it('ante 401 fuerza una única renovación del token y repite', async () => {
    const { http, calls, tokens } = setup([json(401), json(200, { ok: 1 })]);
    await http.request({ method: 'GET', path: '/x', retry: 'safe' }, tokens);
    expect(tokens).toHaveBeenLastCalledWith(1);
    expect((calls[1].init.headers as Record<string, string>).authorization).toBe('Bearer tok-2');
  });

  it('un segundo 401 se reporta como GHL_UNAUTHORIZED', async () => {
    const { http, tokens } = setup([json(401), json(401)]);
    await expect(http.request({ method: 'GET', path: '/x', retry: 'safe' }, tokens)).rejects.toMatchObject({ code: 'GHL_UNAUTHORIZED' });
  });

  it.each([
    [403, 'GHL_FORBIDDEN'],
    [404, 'GHL_NOT_FOUND'],
    [409, 'GHL_CONFLICT'],
    [422, 'GHL_VALIDATION'],
  ])('mapea %i a %s sin reintentar', async (status, code) => {
    const { http, fetchFn, tokens } = setup([json(status, { message: 'detalle interno de GHL' })]);
    const err = (await http.request({ method: "GET", path: "/x", retry: "safe" }, tokens).catch(e => e)) as GhlApiError;
    expect(err).toBeInstanceOf(GhlApiError);
    expect(err.code).toBe(code);
    expect(err.message).not.toContain('detalle interno');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('backoff exponencial con jitter acotado', () => {
    expect(backoffDelay(1, 100, 8000, () => 1)).toBe(200);
    expect(backoffDelay(3, 100, 8000, () => 1)).toBe(800);
    expect(backoffDelay(10, 100, 8000, () => 1)).toBe(8000);
    expect(backoffDelay(3, 100, 8000, () => 0)).toBe(0);
  });
});
