import { Logger } from '@nestjs/common';
import { GhlApiError } from './ghl-errors';
import type { FetchFn } from '../tokens/ghl-token.service';

/**
 * Política de reintentos según la semántica de la operación:
 *  - 'safe'        lecturas (GET, POST /contacts/search): reintenta 429, 5xx y errores de red.
 *  - 'idempotent'  PUT con valores absolutos: igual que 'safe' (repetirlo produce el mismo estado).
 *  - 'no-retry'    creaciones: sólo reintenta 429 (GHL no procesó la solicitud). Un 5xx o timeout es ambiguo
 *                  y repetirlo podría duplicar el contacto, así que se devuelve el error.
 */
export type RetryPolicy = 'safe' | 'idempotent' | 'no-retry';

export type TokenProvider = (staleVersion?: number) => Promise<{ token: string; version: number }>;

export type GhlHttpOptions = {
  apiBase: string;
  apiVersion: string;
  fetchFn: FetchFn;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

export type GhlRequest = { method: 'GET' | 'POST' | 'PUT'; path: string; body?: unknown; retry: RetryPolicy };

/** Backoff exponencial con jitter completo: espera aleatoria en [0, min(max, base·2^intento)]. */
export function backoffDelay(attempt: number, base: number, max: number, random: () => number) {
  return Math.round(random() * Math.min(max, base * 2 ** attempt));
}

export class GhlHttp {
  private readonly logger = new Logger('GhlHttp');
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly opts: GhlHttpOptions) {
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.baseDelayMs = opts.baseDelayMs ?? 400;
    this.maxDelayMs = opts.maxDelayMs ?? 8_000;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
  }

  async request<T = unknown>(req: GhlRequest, tokens: TokenProvider): Promise<T> {
    let access = await tokens();
    let refreshedAfter401 = false;
    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await this.opts.fetchFn(`${this.opts.apiBase}${req.path}`, {
          method: req.method,
          headers: {
            authorization: `Bearer ${access.token}`,
            accept: 'application/json',
            Version: this.opts.apiVersion,
            ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        if (req.retry !== 'no-retry' && attempt < this.maxAttempts) {
          await this.wait(attempt, 'network');
          continue;
        }
        throw new GhlApiError('GHL_NETWORK');
      }

      if (response.ok) {
        try {
          return (await response.json()) as T;
        } catch {
          throw new GhlApiError('GHL_INVALID_RESPONSE', response.status);
        }
      }

      const status = response.status;
      // 401: el token pudo expirar o rotarse en otra instancia. Se fuerza UNA renovación y se repite.
      if (status === 401 && !refreshedAfter401) {
        refreshedAfter401 = true;
        access = await tokens(access.version);
        continue;
      }
      if (status === 429) {
        const retryAfter = this.retryAfterMs(response);
        if (attempt < this.maxAttempts) {
          await this.wait(attempt, 'rate_limited', retryAfter);
          continue;
        }
        throw new GhlApiError('GHL_RATE_LIMITED', 429, retryAfter ? Math.ceil(retryAfter / 1000) : undefined);
      }
      if (status >= 500) {
        if (req.retry !== 'no-retry' && attempt < this.maxAttempts) {
          await this.wait(attempt, 'server_error');
          continue;
        }
        throw new GhlApiError('GHL_UNAVAILABLE', status);
      }
      throw new GhlApiError(this.codeFor(status), status);
    }
  }

  private codeFor(status: number) {
    if (status === 401) return 'GHL_UNAUTHORIZED' as const;
    if (status === 403) return 'GHL_FORBIDDEN' as const;
    if (status === 404) return 'GHL_NOT_FOUND' as const;
    if (status === 409) return 'GHL_CONFLICT' as const;
    if (status === 400 || status === 422) return 'GHL_VALIDATION' as const;
    return 'GHL_UNAVAILABLE' as const;
  }

  /** Respeta Retry-After o X-RateLimit-Interval-Milliseconds (encabezados documentados por GHL). */
  private retryAfterMs(response: Response): number | undefined {
    const retryAfter = Number(response.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter * 1000, 60_000);
    const remaining = response.headers.get('x-ratelimit-remaining');
    const interval = Number(response.headers.get('x-ratelimit-interval-milliseconds'));
    if (remaining === '0' && Number.isFinite(interval) && interval > 0) return Math.min(interval, 60_000);
    return undefined;
  }

  private async wait(attempt: number, reason: string, minimumMs?: number) {
    const delay = Math.max(minimumMs ?? 0, backoffDelay(attempt, this.baseDelayMs, this.maxDelayMs, this.random));
    this.logger.warn({ msg: 'ghl_retry', reason, attempt, delayMs: delay });
    await this.sleep(delay);
  }
}
