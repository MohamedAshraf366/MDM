import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpClient } from '../src/engine/http-client';
import { HttpDownloadTask } from '../src/engine/http-download';
import { HostLimiter, TokenBucket } from '../src/engine/rate-limiter';
import type { DownloadConfig, EngineRuntime } from '../src/engine/types';

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
  await Promise.all(directories.splice(0).map((directory) => fsp.rm(directory, { recursive: true, force: true })));
});

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

function config(url: string, destinationDir: string): DownloadConfig {
  return {
    id: 'credential-scope',
    kind: 'http',
    url,
    destinationDir,
    fileName: 'file.bin',
    fileNameExplicit: true,
    headers: { Authorization: 'Bearer SECRET-TOKEN' },
    cookies: 'sid=SECRET-COOKIE',
    referrer: '',
    connections: 1,
    speedLimitBps: 0,
    maxRetries: 1,
    retryBaseDelayMs: 20,
    checksum: '',
    checksumAlgorithm: '',
    conflictPolicy: 'rename',
    sourcePageUrl: ''
  };
}

describe('credential scoping across redirects', () => {
  it('does not send Authorization or Cookie to the redirect target', async () => {
    const data = Buffer.alloc(3 * 1024 * 1024, 7);
    const seenByTarget: IncomingHttpHeaders[] = [];
    const seenByOrigin: IncomingHttpHeaders[] = [];
    const target = createServer((request, response) => {
      seenByTarget.push(request.headers);
      const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
      response.setHeader('Accept-Ranges', 'bytes');
      if (!match) {
        response.writeHead(200, { 'Content-Length': data.length });
        response.end(data);
        return;
      }
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : data.length - 1;
      response.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${data.length}`,
        'Content-Length': end - start + 1
      });
      response.end(data.subarray(start, end + 1));
    });
    servers.push(target);
    target.listen(0, '127.0.0.1');
    await once(target, 'listening');
    const targetPort = (target.address() as AddressInfo).port;

    // The origin uses 127.0.0.1, the redirect target uses localhost: same
    // machine, different hostname, so credentials must not follow.
    const origin = createServer((request, response) => {
      seenByOrigin.push(request.headers);
      response.writeHead(302, { Location: `http://localhost:${targetPort}/file.bin` });
      response.end();
    });
    servers.push(origin);
    origin.listen(0, '127.0.0.1');
    await once(origin, 'listening');
    const url = `http://127.0.0.1:${(origin.address() as AddressInfo).port}/file.bin`;

    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdm-leak-'));
    directories.push(directory);
    const task = new HttpDownloadTask(config(url, directory), runtime(), {
      onPrepared: () => undefined,
      onProgress: () => undefined,
      onCheckpoint: () => undefined,
      onLog: () => undefined
    });

    const outcome = await task.run();
    expect(outcome.status).toBe('completed');
    expect(seenByOrigin.length).toBeGreaterThan(0);
    expect(seenByOrigin[0]?.authorization).toBe('Bearer SECRET-TOKEN');
    expect(seenByOrigin[0]?.cookie).toBe('sid=SECRET-COOKIE');
    expect(seenByTarget.length).toBeGreaterThan(0);
    const leaked = seenByTarget.filter((headers) => headers.authorization || headers.cookie);
    expect(leaked).toHaveLength(0);
  });
});
