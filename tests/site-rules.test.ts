import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase, PlainTextSecretBox } from '../src/main/database';
import { AppLogger } from '../src/main/logger';
import { DownloadManager, type ManagerHost } from '../src/main/manager';
import { SettingsService } from '../src/main/settings';

const directories: string[] = [];
let database: AppDatabase | null = null;
let manager: DownloadManager | null = null;

afterEach(async () => {
  manager = null;
  database?.close();
  database = null;
  await Promise.all(directories.splice(0).map((directory) => fsp.rm(directory, { recursive: true, force: true })));
});

const host: ManagerHost = {
  createSystemProxy: async () => null,
  openPath: async () => '',
  revealItem: () => undefined,
  notify: () => undefined,
  requestShutdown: () => undefined
};

async function setup(): Promise<DownloadManager> {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdm-rules-'));
  directories.push(directory);
  database = new AppDatabase(path.join(directory, 'mdm.db'), new PlainTextSecretBox());
  database.open();
  const settings = new SettingsService(database, path.join(directory, 'downloads'));
  settings.initialize();
  const logger = new AppLogger(database);
  manager = new DownloadManager({ db: database, settings, logger, host });
  return manager;
}

describe('site rule resolution', () => {
  it('prefers the most specific matching host pattern', async () => {
    const instance = await setup();
    instance.saveSiteRule({
      name: 'All example downloads',
      pattern: '*.example.com',
      action: 'auto',
      fileTypes: [],
      destinationDir: '',
      enabled: true
    });
    instance.saveSiteRule({
      name: 'Media review',
      pattern: 'media.example.com',
      action: 'ask',
      fileTypes: ['mp4'],
      destinationDir: directories[0]!,
      enabled: true
    });

    const media = instance.resolveSiteRule(
      'https://cdn.third-party.test/video.mp4?token=abc',
      'https://media.example.com/watch/123',
      'video.mp4'
    );
    expect(media).toMatchObject({ name: 'Media review', action: 'ask' });

    const archive = instance.resolveSiteRule(
      'https://cdn.third-party.test/archive.zip',
      'https://media.example.com/watch/123',
      'archive.zip'
    );
    expect(archive).toMatchObject({ name: 'All example downloads', action: 'auto' });
  });

  it('uses the download URL host when no source page is supplied', async () => {
    const instance = await setup();
    instance.saveSiteRule({
      name: 'Direct host',
      pattern: 'files.example.com',
      action: 'ignore',
      fileTypes: [],
      destinationDir: '',
      enabled: true
    });
    const rule = instance.resolveSiteRule('https://files.example.com/a.bin', '', 'a.bin');
    expect(rule).toMatchObject({ name: 'Direct host', action: 'ignore' });
  });

  it('skips disabled rules and non-matching file types', async () => {
    const instance = await setup();
    instance.saveSiteRule({
      name: 'Disabled',
      pattern: '*.example.com',
      action: 'ignore',
      fileTypes: [],
      destinationDir: '',
      enabled: false
    });
    instance.saveSiteRule({
      name: 'PDF only',
      pattern: '*.example.com',
      action: 'ask',
      fileTypes: ['pdf'],
      destinationDir: '',
      enabled: true
    });
    expect(instance.resolveSiteRule('https://example.com/file.zip', 'https://example.com/page', 'file.zip')).toBeNull();
    expect(
      instance.resolveSiteRule('https://example.com/file.pdf', 'https://example.com/page', 'file.pdf')
    ).toMatchObject({ name: 'PDF only', action: 'ask' });
  });

  it('does not match unrelated domains', async () => {
    const instance = await setup();
    instance.saveSiteRule({
      name: 'Example only',
      pattern: 'example.com',
      action: 'auto',
      fileTypes: [],
      destinationDir: '',
      enabled: true
    });
    expect(
      instance.resolveSiteRule('https://notexample.com/file.zip', 'https://notexample.com/page', 'file.zip')
    ).toBeNull();
  });
});
