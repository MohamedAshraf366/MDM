import { once } from 'node:events';
import fsp from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase, PlainTextSecretBox } from '../src/main/database';
import { AppLogger } from '../src/main/logger';
import { DownloadManager, type ManagerHost } from '../src/main/manager';
import { SettingsService } from '../src/main/settings';

const directories: string[] = [];
const servers: Server[] = [];
const databases: AppDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
  await Promise.all(directories.splice(0).map((directory) => fsp.rm(directory, { recursive: true, force: true }).catch(() => undefined)));
});

async function setup() {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdm-pool-'));
  directories.push(directory);
  const database = new AppDatabase(path.join(directory, 'mdm.db'), new PlainTextSecretBox());
  database.open();
  databases.push(database);
  const settings = new SettingsService(database, path.join(directory, 'downloads'));
  settings.initialize();
  const host: ManagerHost = {
    createSystemProxy: async () => null,
    openPath: async () => '',
    revealItem: () => undefined,
    notify: () => undefined,
    requestShutdown: () => undefined
  };
  const manager = new DownloadManager({ db: database, settings, logger: new AppLogger(database), host });
  await manager.initialize();
  return { manager, settings, directory };
}

function payload(size: number, seed = 1): Buffer {
  const buffer = Buffer.alloc(size);
  let state = seed >>> 0;
  for (let index = 0; index < size; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    buffer[index] = (state >>> 24) & 0xff;
  }
  return buffer;
}

function throttledRoute(data: Buffer, perChunkMs: Record<number, number>) {
  return (_request: IncomingMessage, response: ServerResponse): void => {
    const rangeHeader = /^bytes=(\d+)-(\d+)$/.exec(String(_request.headers.range ?? ''));
    let status = 200;
    let start = 0;
    let end = data.length - 1;
    const extra: Record<string, string | number> = { 'Content-Length': data.length };
    if (rangeHeader && Number(rangeHeader[1]) <= Number(rangeHeader[2])) {
      start = Number(rangeHeader[1]);
      end = Math.min(Number(rangeHeader[2]), data.length - 1);
      status = 206;
      extra['Content-Range'] = `bytes ${start}-${end}/${data.length}`;
      extra['Content-Length'] = end - start + 1;
    }
    response.writeHead(status, { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', ...extra });
    const delay = status === 206 ? perChunkMs[start] ?? 0 : 0;
    const push = (offset: number) => {
      if (offset > end) {
        response.end();
        return;
      }
      const next = Math.min(offset + 64 * 1024, end + 1);
      response.write(data.subarray(offset, next));
      setTimeout(() => push(next), delay);
    };
    push(start);
  };
}

describe('worker-pool segmented downloads', () => {
  it('steals work from a slow segment so the file still completes quickly', async () => {
    const data = payload(16 * 1024 * 1024, 7);
    // Segment 0 (8MB with 2 connections on a 16MB file) is served 25ms per
    // 64KB chunk; the others are instant. A static split would wait for the
    // slow segment; the worker pool should split it and hand the tail to an
    // idle connection.
    const delays: Record<number, number> = { 0: 25 };
    const server = createServer(throttledRoute(data, delays));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const instance = await setup();
    instance.settings.update({ patch: { defaultConnections: 2 } });

    const result = await instance.manager.addDownload({
      url: `http://127.0.0.1:${port}/big.bin`,
      destinationDir: path.join(instance.directory, 'out'),
      startNow: true
    });

    const record = await vi.waitFor(
      () => {
        const current = instance.manager.getRecord(result.id);
        expect(current?.status).toBe('completed');
        return current!;
      },
      { timeout: 20_000, interval: 50 }
    );

    expect(record.totalBytes).toBe(data.length);
    expect(record.downloadedBytes).toBe(data.length);
    expect((await fsp.readFile(record.targetPath!)).equals(data)).toBe(true);
    // The pool must have split the throttled segment.
    expect(record.segments.length).toBeGreaterThan(2);
  }, 30_000);
});
