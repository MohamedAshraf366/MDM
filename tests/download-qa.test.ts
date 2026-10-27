import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase, PlainTextSecretBox } from '../src/main/database';
import { AppLogger } from '../src/main/logger';
import { DownloadManager, type ManagerHost } from '../src/main/manager';
import { SettingsService } from '../src/main/settings';
import type { DownloadRecord, DownloadStatus } from '../src/shared/types';

const directories: string[] = [];
const servers: Array<Server | net.Server> = [];
const ftpPassiveServers: net.Server[] = [];
const databases: AppDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  await Promise.all(ftpPassiveServers.splice(0).map((server) => closeServer(server)));
  await Promise.all(directories.splice(0).map((directory) => fsp.rm(directory, { recursive: true, force: true }).catch(() => undefined)));
});

async function closeServer(server: Server | net.Server): Promise<void> {
  await new Promise<void>((resolve) => {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => resolve());
  });
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

function hashOf(data: Buffer, algorithm: 'sha256' | 'sha1' | 'md5'): string {
  return createHash(algorithm).update(data).digest('hex');
}

function parseRange(header: string | undefined, total: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '') return null;
  const start = Number(rawStart);
  const end = rawEnd === '' ? total - 1 : Math.min(Number(rawEnd), total - 1);
  if (start > end || start >= total) return null;
  return { start, end };
}

interface BinaryOptions {
  mime?: string;
  disposition?: string;
  throttleMs?: number;
  corrupt?: boolean;
  redirectTarget?: string;
}

interface FixtureServer {
  port: number;
  url: (pathname: string) => string;
  requests: Array<{ path: string; range: string | undefined }>;
}

function binaryRoute(data: Buffer, options: BinaryOptions = {}) {
  return (request: IncomingMessage, response: ServerResponse): void => {
    if (options.redirectTarget) {
      response.writeHead(302, { Location: options.redirectTarget });
      response.end();
      return;
    }
    const body = options.corrupt ? Buffer.from(data.map((byte, index) => (index === 0 ? byte ^ 0xff : byte))) : data;
    const range = parseRange(request.headers.range, body.length);
    const baseHeaders: Record<string, string | number> = {
      'Content-Type': options.mime ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes'
    };
    if (options.disposition) baseHeaders['Content-Disposition'] = options.disposition;

    const streamBody = (start: number, end: number, status: number, extra: Record<string, string | number>) => {
      response.writeHead(status, { ...baseHeaders, ...extra });
      const slice = body.subarray(start, end + 1);
      if (options.throttleMs && slice.length > 32 * 1024) {
        let offset = 0;
        const push = () => {
          if (offset >= slice.length) {
            response.end();
            return;
          }
          const chunk = slice.subarray(offset, Math.min(offset + 32 * 1024, slice.length));
          offset += chunk.length;
          setTimeout(push, options.throttleMs);
        };
        push();
      } else {
        response.end(slice);
      }
    };

    if (range) {
      streamBody(range.start, range.end, 206, {
        'Content-Range': `bytes ${range.start}-${range.end}/${body.length}`,
        'Content-Length': range.end - range.start + 1
      });
    } else {
      streamBody(0, body.length - 1, 200, { 'Content-Length': body.length });
    }
  };
}

function createFixtureServer(routes: Record<string, (request: IncomingMessage, response: ServerResponse) => void>): Promise<FixtureServer> {
  const requests: Array<{ path: string; range: string | undefined }> = [];
  const server = createServer((request, response) => {
    const pathName = (request.url ?? '/').split(/[?#]/)[0] ?? '/';
    requests.push({ path: pathName, range: request.headers.range });
    const route = routes[pathName];
    if (!route) {
      response.writeHead(404, { 'Content-Type': 'text/plain' });
      response.end('not found');
      return;
    }
    route(request, response);
  });
  server.on('connection', (socket) => {
    socket.on('error', () => socket.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      servers.push(server);
      const port = (server.address() as AddressInfo).port;
      resolve({ port, url: (pathname) => `http://127.0.0.1:${port}${pathname}`, requests });
    });
  });
}

function chunkedRoute(data: Buffer, mime: string) {
  return (_request: IncomingMessage, response: ServerResponse): void => {
    response.writeHead(200, { 'Content-Type': mime });
    for (let offset = 0; offset < data.length; offset += 16 * 1024) response.write(data.subarray(offset, offset + 16 * 1024));
    response.end();
  };
}

async function createFtpFixture(payloadData: Buffer): Promise<{ port: number; url: string }> {
  const server = net.createServer((socket) => {
    socket.on('error', () => socket.destroy());
    socket.setEncoding('utf8');
    let buffer = '';
    let restOffset = 0;
    let passive: net.Server | null = null;
    const send = (line: string) => socket.write(`${line}\r\n`);
    send('220 MDM QA FTP ready');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf('\r\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf('\r\n');
        if (!line) continue;
        const spaceAt = line.indexOf(' ');
        const command = (spaceAt === -1 ? line : line.slice(0, spaceAt)).toUpperCase();
        const argument = spaceAt === -1 ? '' : line.slice(spaceAt + 1);
        switch (command) {
          case 'USER':
            send('331 password required');
            break;
          case 'PASS':
            send('230 logged in');
            break;
          case 'TYPE':
            send('200 type set');
            break;
          case 'SIZE':
            send(`213 ${payloadData.length}`);
            break;
          case 'MDTM':
            send('213 20260101000000');
            break;
          case 'REST':
            restOffset = Number(argument) || 0;
            send('350 restart position accepted');
            break;
          case 'EPSV': {
            passive = net.createServer((data) => {
              data.on('error', () => data.destroy());
              data.end(restOffset > 0 ? payloadData.subarray(restOffset) : payloadData);
            });
            passive.on('connection', (dataSocket) => {
              dataSocket.on('error', () => dataSocket.destroy());
            });
            ftpPassiveServers.push(passive);
            passive.listen(0, '127.0.0.1', () => {
              const port = (passive!.address() as AddressInfo).port;
              send(`229 Entering Extended Passive Mode (|||${port}|)`);
            });
            break;
          }
          case 'RETR':
            send('150 opening data connection');
            setTimeout(() => send('226 transfer complete'), 200);
            break;
          case 'QUIT':
            send('221 bye');
            socket.end();
            break;
          default:
            send('502 command not implemented');
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { port, url: `ftp://127.0.0.1:${port}/media/movie.mp4` };
}

interface SetupResult {
  manager: DownloadManager;
  settings: SettingsService;
  directory: string;
  openPaths: string[];
}

async function setup(): Promise<SetupResult> {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdm-qa-'));
  directories.push(directory);
  const database = new AppDatabase(path.join(directory, 'mdm.db'), new PlainTextSecretBox());
  database.open();
  databases.push(database);
  const settings = new SettingsService(database, path.join(directory, 'downloads'));
  settings.initialize();
  const openPaths: string[] = [];
  const host: ManagerHost = {
    createSystemProxy: async () => null,
    openPath: async (target) => {
      openPaths.push(target);
      return '';
    },
    revealItem: () => undefined,
    notify: () => undefined,
    requestShutdown: () => undefined
  };
  const manager = new DownloadManager({ db: database, settings, logger: new AppLogger(database), host });
  await manager.initialize();
  return { manager, settings, directory, openPaths };
}

function destinationOf(result: SetupResult, name: string): string {
  return path.join(result.directory, name);
}

function recordOf(manager: DownloadManager, id: string): DownloadRecord {
  const record = manager.downloads.get(id);
  if (!record) throw new Error(`Record ${id} missing.`);
  return record;
}

async function waitForStatus(manager: DownloadManager, id: string, status: DownloadStatus, timeoutMs = 20_000): Promise<DownloadRecord> {
  return vi.waitFor(
    () => {
      const record = recordOf(manager, id);
      expect(record.status).toBe(status);
      return record;
    },
    { timeout: timeoutMs, interval: 50 }
  );
}

describe('download QA: file types over HTTP', () => {
  it('downloads video, audio, image, archive, document, and program files concurrently with exact bytes', async () => {
    const files: Array<{ pathName: string; mime: string; size: number; seed: number }> = [
      { pathName: '/video.mp4', mime: 'video/mp4', size: 512 * 1024, seed: 11 },
      { pathName: '/audio.mp3', mime: 'audio/mpeg', size: 256 * 1024, seed: 12 },
      { pathName: '/photo.jpg', mime: 'image/jpeg', size: 128 * 1024, seed: 13 },
      { pathName: '/backup.zip', mime: 'application/zip', size: 384 * 1024, seed: 14 },
      { pathName: '/manual.pdf', mime: 'application/pdf', size: 64 * 1024, seed: 15 },
      { pathName: '/program.exe', mime: 'application/vnd.microsoft.portable-executable', size: 96 * 1024, seed: 16 }
    ];
    const routes: Record<string, (request: IncomingMessage, response: ServerResponse) => void> = {};
    const bodies = new Map<string, Buffer>();
    for (const file of files) {
      const data = payload(file.size, file.seed);
      bodies.set(file.pathName, data);
      routes[file.pathName] = binaryRoute(data, { mime: file.mime });
    }
    const fixture = await createFixtureServer(routes);
    const instance = await setup();

    const added = await Promise.all(
      files.map((file) =>
        instance.manager.addDownload({ url: fixture.url(file.pathName), destinationDir: destinationOf(instance, 'types'), startNow: true })
      )
    );
    await Promise.all(added.map((entry) => waitForStatus(instance.manager, entry.id, 'completed')));

    for (const file of files) {
      const record = added.map((entry) => recordOf(instance.manager, entry.id)).find((record) => record.url === fixture.url(file.pathName))!;
      expect(record.status).toBe('completed');
      expect(record.fileName).toBe(path.basename(file.pathName));
      expect(record.totalBytes).toBe(file.size);
      const written = await fsp.readFile(record.targetPath!);
      expect(written.equals(bodies.get(file.pathName)!)).toBe(true);
    }
  });

  it('downloads a large video with multiple segments and verifies SHA-256', async () => {
    const data = payload(8 * 1024 * 1024, 21);
    const fixture = await createFixtureServer({ '/big-video.mp4': binaryRoute(data, { mime: 'video/mp4' }) });
    const instance = await setup();
    instance.settings.update({ patch: { defaultConnections: 4 } });

    const result = await instance.manager.addDownload({
      url: fixture.url('/big-video.mp4'),
      destinationDir: destinationOf(instance, 'segmented'),
      checksum: hashOf(data, 'sha256'),
      checksumAlgorithm: 'sha256',
      startNow: true
    });
    const record = await waitForStatus(instance.manager, result.id, 'completed');

    expect(record.checksumStatus).toBe('verified');
    expect(record.segments.length).toBeGreaterThanOrEqual(4);
    expect(fixture.requests.filter((request) => request.range?.startsWith('bytes=')).length).toBeGreaterThanOrEqual(4);
    expect((await fsp.readFile(record.targetPath!)).equals(data)).toBe(true);
  });

  it('uses a single connection for files below the per-connection size floor', async () => {
    const data = payload(512 * 1024, 22);
    const fixture = await createFixtureServer({ '/small.bin': binaryRoute(data) });
    const instance = await setup();
    instance.settings.update({ patch: { defaultConnections: 8 } });

    const result = await instance.manager.addDownload({
      url: fixture.url('/small.bin'),
      destinationDir: destinationOf(instance, 'small'),
      startNow: true
    });
    const record = await waitForStatus(instance.manager, result.id, 'completed');

    expect(record.segments).toHaveLength(1);
    expect((await fsp.readFile(record.targetPath!)).equals(data)).toBe(true);
  });

  it('verifies SHA-1 and MD5 checksums', async () => {
    const sha1Data = payload(200 * 1024, 31);
    const md5Data = payload(180 * 1024, 32);
    const fixture = await createFixtureServer({
      '/song.flac': binaryRoute(sha1Data, { mime: 'audio/flac' }),
      '/voice.wav': binaryRoute(md5Data, { mime: 'audio/wav' })
    });
    const instance = await setup();

    const sha1Result = await instance.manager.addDownload({
      url: fixture.url('/song.flac'),
      destinationDir: destinationOf(instance, 'hashes'),
      checksum: hashOf(sha1Data, 'sha1'),
      checksumAlgorithm: 'sha1',
      startNow: true
    });
    const md5Result = await instance.manager.addDownload({
      url: fixture.url('/voice.wav'),
      destinationDir: destinationOf(instance, 'hashes'),
      checksum: hashOf(md5Data, 'md5'),
      checksumAlgorithm: 'md5',
      startNow: true
    });
    expect((await waitForStatus(instance.manager, sha1Result.id, 'completed')).checksumStatus).toBe('verified');
    expect((await waitForStatus(instance.manager, md5Result.id, 'completed')).checksumStatus).toBe('verified');
  });

  it('fails a corrupted download on checksum mismatch and publishes nothing', async () => {
    const data = payload(256 * 1024, 41);
    const fixture = await createFixtureServer({ '/broken.zip': binaryRoute(data, { mime: 'application/zip', corrupt: true }) });
    const instance = await setup();
    const destination = destinationOf(instance, 'mismatch');

    const result = await instance.manager.addDownload({
      url: fixture.url('/broken.zip'),
      destinationDir: destination,
      checksum: hashOf(data, 'sha256'),
      checksumAlgorithm: 'sha256',
      startNow: true
    });
    const record = await waitForStatus(instance.manager, result.id, 'failed');

    expect(record.errorCode).toBe('CHECKSUM_MISMATCH');
    expect(record.error).toContain('Integrity');
    await expect(fsp.access(path.join(destination, 'broken.zip'))).rejects.toThrow();
  });

  it('uses Content-Disposition filenames including RFC 5987 unicode names', async () => {
    const data = payload(120 * 1024, 51);
    const unicode = Buffer.from('ملف تجربة.mp3', 'utf8').toString('latin1');
    const fixture = await createFixtureServer({
      '/get-audio': binaryRoute(data, { mime: 'audio/mpeg', disposition: 'attachment; filename="track.mp3"' }),
      '/get-song': binaryRoute(data, {
        mime: 'audio/mpeg',
        disposition: `attachment; filename="${unicode}"; filename*=UTF-8''%D9%85%D9%84%D9%81%20%D8%AA%D8%AC%D8%B1%D8%A8%D8%A9.mp3`
      })
    });
    const instance = await setup();

    const first = await instance.manager.addDownload({ url: fixture.url('/get-audio'), destinationDir: destinationOf(instance, 'names'), startNow: true });
    const second = await instance.manager.addDownload({ url: fixture.url('/get-song'), destinationDir: destinationOf(instance, 'names'), startNow: true });
    expect((await waitForStatus(instance.manager, first.id, 'completed')).fileName).toBe('track.mp3');
    expect((await waitForStatus(instance.manager, second.id, 'completed')).fileName).toBe('ملف تجربة.mp3');
  });

  it('follows redirects and records the final URL', async () => {
    const data = payload(200 * 1024, 61);
    const fixture = await createFixtureServer({
      '/redirect': binaryRoute(data, { redirectTarget: '/final/video.webm' }),
      '/final/video.webm': binaryRoute(data, { mime: 'video/webm' })
    });
    const instance = await setup();

    const result = await instance.manager.addDownload({ url: fixture.url('/redirect'), destinationDir: destinationOf(instance, 'redirect'), startNow: true });
    const record = await waitForStatus(instance.manager, result.id, 'completed');

    expect(record.finalUrl).toBe(fixture.url('/final/video.webm'));
    expect(record.fileName).toBe('video.webm');
    expect((await fsp.readFile(record.targetPath!)).equals(data)).toBe(true);
  });

  it('downloads chunked responses without Content-Length', async () => {
    const data = payload(300 * 1024, 71);
    const fixture = await createFixtureServer({ '/stream.mp4': chunkedRoute(data, 'video/mp4') });
    const instance = await setup();

    const result = await instance.manager.addDownload({ url: fixture.url('/stream.mp4'), destinationDir: destinationOf(instance, 'chunked'), startNow: true });
    const record = await waitForStatus(instance.manager, result.id, 'completed');

    expect(record.totalBytes).toBe(data.length);
    expect((await fsp.readFile(record.targetPath!)).equals(data)).toBe(true);
  });

  it('completes empty and one-byte files', async () => {
    const fixture = await createFixtureServer({
      '/empty.mp4': binaryRoute(Buffer.alloc(0), { mime: 'video/mp4' }),
      '/one.mp3': binaryRoute(Buffer.from([0xaa]), { mime: 'audio/mpeg' })
    });
    const instance = await setup();

    const empty = await instance.manager.addDownload({ url: fixture.url('/empty.mp4'), destinationDir: destinationOf(instance, 'edges'), startNow: true });
    const one = await instance.manager.addDownload({ url: fixture.url('/one.mp3'), destinationDir: destinationOf(instance, 'edges'), startNow: true });
    const emptyRecord = await waitForStatus(instance.manager, empty.id, 'completed');
    const oneRecord = await waitForStatus(instance.manager, one.id, 'completed');

    expect((await fsp.stat(emptyRecord.targetPath!)).size).toBe(0);
    expect((await fsp.readFile(oneRecord.targetPath!)).equals(Buffer.from([0xaa]))).toBe(true);
  });

  it('pauses mid-transfer, resumes, and produces a byte-identical file', async () => {
    const data = payload(2 * 1024 * 1024, 81);
    const fixture = await createFixtureServer({ '/slow-video.mp4': binaryRoute(data, { mime: 'video/mp4' }) });
    const instance = await setup();

    const result = await instance.manager.addDownload({
      url: fixture.url('/slow-video.mp4'),
      destinationDir: destinationOf(instance, 'pause'),
      speedLimitBps: 256 * 1024,
      startNow: true
    });
    await vi.waitFor(
      () => {
        const record = recordOf(instance.manager, result.id);
        expect(record.downloadedBytes).toBeGreaterThan(512 * 1024);
      },
      { timeout: 15_000, interval: 30 }
    );
    instance.manager.pauseDownload(result.id);
    const paused = await waitForStatus(instance.manager, result.id, 'paused');

    expect(paused.downloadedBytes).toBeGreaterThan(0);
    expect(paused.downloadedBytes).toBeLessThan(data.length);
    instance.manager.resumeDownload(result.id);
    const record = await waitForStatus(instance.manager, result.id, 'completed', 30_000);

    expect((await fsp.readFile(record.targetPath!)).equals(data)).toBe(true);
  });

  it('enforces per-download speed limits', async () => {
    const data = payload(500 * 1024, 91);
    const fixture = await createFixtureServer({ '/limited.mp4': binaryRoute(data, { mime: 'video/mp4' }) });
    const instance = await setup();

    const started = Date.now();
    const result = await instance.manager.addDownload({
      url: fixture.url('/limited.mp4'),
      destinationDir: destinationOf(instance, 'limited'),
      speedLimitBps: 150 * 1024,
      startNow: true
    });
    await waitForStatus(instance.manager, result.id, 'completed', 40_000);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeGreaterThanOrEqual(1300);
    expect(elapsed).toBeLessThan(30_000);
    expect((await fsp.readFile(recordOf(instance.manager, result.id).targetPath!)).equals(data)).toBe(true);
  });

  it('renames conflicting files with the rename policy', async () => {
    const data = payload(64 * 1024, 101);
    const fixture = await createFixtureServer({ '/photo.jpg': binaryRoute(data, { mime: 'image/jpeg' }) });
    const instance = await setup();
    const destination = destinationOf(instance, 'rename');
    await fsp.mkdir(destination, { recursive: true });
    await fsp.writeFile(path.join(destination, 'photo.jpg'), 'previous file');

    const result = await instance.manager.addDownload({ url: fixture.url('/photo.jpg'), destinationDir: destination, startNow: true });
    const record = await waitForStatus(instance.manager, result.id, 'completed');

    expect(record.fileName).toBe('photo (1).jpg');
    expect((await fsp.readFile(record.targetPath!)).equals(data)).toBe(true);
    expect(await fsp.readFile(path.join(destination, 'photo.jpg'), 'utf8')).toBe('previous file');
  });

  it('fails cleanly with the skip policy when the file exists', async () => {
    const data = payload(64 * 1024, 111);
    const fixture = await createFixtureServer({ '/photo.jpg': binaryRoute(data, { mime: 'image/jpeg' }) });
    const instance = await setup();
    instance.settings.update({ patch: { duplicatePolicy: 'skip' } });
    const destination = destinationOf(instance, 'skip');
    await fsp.mkdir(destination, { recursive: true });
    await fsp.writeFile(path.join(destination, 'photo.jpg'), 'existing');

    const result = await instance.manager.addDownload({ url: fixture.url('/photo.jpg'), destinationDir: destination, startNow: true });
    const record = await waitForStatus(instance.manager, result.id, 'failed');

    expect(record.errorCode).toBe('FILE_EXISTS');
    expect(record.error).toContain('already exists');
  });

  it('reports missing files with a friendly HTTP 404 error', async () => {
    const fixture = await createFixtureServer({});
    const instance = await setup();

    const result = await instance.manager.addDownload({ url: fixture.url('/gone.mp4'), destinationDir: destinationOf(instance, 'missing'), startNow: true });
    const record = await waitForStatus(instance.manager, result.id, 'failed');

    expect(record.errorCode).toBe('HTTP_404');
    expect(record.error).toContain('404');
  });

  it('rejects web pages served as download links', async () => {
    const fixture = await createFixtureServer({
      '/session-expired': (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><html><body><h1>Sign in</h1></body></html>');
      }
    });
    const instance = await setup();

    const result = await instance.manager.addDownload({ url: fixture.url('/session-expired'), destinationDir: destinationOf(instance, 'bait'), startNow: true });
    const record = await waitForStatus(instance.manager, result.id, 'failed');

    expect(record.error).toContain('web page');
  });

  it('never auto-opens executables but opens safe completed files', async () => {
    const fixture = await createFixtureServer({
      '/setup.exe': binaryRoute(payload(32 * 1024, 121), { mime: 'application/vnd.microsoft.portable-executable' }),
      '/notes.txt': binaryRoute(Buffer.from('hello'), { mime: 'text/plain' })
    });
    const instance = await setup();

    const exe = await instance.manager.addDownload({
      url: fixture.url('/setup.exe'),
      destinationDir: destinationOf(instance, 'open'),
      autoOpen: true,
      startNow: true
    });
    const txt = await instance.manager.addDownload({
      url: fixture.url('/notes.txt'),
      destinationDir: destinationOf(instance, 'open'),
      autoOpen: true,
      startNow: true
    });
    await waitForStatus(instance.manager, exe.id, 'completed');
    await waitForStatus(instance.manager, txt.id, 'completed');

    expect(instance.openPaths).toHaveLength(1);
    expect(instance.openPaths[0]).toContain('notes.txt');
  });
});

describe('download QA: FTP', () => {
  it('downloads a video file from an FTP server with exact bytes', async () => {
    const data = payload(300 * 1024, 131);
    const fixture = await createFixtureServer({});
    const ftp = await createFtpFixture(data);
    const instance = await setup();

    const result = await instance.manager.addDownload({ url: ftp.url, destinationDir: destinationOf(instance, 'ftp'), startNow: true });
    const record = await waitForStatus(instance.manager, result.id, 'completed', 30_000);

    expect(record.kind).toBe('ftp');
    expect(record.fileName).toBe('movie.mp4');
    expect(record.totalBytes).toBe(data.length);
    expect((await fsp.readFile(record.targetPath!)).equals(data)).toBe(true);
    expect(fixture.requests).toHaveLength(0);
  });
});

describe('download QA: adaptive streaming', () => {
  it('downloads an HLS stream by concatenating every segment in order', async () => {
    const segments = [payload(96 * 1024, 141), payload(88 * 1024, 142), payload(104 * 1024, 143)];
    const playlist = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-TARGETDURATION:4',
      ...segments.flatMap((segment, index) => [`#EXTINF:4.0,`, `seg${index}.ts`]),
      '#EXT-X-ENDLIST',
      ''
    ].join('\n');
    const routes: Record<string, (request: IncomingMessage, response: ServerResponse) => void> = {
      '/hls/stream.m3u8': (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        response.end(playlist);
      }
    };
    segments.forEach((segment, index) => {
      routes[`/hls/seg${index}.ts`] = binaryRoute(segment, { mime: 'video/mp2t' });
    });
    const fixture = await createFixtureServer(routes);
    const instance = await setup();

    const probe = await instance.manager.probeMedia(fixture.url('/hls/stream.m3u8'));
    expect(probe.error).toBe('');
    expect(probe.formats).toHaveLength(1);
    expect(probe.formats[0]?.type).toBe('hls');

    const result = await instance.manager.addDownload({ url: fixture.url('/hls/stream.m3u8'), destinationDir: destinationOf(instance, 'hls'), startNow: true });
    const record = await waitForStatus(instance.manager, result.id, 'completed', 30_000);

    expect(record.kind).toBe('hls');
    expect(record.fileName).toBe('stream.ts');
    const written = await fsp.readFile(record.targetPath!);
    expect(written.equals(Buffer.concat(segments))).toBe(true);
  });

  it('downloads a DASH representation including the initialization section', async () => {
    const init = payload(48 * 1024, 151);
    const segments = [payload(80 * 1024, 152), payload(76 * 1024, 153), payload(84 * 1024, 154)];
    const mpd = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT12S">',
      '  <Period>',
      '    <AdaptationSet mimeType="video/mp4" contentType="video">',
      '      <Representation id="720" bandwidth="2000000" width="1280" height="720">',
      '        <SegmentTemplate media="seg$Number$.m4s" initialization="init.mp4" duration="4" startNumber="0"/>',
      '      </Representation>',
      '    </AdaptationSet>',
      '  </Period>',
      '</MPD>',
      ''
    ].join('\n');
    const routes: Record<string, (request: IncomingMessage, response: ServerResponse) => void> = {
      '/dash/stream.mpd': (_request, response) => {
        response.writeHead(200, { 'Content-Type': 'application/dash+xml' });
        response.end(mpd);
      },
      '/dash/init.mp4': binaryRoute(init, { mime: 'video/mp4' })
    };
    segments.forEach((segment, index) => {
      routes[`/dash/seg${index}.m4s`] = binaryRoute(segment, { mime: 'video/iso.segment' });
    });
    const fixture = await createFixtureServer(routes);
    const instance = await setup();

    const result = await instance.manager.addDownload({ url: fixture.url('/dash/stream.mpd'), destinationDir: destinationOf(instance, 'dash'), startNow: true });
    const record = await waitForStatus(instance.manager, result.id, 'completed', 30_000);

    expect(record.kind).toBe('dash');
    expect(record.fileName).toBe('stream.mp4');
    const written = await fsp.readFile(record.targetPath!);
    expect(written.equals(Buffer.concat([init, ...segments]))).toBe(true);
  });
});
