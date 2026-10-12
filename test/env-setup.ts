// Entorno aislado para pruebas e2e: base _test, secretos efímeros y límites de tasa holgados.
import { randomBytes } from 'node:crypto';

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.JWT_SECRET = randomBytes(48).toString('hex');
process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.FRONTEND_ORIGIN = 'http://localhost:3100';
process.env.GHL_MODE = 'mock';
process.env.LOGIN_RATE_LIMIT_PER_MINUTE = '1000';
process.env.RATE_LIMIT_PER_MINUTE = '100000';
process.env.SESSION_TTL_MINUTES = '30';
process.env.OAUTH_CALLBACK_RATE_LIMIT_PER_MINUTE = '1000';
