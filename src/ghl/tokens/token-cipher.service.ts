import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { APP_CONFIG, type AppConfig } from '../../config/app-config';

/**
 * Cifrado autenticado AES-256-GCM para tokens OAuth en reposo.
 * Formato: v1.<iv hex>.<tag hex>.<ciphertext hex>. La clave (TOKEN_ENCRYPTION_KEY) nunca se guarda en PostgreSQL.
 * El identificador de la instalación se usa como AAD: un token copiado a otra fila no se puede descifrar.
 */
@Injectable()
export class TokenCipher {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  encrypt(plain: string, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.config.tokenEncryptionKey, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `v1.${iv.toString('hex')}.${cipher.getAuthTag().toString('hex')}.${data.toString('hex')}`;
  }

  decrypt(value: string, aad: string): string {
    const [version, iv, tag, data] = value.split('.');
    if (version !== 'v1' || !iv || !tag || !data) throw new Error('Formato de credencial cifrada inválido');
    const decipher = createDecipheriv('aes-256-gcm', this.config.tokenEncryptionKey, Buffer.from(iv, 'hex'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]).toString('utf8');
  }
}
