import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpClient } from '../src/engine/http-client';
import { HttpDownloadTask } from '../src/engine/http-download';
import { HostLimiter, TokenBucket } from '../src/engine/rate-limiter';
import type {
  DownloadConfig,
  EngineCallbacks,
  EngineCheckpoint,
  EngineRuntime,
  PreparedDownload
} from '../src/engine/types';

interface FixtureServer {
  server: Server;
  url: string;
  ranges: Array<string | undefined>;
  userAgents: Array<string | undefined>;
}

const servers: Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
  await Promise.all(
    directories.splice(0).map((directory) => fsp.rm(directory, { recursive: true, force: true }))
  );
});

function fixtureData(size = 4 * 1024 * 1024 + 17): Buffer {
  const data = Buffer.alloc(size);
  for (let index = 0; index < size; index++) data[index] = (index * 31 + 7) % 251;
  return data;
}

async function startFixtureServer(
  data: Buffer,
  options: { ranges: boolean; throttle?: { chunkSize: number; delayMs: number }; requireUserAgent?: string }
): Promise<FixtureServer> {
  const ranges: Array<string | undefined> = [];
  const userAgents: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    ranges.push(request.headers.range);
    userAgents.push(request.headers['user-agent']);
    if (options.requireUserAgent && request.headers['user-agent'] !== options.requireUserAgent) {
      response.writeHead(403, { 'Content-Type': 'text/plain' });
      response.end('forbidden');
      return;
    }
    const rangeHeader = request.headers.range;
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('ETag', '"fixture-v1"');

    if (options.ranges) {
      response.setHeader('Accept-Ranges', 'bytes');
      if (rangeHeader) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
        if (!match) {
          response.writeHead(416, { 'Content-Range': `bytes */${data.length}` });
          response.end();
          return;
        }
        const start = Number(match[1]);
        const end = match[2] ? Number(match[2]) : data.length - 1;
        if (start >= data.length || end < start) {
          response.writeHead(416, { 'Content-Range': `bytes */${data.length}` });
          response.end();
          return;
        }
        const boundedEnd = Math.min(end, data.length - 1);
        const slice = data.subarray(start, boundedEnd + 1);
        response.writeHead(206, {
          'Content-Range': `bytes ${start}-${boundedEnd}/${data.length}`,
          'Content-Length': slice.length
        });
        streamFixture(response, slice, options.throttle && slice.length > 1 ? options.throttle : null, request);
        return;
      }
    }

    response.writeHead(200, { 'Content-Length': data.length });
    streamFixture(response, data, options.throttle ?? null, request);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}/payload.bin`, ranges, userAgents };
}

function streamFixture(
  response: import('node:http').ServerResponse,
  data: Buffer,
  throttle: { chunkSize: number; delayMs: number } | null,
  request: import('node:http').IncomingMessage
): void {
  if (!throttle) {
    response.end(data);
    return;
  }
  let offset = 0;
  const timer = setInterval(() => {
    if (response.destroyed || request.destroyed) {
      clearInterval(timer);
      return;
    }
    if (offset >= data.length) {
      clearInterval(timer);
      response.end();
      return;
    }
    const next = data.subarray(offset, Math.min(data.length, offset + throttle.chunkSize));
    offset += next.length;
    response.write(next);
  }, throttle.delayMs);
  response.once('close', () => clearInterval(timer));
}

async function temporaryDirectory(): Promise<string> {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdm-http-'));
  directories.push(directory);
  return directory;
}

function runtime(): EngineRuntime {
  return {
    http: new HttpClient({
      connectTimeoutMs: 5_000,
      idleTimeoutMs: 5_000,
      maxRedirects: 3,
      ipVersion: 'ipv4',
      userAgent: 'MDM-Test/1.0',
      proxy: null,
      maxSocketsPerHost: 8
    }),
    hostLimiter: new HostLimiter(8),
    globalLimiter: new TokenBucket(0),
    logger: () => undefined,
    reservedTargetPaths: new Set()
  };
}

function config(overrides: Partial<DownloadConfig> & { url: string; destinationDir: string }): DownloadConfig {
  return {
    id: 'fixture-download',
    kind: 'http',
    fileName: 'payload.bin',
    fileNameExplicit: true,
    headers: {},
    cookies: '',
    referrer: '',
    connections: 3,
    speedLimitBps: 0,
    maxRetries: 1,
    retryBaseDelayMs: 50,
    checksum: '',
    checksumAlgorithm: '',
    conflictPolicy: 'rename',
    sourcePageUrl: '',
    ...overrides
  };
}

function callbacks(): EngineCallbacks & {
  prepared: PreparedDownload[];
  checkpoints: EngineCheckpoint[];
  logs: string[];
} {
  const prepared: PreparedDownload[] = [];
  const checkpoints: EngineCheckpoint[] = [];
  const logs: string[] = [];
  return {
    prepared,
    checkpoints,
    logs,
    onPrepared: (value) => {
      prepared.push(value);
    },
    onProgress: () => undefined,
    onCheckpoint: (value) => {
      checkpoints.push(value);
    },
    onLog: (_level, message) => {
      logs.push(message);
    }
  };
}

describe('HTTP range downloads', () => {
  it('downloads a segmented file and verifies its checksum', async () => {
    const data = fixtureData();
    const fixture = await startFixtureServer(data, { ranges: true });
    const directory = await temporaryDirectory();
    const callbacksValue = callbacks();
    const expectedHash = createHash('sha256').update(data).digest('hex');
    const task = new HttpDownloadTask(
      config({
        url: fixture.url,
        destinationDir: directory,
        connections: 3,
        checksum: expectedHash,
        checksumAlgorithm: 'sha256'
      }),
      runtime(),
      callbacksValue
    );

    const outcome = await task.run();
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') throw new Error('expected completion');
    expect(outcome.result.checksumStatus).toBe('verified');
    expect(outcome.result.totalBytes).toBe(data.length);
    expect(outcome.result.segments.length).toBeGreaterThan(1);
    expect(outcome.result.segments.every((segment) => segment.status === 'complete')).toBe(true);
    expect((await fsp.readFile(outcome.result.targetPath)).equals(data)).toBe(true);
    expect(callbacksValue.prepared).toHaveLength(1);
    expect(fixture.ranges.filter((value) => value?.startsWith('bytes=')).length).toBeGreaterThan(2);
  });

  it('retries a transient TLS handshake failure before preparing the download', async () => {
    const data = fixtureData(600 * 1024);
    const fixture = await startFixtureServer(data, { ranges: true });
    const directory = await temporaryDirectory();
    const runtimeValue = runtime();
    const originalRequest = runtimeValue.http.request.bind(runtimeValue.http);
    const callbacksValue = callbacks();
    let requests = 0;
    runtimeValue.http.request = async (url, options) => {
      requests += 1;
      if (requests === 1) {
        throw Object.assign(
          new Error('Client network socket disconnected before secure TLS connection was established'),
          { code: 'ECONNRESET' }
        );
      }
      return originalRequest(url, options);
    };
    const task = new HttpDownloadTask(
      config({
        url: fixture.url,
        destinationDir: directory,
        connections: 2,
        maxRetries: 1,
        retryBaseDelayMs: 10
      }),
      runtimeValue,
      callbacksValue
    );

    const outcome = await task.run();
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') throw new Error('expected completion');
    expect((await fsp.readFile(outcome.result.targetPath)).equals(data)).toBe(true);
    expect(requests).toBeGreaterThan(1);
    expect(callbacksValue.logs.some((line) => line.includes('TLS handshake failed'))).toBe(true);
  });

  it('retries a transient certificate-chain failure before preparing the download', async () => {
    const data = fixtureData(600 * 1024);
    const fixture = await startFixtureServer(data, { ranges: true });
    const directory = await temporaryDirectory();
    const runtimeValue = runtime();
    const originalRequest = runtimeValue.http.request.bind(runtimeValue.http);
    const callbacksValue = callbacks();
    let requests = 0;
    runtimeValue.http.request = async (url, options) => {
      requests += 1;
      if (requests === 1) {
        throw Object.assign(new Error('self signed certificate in certificate chain'), {
          code: 'SELF_SIGNED_CERT_IN_CHAIN'
        });
      }
      return originalRequest(url, options);
    };
    const task = new HttpDownloadTask(
      config({
        url: fixture.url,
        destinationDir: directory,
        connections: 2,
        maxRetries: 5,
        retryBaseDelayMs: 10
      }),
      runtimeValue,
      callbacksValue
    );

    const outcome = await task.run();
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') throw new Error('expected completion');
    expect((await fsp.readFile(outcome.result.targetPath)).equals(data)).toBe(true);
    expect(requests).toBeGreaterThan(1);
    expect(callbacksValue.logs.some((line) => line.includes('certificate chain'))).toBe(true);
    expect(callbacksValue.logs.some((line) => line.includes('(1/1)'))).toBe(true);
  });

  it('caps certificate-chain retries at one even when maxRetries is higher', async () => {
    const directory = await temporaryDirectory();
    const runtimeValue = runtime();
    const callbacksValue = callbacks();
    let requests = 0;
    runtimeValue.http.request = async () => {
      requests += 1;
      throw Object.assign(new Error('self signed certificate in certificate chain'), {
        code: 'SELF_SIGNED_CERT_IN_CHAIN'
      });
    };
    const task = new HttpDownloadTask(
      config({
        url: 'https://chain-failure.invalid/payload.bin',
        destinationDir: directory,
        maxRetries: 5,
        retryBaseDelayMs: 10
      }),
      runtimeValue,
      callbacksValue
    );

    await expect(task.run()).rejects.toMatchObject({ code: 'TLS_CHAIN' });
    expect(requests).toBe(2);
  });

  it('falls back to a plain full-file request when the server rejects range probes', async () => {
    const data = fixtureData(300 * 1024);
    const ranges: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      ranges.push(request.headers.range);
      if (request.headers.range) {
        response.writeHead(403, { 'Content-Type': 'text/plain' });
        response.end('range not allowed');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': data.length });
      response.end(data);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const directory = await temporaryDirectory();
    const callbacksValue = callbacks();
    const task = new HttpDownloadTask(
      config({ url: `http://127.0.0.1:${port}/signed.mp4`, destinationDir: directory }),
      runtime(),
      callbacksValue
    );

    const outcome = await task.run();
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') throw new Error('expected completion');
    expect(outcome.result.totalBytes).toBe(data.length);
    expect(outcome.result.segments).toHaveLength(1);
    expect(callbacksValue.prepared[0]?.resumable).toBe(false);
    expect(ranges[0]).toBe('bytes=0-0');
    expect(ranges[1]).toBeUndefined();
    expect((await fsp.readFile(outcome.result.targetPath)).equals(data)).toBe(true);
  });

  it('publishes with its requested name when its own target is reserved', async () => {
    const data = fixtureData(300 * 1024);
    const fixture = await startFixtureServer(data, { ranges: true });
    const directory = await temporaryDirectory();
    const runtimeValue = runtime();
    const reservations = new Set<string>();
    runtimeValue.reservedTargetPaths = reservations;
    const callbacksValue = callbacks();
    const onPrepared = callbacksValue.onPrepared;
    callbacksValue.onPrepared = (value) => {
      onPrepared(value);
      reservations.add(value.targetPath);
    };
    const task = new HttpDownloadTask(
      config({ url: fixture.url, destinationDir: directory }),
      runtimeValue,
      callbacksValue
    );

    const outcome = await task.run();
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') throw new Error('expected completion');
    expect(outcome.result.fileName).toBe('payload.bin');
    expect(outcome.result.targetPath).toBe(path.join(directory, 'payload.bin'));
    expect(await fsp.readdir(directory)).toEqual(['payload.bin']);
  });

  it('uses the supplied browser User-Agent for every request to a UA-bound server', async () => {
    const browserUserAgent =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/153.0.0.0 Safari/537.36';
    const data = fixtureData();
    const fixture = await startFixtureServer(data, { ranges: true, requireUserAgent: browserUserAgent });
    const directory = await temporaryDirectory();
    const task = new HttpDownloadTask(
      config({
        url: fixture.url,
        destinationDir: directory,
        connections: 3,
        headers: { 'User-Agent': browserUserAgent }
      }),
      runtime(),
      callbacks()
    );

    const outcome = await task.run();
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') throw new Error('expected completion');
    expect((await fsp.readFile(outcome.result.targetPath)).equals(data)).toBe(true);
    expect(fixture.userAgents.length).toBeGreaterThan(1);
    expect(fixture.userAgents.every((value) => value === browserUserAgent)).toBe(true);
  });

  it('falls back to a single request when the server ignores ranges', async () => {
    const data = fixtureData(700 * 1024 + 11);
    const fixture = await startFixtureServer(data, { ranges: false });
    const directory = await temporaryDirectory();
    const task = new HttpDownloadTask(
      config({ url: fixture.url, destinationDir: directory, connections: 4 }),
      runtime(),
      callbacks()
    );

    const outcome = await task.run();
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') throw new Error('expected completion');
    expect(outcome.result.segments).toHaveLength(1);
    expect((await fsp.readFile(outcome.result.targetPath)).equals(data)).toBe(true);
  });

  it('rejects a checksum mismatch without publishing the file', async () => {
    const data = fixtureData(600 * 1024);
    const fixture = await startFixtureServer(data, { ranges: true });
    const directory = await temporaryDirectory();
    const task = new HttpDownloadTask(
      config({
        url: fixture.url,
        destinationDir: directory,
        checksum: '0'.repeat(64),
        checksumAlgorithm: 'sha256'
      }),
      runtime(),
      callbacks()
    );

    await expect(task.run()).rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
    await expect(fsp.access(path.join(directory, 'payload.bin'))).rejects.toThrow();
  });

  it('pauses with a checkpoint and resumes to a complete file', async () => {
    const data = fixtureData(5 * 1024 * 1024 + 3);
    const fixture = await startFixtureServer(data, {
      ranges: true,
      throttle: { chunkSize: 24 * 1024, delayMs: 10 }
    });
    const directory = await temporaryDirectory();
    const firstCallbacks = callbacks();
    let firstTask: HttpDownloadTask | null = null;
    firstCallbacks.onPrepared = (value) => {
      firstCallbacks.prepared.push(value);
      setTimeout(() => firstTask?.pause(), 180);
    };
    firstTask = new HttpDownloadTask(
      config({ url: fixture.url, destinationDir: directory, connections: 2, id: 'resume-source' }),
      runtime(),
      firstCallbacks
    );

    const paused = await firstTask.run();
    expect(paused.status).toBe('paused');
    if (paused.status !== 'paused' || !paused.checkpoint) throw new Error('expected a resume checkpoint');
    expect(paused.checkpoint.downloadedBytes).toBeGreaterThan(0);
    expect(paused.checkpoint.downloadedBytes).toBeLessThan(data.length);
    const saved = paused.checkpoint.prepared;

    const secondTask = new HttpDownloadTask(
      config({
        url: fixture.url,
        destinationDir: directory,
        connections: 2,
        id: 'resume-source',
        resume: {
          tempPath: saved.tempPath,
          targetPath: saved.targetPath,
          fileName: saved.fileName,
          finalUrl: saved.finalUrl,
          totalBytes: saved.totalBytes,
          downloadedBytes: paused.checkpoint.downloadedBytes,
          resumable: saved.resumable,
          etag: saved.etag,
          lastModified: saved.lastModified,
          mimeType: saved.mimeType,
          segments: paused.checkpoint.prepared.segments
        }
      }),
      runtime(),
      callbacks()
    );

    const resumed = await secondTask.run();
    expect(resumed.status).toBe('completed');
    if (resumed.status !== 'completed') throw new Error('expected completion after resume');
    expect((await fsp.readFile(resumed.result.targetPath)).equals(data)).toBe(true);
  });
});
