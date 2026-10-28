import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { describe, it } from 'vitest';
import { HttpClient } from '../src/engine/http-client';
import { HttpDownloadTask } from '../src/engine/http-download';
import { HostLimiter, TokenBucket } from '../src/engine/rate-limiter';
import type { DownloadConfig, EngineCallbacks, EngineRuntime } from '../src/engine/types';

const BLOCK = Buffer.alloc(1024 * 1024, 0xab);

async function bench(label: string, size: number, connections: number, repeat: number): Promise<void> {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('ETag', '"benchmark"');
    const start = match ? Number(match[1]) : 0;
    const end = match ? (match[2] ? Number(match[2]) : size - 1) : size - 1;
    const length = end - start + 1;
    if (match) {
      response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': length });
    } else {
      response.writeHead(200, { 'Content-Length': length });
    }
    let sent = 0;
    const pump = () => {
      while (sent < length) {
        const chunk = Math.min(64 * 1024, length - sent);
        sent += chunk;
        if (!response.write(BLOCK.subarray(0, chunk))) {
          response.once('drain', pump);
          return;
        }
      }
      response.end();
    };
    pump();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/payload.bin`;
  const times: number[] = [];
  const lag = monitorEventLoopDelay({ resolution: 5 });
  lag.enable();
  try {
    for (let index = 0; index < repeat; index += 1) {
      const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdm-bench-'));
      try {
        const config = {
          id: `bench-${index}`,
          kind: 'http',
          url,
          destinationDir: directory,
          fileName: 'payload.bin',
          fileNameExplicit: true,
          headers: {},
          cookies: '',
          referrer: '',
          connections,
          speedLimitBps: 0,
          maxRetries: 1,
          retryBaseDelayMs: 20,
          checksum: '',
          checksumAlgorithm: '',
          conflictPolicy: 'rename',
          tlsAllowInsecure: false,
          sourcePageUrl: ''
        } as DownloadConfig;
        const runtime = {
          http: new HttpClient({
            connectTimeoutMs: 5000,
            idleTimeoutMs: 15_000,
            maxRedirects: 3,
            ipVersion: 'ipv4',
            userAgent: 'MDM-Benchmark/1.0',
            proxy: null,
            maxSocketsPerHost: 16
          }),
          hostLimiter: new HostLimiter(16),
          globalLimiter: new TokenBucket(0),
          logger: () => undefined,
          reservedTargetPaths: new Set<string>()
        } as EngineRuntime;
        const callbacks = {
          onPrepared: () => undefined,
          onProgress: () => undefined,
          onCheckpoint: () => undefined,
          onLog: () => undefined
        } as EngineCallbacks;
        const task = new HttpDownloadTask(config, runtime, callbacks);
        const started = performance.now();
        const outcome = await task.run();
        times.push(performance.now() - started);
        if (outcome.status !== 'completed') throw new Error(`benchmark download ended as ${outcome.status}`);
      } finally {
        await fsp.rm(directory, { recursive: true, force: true });
      }
    }
  } finally {
    lag.disable();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const total = times.reduce((sum, value) => sum + value, 0);
  const median = [...times].sort((left, right) => left - right)[Math.floor(times.length / 2)]!;
  console.log(
    `BENCH ${label.padEnd(28)} runs=${repeat} median=${median.toFixed(0)}ms total=${total.toFixed(0)}ms ` +
      `MB/s=${(size / 1048576 / (median / 1000)).toFixed(0)} http-requests/run=${(requests / repeat).toFixed(1)} ` +
      `loop-lag p99=${(lag.percentile(99) / 1e6).toFixed(1)}ms max=${(lag.max / 1e6).toFixed(1)}ms`
  );
}

describe.skipIf(process.env.MDM_BENCH !== '1')('HTTP throughput benchmark', () => {
  it(
    'measures segmented and single-connection throughput',
    async () => {
      await bench('1 file 256MB, 8 conns', 256 * 1024 * 1024, 8, 3);
      await bench('1 file 256MB, 1 conn', 256 * 1024 * 1024, 1, 3);
      await bench('3MB file x25, 8 conns', 3 * 1024 * 1024, 8, 25);
      await bench('600KB file x25, 8 conns', 600 * 1024, 8, 25);
    },
    600_000
  );
});
