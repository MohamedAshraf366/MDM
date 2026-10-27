import { DatabaseSync } from 'node:sqlite';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase, type SecretBox } from '../src/main/database';
import type { DownloadRecord, SiteRule } from '../src/shared/types';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fsp.rm(directory, { recursive: true, force: true })));
});

async function databasePath(): Promise<string> {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdm-db-'));
  directories.push(directory);
  return path.join(directory, 'mdm.db');
}

const cipher: SecretBox = {
  encrypt(value: string): string {
    return Buffer.from(`mdm:${value}`, 'utf8').toString('base64');
  },
  decrypt(value: string): string {
    return Buffer.from(value, 'base64').toString('utf8').replace(/^mdm:/, '');
  }
};

function siteRule(overrides: Partial<SiteRule> = {}): SiteRule {
  return {
    id: 'site-1',
    name: 'Training portal',
    pattern: '*.training.example',
    action: 'ask',
    fileTypes: ['zip', 'pdf'],
    destinationDir: 'C:\\Downloads\\Training',
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

describe('database persistence', () => {
  it('seeds a default queue and category rules', async () => {
    const db = new AppDatabase(await databasePath(), cipher);
    db.open();
    try {
      const queues = db.listQueues();
      expect(queues.some((queue) => queue.id === 'default' && queue.isDefault)).toBe(true);
      expect(db.listRules().length).toBeGreaterThan(5);
      expect(db.listDownloads()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('encrypts secret settings at rest and persists site rules', async () => {
    const file = await databasePath();
    const db = new AppDatabase(file, cipher);
    db.open();
    db.setSetting('test.secret', 'top-secret', true);
    db.insertSiteRule(siteRule());
    expect(db.listSiteRules()).toHaveLength(1);
    db.close();

    const raw = new DatabaseSync(file);
    try {
      const row = raw.prepare('SELECT value FROM settings WHERE key = ?').get('test.secret') as { value: string };
      expect(row.value).not.toContain('top-secret');
      expect(Buffer.from(row.value, 'base64').toString('utf8')).toContain('top-secret');
    } finally {
      raw.close();
    }

    const reopened = new AppDatabase(file, cipher);
    reopened.open();
    try {
      expect(reopened.getSetting('test.secret')).toEqual({ value: 'top-secret', secret: true });
      expect(reopened.listSiteRules()[0]).toMatchObject({
        name: 'Training portal',
        action: 'ask',
        fileTypes: ['zip', 'pdf'],
        destinationDir: 'C:\\Downloads\\Training'
      });
      const updated = siteRule({ name: 'Updated', action: 'ignore', enabled: false, updatedAt: '2026-02-01T00:00:00.000Z' });
      reopened.updateSiteRule(updated);
      expect(reopened.listSiteRules()[0]).toMatchObject({ name: 'Updated', action: 'ignore', enabled: false });
      reopened.deleteSiteRule('site-1');
      expect(reopened.listSiteRules()).toEqual([]);
    } finally {
      reopened.close();
    }
  });

  it('round-trips download records and their segments', async () => {
    const db = new AppDatabase(await databasePath(), cipher);
    db.open();
    try {
      const record: DownloadRecord = {
        id: 'download-1',
        kind: 'http',
        url: 'https://example.com/file.bin',
        finalUrl: null,
        fileName: 'file.bin',
        fileNameExplicit: true,
        destinationDir: 'C:\\Downloads',
        destinationExplicit: true,
        targetPath: null,
        tempPath: null,
        category: 'other',
        queueId: 'default',
        status: 'queued',
        priority: 'normal',
        totalBytes: 1024,
        downloadedBytes: 0,
        resumable: true,
        connections: 4,
        speedLimitBps: 0,
        headers: { Accept: '*/*' },
        cookies: '',
        referrer: '',
        mimeType: 'application/octet-stream',
        etag: '"v1"',
        lastModified: '',
        checksum: '',
        checksumAlgorithm: '',
        checksumStatus: 'none',
        error: '',
        errorCode: '',
        retryCount: 0,
        maxRetries: 3,
        speedBps: 0,
        etaSeconds: null,
        segments: [
          { index: 0, startByte: 0, endByte: 511, downloadedBytes: 0, status: 'pending' },
          { index: 1, startByte: 512, endByte: 1023, downloadedBytes: 0, status: 'pending' }
        ],
        scheduledAt: null,
        createdAt: '2026-03-01T00:00:00.000Z',
        updatedAt: '2026-03-01T00:00:00.000Z',
        startedAt: null,
        completedAt: null,
        autoOpen: false,
        mediaFormatJson: '',
        mediaState: '',
        sourcePageUrl: '',
        recordLog: []
      };
      db.insertDownload(record);
      const saved = db.getDownload('download-1');
      expect(saved).toMatchObject({
        fileName: 'file.bin',
        status: 'queued',
        totalBytes: 1024,
        headers: { Accept: '*/*' }
      });
      expect(saved?.segments).toHaveLength(2);

      // Progress-only checkpoints update counters and segments but leave the
      // structural columns (status, paths, logs, media state) untouched.
      db.saveProgress('download-1', 700, 4096, 12, [
        { index: 0, startByte: 0, endByte: 511, downloadedBytes: 512, status: 'complete' },
        { index: 1, startByte: 512, endByte: 1023, downloadedBytes: 188, status: 'downloading' }
      ]);
      const progressed = db.getDownload('download-1');
      expect(progressed).toMatchObject({
        fileName: 'file.bin',
        status: 'queued',
        totalBytes: 1024,
        downloadedBytes: 700,
        speedBps: 4096,
        etaSeconds: 12
      });
      expect(progressed?.segments).toEqual([
        { index: 0, startByte: 0, endByte: 511, downloadedBytes: 512, status: 'complete' },
        { index: 1, startByte: 512, endByte: 1023, downloadedBytes: 188, status: 'downloading' }
      ]);

      db.updateDownload('download-1', { status: 'completed', downloadedBytes: 1024 });
      expect(db.getDownload('download-1')?.status).toBe('completed');
      db.deleteDownload('download-1');
      expect(db.getDownload('download-1')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('stores, filters, and clears logs', async () => {
    const db = new AppDatabase(await databasePath(), cipher);
    db.open();
    try {
      db.addLog('info', 'system', 'Started');
      db.addLog('error', 'downloads', 'Failed');
      db.addLog('warn', 'bridge', 'Retry');
      expect(db.listLogs(10).map((log) => log.level)).toEqual(['warn', 'error', 'info']);
      expect(db.listLogs(10, 'error')).toHaveLength(1);
      expect(db.listLogs(10, 'error')[0]?.message).toBe('Failed');
      db.clearLogs();
      expect(db.listLogs()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
