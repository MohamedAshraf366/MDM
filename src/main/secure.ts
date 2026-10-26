import { safeStorage } from 'electron';
import type { SecretBox } from './database';

export class SafeStorageSecretBox implements SecretBox {
  private readonly prefix = 'enc:v1:';

  encrypt(value: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure storage is not available on this system.');
    }
    const encrypted = safeStorage.encryptString(value);
    return `${this.prefix}${encrypted.toString('base64')}`;
  }

  decrypt(value: string): string {
    if (!value) return '';
    if (!value.startsWith(this.prefix)) return value;
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure storage is not available on this system.');
    }
    const payload = Buffer.from(value.slice(this.prefix.length), 'base64');
    return safeStorage.decryptString(payload);
  }
}
