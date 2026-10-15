import { z } from 'zod';

/** Clave pública Ed25519 oficial de HighLevel para X-GHL-Signature (docs: Webhook Integration Guide). */
export const GHL_OFFICIAL_WEBHOOK_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=
-----END PUBLIC KEY-----`;

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .optional()
  .transform(v => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatorio'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET debe tener al menos 32 caracteres'),
  TOKEN_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'TOKEN_ENCRYPTION_KEY debe tener 64 caracteres hexadecimales'),
  SESSION_TTL_MINUTES: z.coerce.number().int().min(5).max(720).default(30),
  FRONTEND_ORIGIN: z.string().default('http://localhost:3000'),
  TRUST_PROXY: bool,
  SWAGGER_ENABLED: bool,
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(300),
  // GHL_MODE no tiene valor por defecto: el modo simulado debe declararse explícitamente.
  GHL_MODE: z.enum(['mock', 'real'], { message: 'GHL_MODE debe ser "mock" o "real"' }),
  GHL_CLIENT_ID: z.string().optional().default(''),
  GHL_CLIENT_SECRET: z.string().optional().default(''),
  GHL_APP_SHARED_SECRET: z.string().optional().default(''),
  GHL_APP_ID: z.string().optional().default(''),
  GHL_REDIRECT_URI: z.string().optional().default(''),
  GHL_SCOPES: z.string().default('contacts.readonly contacts.write locations/customFields.readonly locations/customFields.write locations/customValues.readonly locations/customValues.write'),
  GHL_AUTHORIZE_URL: z.string().url().default('https://marketplace.gohighlevel.com/v2/oauth/chooselocation'),
  GHL_API_BASE: z.string().url().default('https://services.leadconnectorhq.com'),
  GHL_API_VERSION: z.string().min(1).default('2021-07-28'),
  GHL_WEBHOOK_PUBLIC_KEY: z.string().optional().default(''),
  GHL_ALLOW_CONTACT_CREATE: bool,
  // Instalación iniciada desde Marketplace (callback SIN state propio). Desactivado por defecto: activarlo es una
  // decisión explícita. La legitimidad proviene del intercambio del code con el Client Secret, nunca de la sesión.
  GHL_MARKETPLACE_INSTALL_ENABLED: bool,
  // Escritura de metadatos AIDA (custom fields) en contactos durante exportaciones autorizadas. Desactivado hasta
  // validar con GHL real la semántica de PUT /contacts/{id} con customFields.
  GHL_SYNC_METADATA_WRITE: bool,
  PROVISIONING_WORKER_ENABLED: z.enum(['true', 'false', '1', '0']).default('true').transform(v => v === 'true' || v === '1'),
  PROVISIONING_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(600_000).default(5_000),
  PROVISIONING_LEASE_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(120_000),
});

export type AppConfig = {
  env: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  jwtSecret: string;
  tokenEncryptionKey: Buffer;
  sessionTtlMinutes: number;
  frontendOrigins: string[];
  trustProxy: boolean;
  swaggerEnabled: boolean;
  rateLimitPerMinute: number;
  cookieSecure: boolean;
  ghl: {
    mode: 'mock' | 'real';
    clientId: string;
    clientSecret: string;
    sharedSecret: string;
    appId: string;
    redirectUri: string;
    scopes: string[];
    authorizeUrl: string;
    apiBase: string;
    apiVersion: string;
    webhookPublicKey: string;
    allowContactCreate: boolean;
    marketplaceInstallEnabled: boolean;
    syncMetadataWrite: boolean;
  };
  provisioning: { workerEnabled: boolean; pollIntervalMs: number; leaseMs: number };
};

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Configuración inválida: ${issues}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';
  const frontendOrigins = e.FRONTEND_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);
  const problems: string[] = [];

  if (isProduction && e.GHL_MODE !== 'real') problems.push('GHL_MODE=mock no está permitido en producción');
  if (isProduction && frontendOrigins.some(o => !o.startsWith('https://'))) problems.push('FRONTEND_ORIGIN debe usar HTTPS en producción');
  if (e.GHL_MODE === 'real') {
    if (!e.GHL_CLIENT_ID || !e.GHL_CLIENT_SECRET) problems.push('GHL_MODE=real requiere GHL_CLIENT_ID y GHL_CLIENT_SECRET');
    if (!e.GHL_REDIRECT_URI) problems.push('GHL_MODE=real requiere GHL_REDIRECT_URI');
    if (isProduction && !e.GHL_REDIRECT_URI.startsWith('https://')) problems.push('GHL_REDIRECT_URI debe usar HTTPS en producción');
  }
  if (problems.length) throw new ConfigError(`Configuración inválida: ${problems.join('; ')}`);

  return {
    env: e.NODE_ENV,
    isProduction,
    port: e.PORT,
    jwtSecret: e.JWT_SECRET,
    tokenEncryptionKey: Buffer.from(e.TOKEN_ENCRYPTION_KEY, 'hex'),
    sessionTtlMinutes: e.SESSION_TTL_MINUTES,
    frontendOrigins,
    trustProxy: e.TRUST_PROXY,
    swaggerEnabled: !isProduction || e.SWAGGER_ENABLED,
    rateLimitPerMinute: e.RATE_LIMIT_PER_MINUTE,
    cookieSecure: isProduction,
    ghl: {
      mode: e.GHL_MODE,
      clientId: e.GHL_CLIENT_ID,
      clientSecret: e.GHL_CLIENT_SECRET,
      sharedSecret: e.GHL_APP_SHARED_SECRET,
      appId: e.GHL_APP_ID,
      redirectUri: e.GHL_REDIRECT_URI,
      scopes: e.GHL_SCOPES.split(/[\s,]+/).filter(Boolean),
      authorizeUrl: e.GHL_AUTHORIZE_URL,
      apiBase: e.GHL_API_BASE.replace(/\/+$/, ''),
      apiVersion: e.GHL_API_VERSION,
      webhookPublicKey: e.GHL_WEBHOOK_PUBLIC_KEY || GHL_OFFICIAL_WEBHOOK_PUBLIC_KEY,
      allowContactCreate: e.GHL_ALLOW_CONTACT_CREATE,
      marketplaceInstallEnabled: e.GHL_MARKETPLACE_INSTALL_ENABLED,
      syncMetadataWrite: e.GHL_SYNC_METADATA_WRITE,
    },
    provisioning: { workerEnabled: e.PROVISIONING_WORKER_ENABLED, pollIntervalMs: e.PROVISIONING_POLL_INTERVAL_MS, leaseMs: e.PROVISIONING_LEASE_MS },
  };
}

export const APP_CONFIG = Symbol('APP_CONFIG');
