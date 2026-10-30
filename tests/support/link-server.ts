import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';

export interface LinkOptions {
  /** Capacity of the whole line shared by every connection, bytes/s (the ISP plan). */
  lineBps: number;
  /** What the server gives one connection, bytes/s (per-connection throttling). */
  perConnectionBps: number;
  size: number;
  /** Answer 429 once more than this many connections are open (a server that limits parallelism). */
  rejectAbove?: number;
}

export interface LinkServer {
  url: string;
  stats: { maxConcurrent: number; requests: number; rejected: number };
  close(): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const BLOCK = Buffer.alloc(256 * 1024, 0x5a);

/** An HTTP server that behaves like a real connection: per-connection throttle plus a shared line. */
export async function startLinkServer(options: LinkOptions): Promise<LinkServer> {
  const burst = options.lineBps * 0.05;
  let tokens = burst;
  let last = performance.now();
  const takeFromLine = async (bytes: number): Promise<void> => {
    for (;;) {
      const now = performance.now();
      tokens = Math.min(burst, tokens + ((now - last) / 1000) * options.lineBps);
      last = now;
      if (tokens >= bytes) {
        tokens -= bytes;
        return;
      }
      await sleep(Math.max(1, ((bytes - tokens) / options.lineBps) * 1000));
    }
  };

  const stats = { maxConcurrent: 0, requests: 0, rejected: 0 };
  let concurrent = 0;
  const server: Server = createServer((request, response) => {
    stats.requests += 1;
    if (options.rejectAbove !== undefined && concurrent >= options.rejectAbove) {
      stats.rejected += 1;
      response.writeHead(429, { 'Retry-After': '1', 'Content-Length': 0 });
      response.end();
      return;
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('ETag', '"link"');
    const start = match ? Number(match[1]) : 0;
    const end = match ? (match[2] ? Number(match[2]) : options.size - 1) : options.size - 1;
    const length = end - start + 1;
    if (match) {
      response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${options.size}`, 'Content-Length': length });
    } else {
      response.writeHead(200, { 'Content-Length': length });
    }
    concurrent += 1;
    stats.maxConcurrent = Math.max(stats.maxConcurrent, concurrent);
    let closed = false;
    response.on('close', () => {
      if (!closed) concurrent -= 1;
      closed = true;
    });
    void (async () => {
      const chunk = Math.max(8 * 1024, Math.min(BLOCK.length, Math.floor(options.perConnectionBps / 40)));
      let sent = 0;
      let due = performance.now();
      while (sent < length && !response.destroyed) {
        const size = Math.min(chunk, length - sent);
        await takeFromLine(size);
        const wait = due - performance.now();
        if (wait > 0) await sleep(wait);
        due = Math.max(due, performance.now()) + (size / options.perConnectionBps) * 1000;
        if (!response.write(BLOCK.subarray(0, size))) await once(response, 'drain');
        sent += size;
      }
      response.end();
    })().catch(() => response.destroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/file.bin`,
    stats,
    close: async () => {
      server.closeAllConnections();
      server.close();
    }
  };
}
