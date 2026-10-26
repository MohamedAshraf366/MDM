import { once } from 'node:events';
import fsp from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase, PlainTextSecretBox } from '../src/main/database';
import { AppLogger } from '../src/main/logger';
import { DownloadManager, type ManagerHost } from '../src/main/manager';
import { SettingsService } from '../src/main/settings';
import type { DownloadLifecycleEvent } from '../src/shared/types';

const directories: string[] = [];
const servers: Server[] = [];
let manager: DownloadManager | null = null;
let database: AppDatabase | null = null;

afterEach(async () => {
  await manager?.shutdown().catch(() => undefined);
  manager = null;
  database?.close();
  database = null;
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
  await Promise.all(directories.splice(0).map((directory) => fsp.rm(directory, { recursive: true, force: true })));
});

async function setup(): Promise<{
  manager: DownloadManager;
  directory: string;
  notifications: Array<{ title: string; body: string; id?: string }>;
}> {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdm-lifecycle-'));
  directories.push(directory);
  database = new AppDatabase(path.join(directory, 'mdm.db'), new PlainTextSecretBox());
  database.open();
  const settings = new SettingsService(database, path.join(directory, 'downloads'));
  settings.initialize();
  const notifications: Array<{ title: string; body: string; id?: string }> = [];
  const host: ManagerHost = {
    createSystemProxy: async () => null,
    openPath: async () => '',
    revealItem: () => undefined,
    notify: (title, body, id) => notifications.push({ title, body, id }),
    requestShutdown: () => undefined
  };
  manager = new DownloadManager({ db: database, settings, logger: new AppLogger(database), host });
  await manager.initialize();
  return { manager, directory, notifications };
}

describe('download lifecycle', () => {
  it('emits deduplicated start and completion transitions and notifications', async () => {
    const data = Buffer.from('lifecycle test payload');
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': data.length
      });
      response.end(data);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const { manager: instance, directory, notifications } = await setup();
    const events: DownloadLifecycleEvent[] = [];
    const completed = new Promise<DownloadLifecycleEvent>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Download did not complete.')), 10_000);
      instance.on('lifecycle', (event: DownloadLifecycleEvent) => {
        events.push(event);
        if (event.state === 'completed') {
          clearTimeout(timer);
          resolve(event);
        }
      });
    });
    const destination = path.join(directory, 'target');
    const result = await instance.addDownload({
      url: `http://127.0.0.1:${port}/file.bin`,
      destinationDir: destination,
      startNow: true
    });
    const completedEvent = await completed;
    expect(events.map((event) => event.state)).toEqual(['queued', 'started', 'completed']);
    expect(new Set(events.map((event) => event.id))).toEqual(new Set([result.id]));
    expect(completedEvent.record.id).toBe(result.id);
    expect(completedEvent.record.status).toBe('completed');
    expect(notifications.map((entry) => entry.title)).toEqual(['Download started', 'Download complete']);
    expect(notifications.every((entry) => entry.id === result.id)).toBe(true);
  });

  it('tracks concurrent successful and failed downloads independently', async () => {
    const data = Buffer.from('concurrent lifecycle payload');
    const server = createServer((request, response) => {
      if (request.url === '/missing.bin') {
        response.writeHead(404, { 'Content-Type': 'text/plain' });
        response.end('not found');
        return;
      }
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': data.length
      });
      response.end(data);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const { manager: instance, directory, notifications } = await setup();
    const events: DownloadLifecycleEvent[] = [];
    instance.on('lifecycle', (event: DownloadLifecycleEvent) => events.push(event));
    const destination = path.join(directory, 'concurrent');
    await Promise.all([
      instance.addDownload({
        url: `http://127.0.0.1:${port}/ok.bin`,
        destinationDir: destination,
        startNow: true
      }),
      instance.addDownload({
        url: `http://127.0.0.1:${port}/missing.bin`,
        destinationDir: destination,
        startNow: true
      })
    ]);
    await vi.waitFor(
      () => {
        expect(events.filter((event) => event.state === 'completed')).toHaveLength(1);
        expect(events.filter((event) => event.state === 'failed')).toHaveLength(1);
      },
      { timeout: 10_000 }
    );
    const completed = events.find((event) => event.state === 'completed')!;
    const failed = events.find((event) => event.state === 'failed')!;
    expect(completed.record.fileName).toBe('ok.bin');
    expect(completed.record.error).toBe('');
    expect(failed.record.fileName).toBe('missing.bin');
    expect(failed.record.error).toContain('404');
    expect(failed.record.errorCode).toBe('HTTP_404');
    expect(notifications.filter((entry) => entry.title === 'Download complete')).toHaveLength(1);
    expect(notifications.filter((entry) => entry.title === 'Download failed')).toHaveLength(1);
    expect(notifications.some((entry) => entry.title === 'Download started')).toBe(true);
  });

  it('does not emit a failure transition when the user cancels', async () => {
    const { manager: instance } = await setup();
    const events: DownloadLifecycleEvent[] = [];
    instance.on('lifecycle', (event: DownloadLifecycleEvent) => events.push(event));
    const result = await instance.addDownload({
      url: 'http://127.0.0.1:9/unreachable.bin',
      startNow: false
    });
    instance.cancelDownload(result.id);
    await vi.waitFor(() => expect(events.some((event) => event.state === 'cancelled')).toBe(true), {
      timeout: 5_000
    });
    expect(events.some((event) => event.state === 'failed')).toBe(false);
  });
});
