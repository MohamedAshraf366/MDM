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
    id: 'dropped-connection',
    kind: 'http',
    url,
    destinationDir,
    fileName: 'p.bin',
    fileNameExplicit: true,
    headers: {},
    cookies: '',
    referrer: '',
    connections: 1,
    speedLimitBps: 0,
    maxRetries: 3,
    retryBaseDelayMs: 20,
    checksum: '',
    checksumAlgorithm: '',
    conflictPolicy: 'rename',
    sourcePageUrl: ''
  };
}

describe('segment retry after a dropped connection', () => {
  it('does not leave a hole when the stream breaks with unflushed bytes', async () => {
    const size = 4 * 1024 * 1024 + 17;
    const data = Buffer.alloc(size);
    for (let index = 0; index < size; index++) data[index] = (index * 31 + 7) % 251;
    let dataRequests = 0;
    const server = createServer((request, response) => {
      const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
      response.setHeader('Accept-Ranges', 'bytes');
      response.setHeader('ETag', '"v1"');
      if (!match) {
        response.writeHead(200, { 'Content-Length': size });
        response.end(data);
        return;
      }
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : size - 1;
      const slice = data.subarray(start, end + 1);
      response.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': slice.length
      });
      if (slice.length > 1) dataRequests++;
      if (slice.length > 1 && dataRequests === 1) {
        // First real data request: send 600 KB, below the 1 MB flush threshold,
        // then drop the connection so the bytes are only counted, not written.
        response.write(slice.subarray(0, 600 * 1024));
        setTimeout(() => request.socket.destroy(), 80);
        return;
      }
      response.end(slice);
    });
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/p.bin`;

    const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdm-drop-'));
    directories.push(directory);
    const task = new HttpDownloadTask(config(url, directory), runtime(), {
      onPrepared: () => undefined,
      onProgress: () => undefined,
      onCheckpoint: () => undefined,
      onLog: () => undefined
    });

    const outcome = await task.run();
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(dataRequests).toBeGreaterThanOrEqual(2);
    const output = await fsp.readFile(outcome.result.targetPath);
    expect(output.length).toBe(data.length);
    let firstDifference = -1;
    for (let index = 0; index < data.length; index++) {
      if (output[index] !== data[index]) {
        firstDifference = index;
        break;
      }
    }
    expect(firstDifference).toBe(-1);
  });
});
