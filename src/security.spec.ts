import { generateKeyPairSync, sign } from 'node:crypto';
import { decryptGhlContext, encryptGhlContextForTests } from './auth/ghl-context';
import { hashPassword, verifyPassword } from './auth/password';
import { ConfigError, loadConfig } from './config/app-config';
import { redact } from './common/json-logger';
import { TokenCipher } from './ghl/tokens/token-cipher.service';
import { verifyGhlSignature } from './ghl/webhooks/webhook-signature';

const baseEnv = { DATABASE_URL: 'postgresql://x', JWT_SECRET: 'j'.repeat(40), TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32), GHL_MODE: 'mock' };

describe('Configuración y separación de entornos', () => {
  it('exige declarar GHL_MODE explícitamente (el mock nunca se activa en silencio)', () => {
    expect(() => loadConfig({ ...baseEnv, GHL_MODE: undefined })).toThrow(ConfigError);
  });
  it('rechaza GHL_MODE=mock en producción', () => {
    expect(() => loadConfig({ ...baseEnv, NODE_ENV: 'production', FRONTEND_ORIGIN: 'https://app.test' })).toThrow(/mock no está permitido/);
  });
  it('en modo real exige client id/secret y redirect HTTPS en producción', () => {
    expect(() => loadConfig({ ...baseEnv, GHL_MODE: 'real' })).toThrow(/GHL_CLIENT_ID/);
    expect(() => loadConfig({ ...baseEnv, NODE_ENV: 'production', GHL_MODE: 'real', GHL_CLIENT_ID: 'a', GHL_CLIENT_SECRET: 'b', GHL_REDIRECT_URI: 'http://x', FRONTEND_ORIGIN: 'https://app.test' })).toThrow(/HTTPS/);
  });
  it('rechaza secretos débiles', () => {
    expect(() => loadConfig({ ...baseEnv, JWT_SECRET: 'corto' })).toThrow(/JWT_SECRET/);
    expect(() => loadConfig({ ...baseEnv, TOKEN_ENCRYPTION_KEY: 'zz' })).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });
  it('en producción las cookies son Secure y Swagger se desactiva por defecto', () => {
    const c = loadConfig({ ...baseEnv, NODE_ENV: 'production', GHL_MODE: 'real', GHL_CLIENT_ID: 'a', GHL_CLIENT_SECRET: 'b', GHL_REDIRECT_URI: 'https://api.test/cb', FRONTEND_ORIGIN: 'https://app.test' });
    expect(c.cookieSecure).toBe(true);
    expect(c.swaggerEnabled).toBe(false);
  });
});

describe('Cifrado de tokens en reposo (AES-256-GCM)', () => {
  const cipher = new TokenCipher(loadConfig(baseEnv));
  it('cifra, no contiene el texto plano y descifra', () => {
    const enc = cipher.encrypt('refresh-token-ficticio', 'inst-1');
    expect(enc).not.toContain('refresh-token-ficticio');
    expect(cipher.decrypt(enc, 'inst-1')).toBe('refresh-token-ficticio');
  });
  it('detecta manipulación y uso en otra instalación (AAD)', () => {
    const enc = cipher.encrypt('secreto', 'inst-1');
    expect(() => cipher.decrypt(enc.slice(0, -2) + (enc.endsWith('00') ? '11' : '00'), 'inst-1')).toThrow();
    expect(() => cipher.decrypt(enc, 'inst-2')).toThrow();
  });
});

describe('Contraseñas', () => {
  it('scrypt con verificación en tiempo constante', async () => {
    const h = await hashPassword('Correcta#123');
    expect(await verifyPassword('Correcta#123', h)).toBe(true);
    expect(await verifyPassword('Incorrecta#1', h)).toBe(false);
    expect(await verifyPassword('Correcta#123', null)).toBe(false);
  });
});

describe('Contexto firmado de Custom Pages (Shared Secret)', () => {
  const payload = { userId: 'u1', companyId: 'agency', role: 'admin', type: 'agency', activeLocation: 'loc1', userName: 'Ana', email: 'ana@example.test' };
  it('descifra el formato CryptoJS/OpenSSL', () => {
    expect(decryptGhlContext(encryptGhlContextForTests(payload, 'shh'), 'shh')).toMatchObject({ userId: 'u1', activeLocation: 'loc1' });
  });
  it('falla con otro secreto o payload incompleto', () => {
    expect(() => decryptGhlContext(encryptGhlContextForTests(payload, 'shh'), 'otro')).toThrow();
    expect(() => decryptGhlContext(encryptGhlContextForTests({ userId: 'u1' }, 'shh'), 'shh')).toThrow();
  });
});

describe('Firma de webhooks (Ed25519, X-GHL-Signature)', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const body = Buffer.from(JSON.stringify({ type: 'UNINSTALL', locationId: 'loc1' }));
  const sig = sign(null, body, privateKey).toString('base64');
  it('acepta una firma válida y rechaza cuerpo alterado o firma ausente', () => {
    expect(verifyGhlSignature(body, sig, pem)).toBe(true);
    expect(verifyGhlSignature(Buffer.from(body.toString().replace('loc1', 'loc2')), sig, pem)).toBe(false);
    expect(verifyGhlSignature(body, undefined, pem)).toBe(false);
    expect(verifyGhlSignature(body, 'no-base64!!', pem)).toBe(false);
  });
});

describe('Logs sin secretos', () => {
  it('redacta claves sensibles en profundidad', () => {
    expect(redact({ access_token: 'a', nested: { refreshToken: 'b', ok: 1 }, list: [{ password: 'c' }] })).toEqual({ access_token: '[REDACTED]', nested: { refreshToken: '[REDACTED]', ok: 1 }, list: [{ password: '[REDACTED]' }] });
  });
});
