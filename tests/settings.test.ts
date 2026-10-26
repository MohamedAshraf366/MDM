import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase, type SecretBox } from '../src/main/database';
import { SettingsService } from '../src/main/settings';

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => fsp.rm(directory, { recursive: true, force: true })));
});

const failingCipher: SecretBox = {
  encrypt(value: string): string {
    return `enc:${Buffer.from(value, 'utf8').toString('base64')}`;
  },
  decrypt(value: string): string {
    if (value.startsWith('enc:')) throw new Error('decryption failed');
    return value;
  }
};

describe('settings startup recovery', () => {
  it('regenerates secrets when stored values cannot be decrypted', async () => {
    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdm-settings-'));
    directories.push(directory);
    const db = new AppDatabase(path.join(directory, 'mdm.db'), failingCipher);
    db.open();
    try {
      db.setSetting('bridge.token', 'legacy-token', true);
      db.setSetting('proxy.password', 'legacy-password', true);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const settings = new SettingsService(db, path.join(directory, 'downloads'));
      expect(() => settings.initialize()).not.toThrow();

      expect(settings.getProxyPassword()).toBe('');
      expect(settings.get().proxy.passwordSet).toBe(false);
      expect(settings.getBridgeToken()).not.toBe('legacy-token');
      expect(settings.getBridgeToken().length).toBeGreaterThan(20);
      expect(settings.get().bridgeToken).toBe(settings.getBridgeToken());
    } finally {
      db.close();
    }
  });
});
