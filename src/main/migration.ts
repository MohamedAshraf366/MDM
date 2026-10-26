import fs from 'node:fs';
import path from 'node:path';

export interface LegacyMigrationResult {
  migrated: boolean;
  encryptionKeyCopied: boolean;
}

export function migrateLegacyProfile(targetDirectory: string, legacyDirectory: string): LegacyMigrationResult {
  const targetDatabase = path.join(targetDirectory, 'mdm.db');
  const legacyDatabase = path.join(legacyDirectory, 'aerofetch.db');
  if (fs.existsSync(targetDatabase) || !fs.existsSync(legacyDatabase)) {
    return { migrated: false, encryptionKeyCopied: false };
  }

  try {
    fs.mkdirSync(targetDirectory, { recursive: true });

    const legacyState = path.join(legacyDirectory, 'Local State');
    const targetState = path.join(targetDirectory, 'Local State');
    let encryptionKeyCopied = false;
    if (fs.existsSync(legacyState)) {
      fs.copyFileSync(legacyState, targetState);
      encryptionKeyCopied = true;
    }

    fs.copyFileSync(legacyDatabase, targetDatabase);
    for (const suffix of ['-wal', '-shm']) {
      const source = `${legacyDatabase}${suffix}`;
      if (fs.existsSync(source)) fs.copyFileSync(source, `${targetDatabase}${suffix}`);
    }

    return { migrated: true, encryptionKeyCopied };
  } catch (error) {
    console.warn(`Could not migrate existing data: ${(error as Error).message}`);
    return { migrated: false, encryptionKeyCopied: false };
  }
}
