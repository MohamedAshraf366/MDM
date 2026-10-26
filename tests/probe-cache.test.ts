import { once } from 'node:events';
import fsp from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase, PlainTextSecretBox } from '../src/main/database';
import { AppLogger } from '../src/main/logger';
import { DownloadManager, type ManagerHost } from '../src/main/manager';
import { SettingsService } from '../src/main/settings';

const directories: string[] = [];
const servers: Server[] = [];
let database: AppDatabase | null = null;

afterEach(async () => {
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

const host: ManagerHost = {
  createSystemProxy: async () => null,
  openPath: async () => '',
  revealItem: () => undefined,
  notify: () => undefined,
  requestShutdown: () => undefined
};

async function setup(): Promise<DownloadManager> {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdm-probe-'));
  directories.push(directory);
  database = new AppDatabase(path.join(directory, 'mdm.db'), new PlainTextSecretBox());
  database.open();
  const settings = new SettingsService(database, path.join(directory, 'downloads'));
  settings.initialize();
  return new DownloadManager({ db: database, settings, logger: new AppLogger(database), host });
}

describe('media probe cache', () => {
  it('reuses a successful probe and forwards the page referrer', async () => {
    const referrers: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      referrers.push(request.headers.referer);
      response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      response.end(
        ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720', 'video/index.m3u8'].join('\n')
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/master.m3u8`;
    const manager = await setup();

    const first = await manager.probeMedia(url, undefined, '', 'https://origin.test/watch/1');
    const second = await manager.probeMedia(url, undefined, '', 'https://origin.test/watch/1');
    expect(first.kind).toBe('hls');
    expect(first.formats).toHaveLength(1);
    expect(second.formats).toHaveLength(1);
    expect(referrers).toEqual(['https://origin.test/watch/1']);

    await manager.probeMedia(url, undefined, '', 'https://other.test/watch/2');
    expect(referrers).toEqual(['https://origin.test/watch/1', 'https://other.test/watch/2']);
  });

  it('forwards the browser user agent to media probes', async () => {
    const userAgents: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      userAgents.push(request.headers['user-agent']);
      response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      response.end(
        ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=1280x720', 'video/index.m3u8'].join('\n')
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const manager = await setup();
    const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142.0.0.0 Safari/537.36';

    const result = await manager.probeMedia(
      `http://127.0.0.1:${port}/master.m3u8`,
      { 'User-Agent': userAgent },
      '',
      'https://origin.test/watch/1'
    );

    expect(result.formats).toHaveLength(1);
    expect(userAgents).toEqual([userAgent]);
  });
});
