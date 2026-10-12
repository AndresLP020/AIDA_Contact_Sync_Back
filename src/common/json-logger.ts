import { LoggerService } from '@nestjs/common';

const SENSITIVE = /(token|secret|password|authorization|cookie|encrypted|refresh|code_verifier|payload)/i;

/** Elimina recursivamente valores de claves sensibles antes de escribir logs. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map(v => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE.test(k) ? '[REDACTED]' : redact(v, depth + 1)]),
  );
}

type Level = 'error' | 'warn' | 'info' | 'debug' | 'verbose' | 'fatal';

/** Logger estructurado (JSON por línea) apto para CloudWatch. */
export class JsonLogger implements LoggerService {
  constructor(private readonly silent = process.env.NODE_ENV === 'test') {}

  private write(level: Level, message: unknown, context?: string, extra?: Record<string, unknown>) {
    if (this.silent && level !== 'error' && level !== 'fatal') return;
    const base = typeof message === 'object' && message !== null ? (redact(message) as Record<string, unknown>) : { msg: String(message) };
    const line = JSON.stringify({ ts: new Date().toISOString(), level, context, ...base, ...(extra ? (redact(extra) as object) : {}) });
    (level === 'error' || level === 'fatal' ? process.stderr : process.stdout).write(line + '\n');
  }

  log(message: unknown, context?: string) { this.write('info', message, context); }
  error(message: unknown, trace?: string, context?: string) {
    this.write('error', message, context, trace && process.env.NODE_ENV !== 'production' ? { trace: String(trace).split('\n').slice(0, 6).join('\n') } : undefined);
  }
  warn(message: unknown, context?: string) { this.write('warn', message, context); }
  debug(message: unknown, context?: string) { this.write('debug', message, context); }
  verbose(message: unknown, context?: string) { this.write('verbose', message, context); }
  fatal(message: unknown, context?: string) { this.write('fatal', message, context); }
}
