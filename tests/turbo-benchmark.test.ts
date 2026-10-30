import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'vitest';
import { HttpClient } from '../src/engine/http-client';
import { HttpDownloadTask } from '../src/engine/http-download';
import { HostLimiter, TokenBucket } from '../src/engine/rate-limiter';
import type { DownloadConfig, EngineCallbacks, EngineRuntime } from '../src/engine/types';
import { startLinkServer } from './support/link-server';

/**
 * Turbo versus a fixed number of connections on simulated links of different
 * speeds. Slow (minutes), so it only runs on request:
 *   MDM_BENCH=1 npx vitest run tests/turbo-benchmark.test.ts
 */
const MB = 1024 * 1024;
const mbit = (bytesPerSecond: number): string => ((bytesPerSecond * 8) / 1_000_000).toFixed(0).padStart(3);

interface Scenario {
  name: string;
  line: number;
  perConnection: number;
  size: number;
  rejectAbove?: number;
}

const BASE = 8;
const CEILING = 32;
const SCENARIOS: Scenario[] = [
  { name: '8 Mbit line, already full', line: 1 * MB, perConnection: 0.5 * MB, size: 10 * MB },
  { name: '30 Mbit line, under-used', line: 3.75 * MB, perConnection: 0.25 * MB, size: 64 * MB },
  { name: '100 Mbit line, under-used', line: 12.5 * MB, perConnection: 1 * MB, size: 150 * MB },
  { name: '500 Mbit line, under-used', line: 62.5 * MB, perConnection: 4 * MB, size: 400 * MB },
  { name: '100 Mbit, server allows 10', line: 12.5 * MB, perConnection: 1 * MB, size: 120 * MB, rejectAbove: 10 }
];

async function run(scenario: Scenario, turbo: boolean) {
  const link = await startLinkServer({
    lineBps: scenario.line,
    perConnectionBps: scenario.perConnection,
    size: scenario.size,
    rejectAbove: scenario.rejectAbove
  });
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdm-tbench-'));
  const runtime = {
    http: new HttpClient({
      connectTimeoutMs: 5000,
      idleTimeoutMs: 30000,
      maxRedirects: 3,
      ipVersion: 'ipv4',
      userAgent: 'turbo-bench',
      proxy: null,
      maxSocketsPerHost: BASE
    }),
    hostLimiter: new HostLimiter(BASE),
    globalLimiter: new TokenBucket(0),
    logger: () => undefined,
    reservedTargetPaths: new Set<string>()
  } as unknown as EngineRuntime;
  const config = {
    id: 'bench',
    kind: 'http',
    url: link.url,
    destinationDir: dir,
    fileName: 'file.bin',
    fileNameExplicit: true,
    headers: {},
    cookies: '',
    referrer: '',
    connections: BASE,
    turbo: turbo ? { maxConnections: CEILING } : undefined,
    speedLimitBps: 0,
    maxRetries: 3,
    retryBaseDelayMs: 100,
    checksum: '',
    checksumAlgorithm: '',
    conflictPolicy: 'rename',
    tlsAllowInsecure: false,
    sourcePageUrl: ''
  } as unknown as DownloadConfig;
  const callbacks = { onPrepared: () => undefined, onProgress: () => undefined, onCheckpoint: () => undefined, onLog: () => undefined } as unknown as EngineCallbacks;
  const started = performance.now();
  const outcome = await new HttpDownloadTask(config, runtime, callbacks).run();
  const seconds = (performance.now() - started) / 1000;
  let intact = false;
  if (outcome.status === 'completed') {
    const stat = await fsp.stat(outcome.result.targetPath);
    intact = stat.size === scenario.size;
  }
  await fsp.rm(dir, { recursive: true, force: true });
  const result = { seconds, speed: scenario.size / seconds, peak: link.stats.maxConcurrent, rejected: link.stats.rejected, intact };
  await link.close();
  return result;
}

describe.skipIf(process.env.MDM_BENCH !== '1')('Turbo benchmark', () => {
  it('compares fixed connections with Turbo across link speeds', async () => {
    console.log(`TBENCH base=${BASE} connections, Turbo ceiling=${CEILING}`);
    for (const scenario of SCENARIOS) {
      const fixed = await run(scenario, false);
      const turbo = await run(scenario, true);
      const line = scenario.line;
      console.log(
        `TBENCH ${scenario.name.padEnd(28)} line=${mbit(line)} Mbit/s | fixed ${mbit(fixed.speed)} Mbit/s (${((fixed.speed / line) * 100).toFixed(0)}% of line, peak ${fixed.peak}) ` +
          `| turbo ${mbit(turbo.speed)} Mbit/s (${((turbo.speed / line) * 100).toFixed(0)}% of line, peak ${turbo.peak}, refused ${turbo.rejected}) ` +
          `| time ${fixed.seconds.toFixed(1)}s -> ${turbo.seconds.toFixed(1)}s (x${(fixed.seconds / turbo.seconds).toFixed(2)}) | intact ${fixed.intact && turbo.intact}`
      );
    }
  }, 900_000);
});
