import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateLegacyProfile } from '../src/main/migration';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fsp.rm(directory, { recursive: true, force: true })));
});

async function profilePaths(): Promise<{ target: string; legacy: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdm-migration-'));
  directories.push(root);
  return { target: path.join(root, 'new profile'), legacy: path.join(root, 'AeroFetch') };
}

describe('legacy profile migration', () => {
  it('copies the database, sidecars, and encryption state', async () => {
    const { target, legacy } = await profilePaths();
    await fsp.mkdir(legacy, { recursive: true });
    await fsp.writeFile(path.join(legacy, 'aerofetch.db'), 'database');
    await fsp.writeFile(path.join(legacy, 'aerofetch.db-wal'), 'wal');
    await fsp.writeFile(path.join(legacy, 'aerofetch.db-shm'), 'shm');
    await fsp.writeFile(path.join(legacy, 'Local State'), '{"os_crypt":{"encrypted_key":"key"}}');

    const result = migrateLegacyProfile(target, legacy);

    expect(result).toEqual({ migrated: true, encryptionKeyCopied: true });
    expect(await fsp.readFile(path.join(target, 'mdm.db'), 'utf8')).toBe('database');
    expect(await fsp.readFile(path.join(target, 'mdm.db-wal'), 'utf8')).toBe('wal');
    expect(await fsp.readFile(path.join(target, 'mdm.db-shm'), 'utf8')).toBe('shm');
    expect(await fsp.readFile(path.join(target, 'Local State'), 'utf8')).toBe('{"os_crypt":{"encrypted_key":"key"}}');
  });

  it('does not overwrite an existing MDM profile', async () => {
    const { target, legacy } = await profilePaths();
    await fsp.mkdir(legacy, { recursive: true });
    await fsp.mkdir(target, { recursive: true });
    await fsp.writeFile(path.join(legacy, 'aerofetch.db'), 'legacy');
    await fsp.writeFile(path.join(legacy, 'Local State'), 'legacy state');
    await fsp.writeFile(path.join(target, 'mdm.db'), 'current');
    await fsp.writeFile(path.join(target, 'Local State'), 'current state');

    const result = migrateLegacyProfile(target, legacy);

    expect(result).toEqual({ migrated: false, encryptionKeyCopied: false });
    expect(await fsp.readFile(path.join(target, 'mdm.db'), 'utf8')).toBe('current');
    expect(await fsp.readFile(path.join(target, 'Local State'), 'utf8')).toBe('current state');
  });

  it('does nothing when there is no legacy database', async () => {
    const { target, legacy } = await profilePaths();
    await fsp.mkdir(legacy, { recursive: true });
    await fsp.writeFile(path.join(legacy, 'Local State'), 'legacy state');

    const result = migrateLegacyProfile(target, legacy);

    expect(result).toEqual({ migrated: false, encryptionKeyCopied: false });
    await expect(fsp.access(path.join(target, 'mdm.db'))).rejects.toThrow();
  });
});
