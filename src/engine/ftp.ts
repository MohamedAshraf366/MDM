import net from 'node:net';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { DownloadError, friendlyErrorMessage, isRetryableNetworkError, mapNetworkError } from './errors';
import {
  atomicPlace,
  checkDiskSpace,
  fileExists,
  resolveTargetPath,
  reservedPathsExcept,
  SparseFileWriter,
  tempFilePath
} from './fs-utils';
import { hashFile } from './checksum';
import { backoffDelay, SpeedMeter } from './rate-limiter';
import { CHECKPOINT_INTERVAL_MS, PROGRESS_INTERVAL_MS } from '../shared/defaults';
import { sanitizeFileName } from '../shared/validation';
import type {
  DownloadConfig,
  EngineCallbacks,
  EngineCheckpoint,
  EngineOutcome,
  EngineRuntime,
  PreparedDownload
} from './types';
import type { ChecksumStatus, DownloadSegment } from '../shared/types';

interface FtpResponse {
  code: number;
  message: string;
}

class FtpControl {
  private socket: net.Socket | null = null;
  private buffer = '';
  private queue: FtpResponse[] = [];
  private waiter: { resolve: (response: FtpResponse) => void; reject: (error: Error) => void } | null = null;
  private closed = false;
  private error: Error | null = null;

  async connect(host: string, port: number, timeoutMs: number, signal: AbortSignal): Promise<FtpResponse> {
    await new Promise<void>((resolve, reject) => {
      const socket = net.connect({ host, port });
      this.socket = socket;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new DownloadError('The FTP control connection timed out.', 'TIMEOUT', { retryable: true }));
      }, timeoutMs);
      timer.unref?.();
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.setTimeout(Math.max(30_000, timeoutMs));
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(mapNetworkError(error));
      });
      socket.on('data', (chunk) => this.onData(chunk));
      socket.on('timeout', () => {
        socket.destroy(new DownloadError('The FTP connection stalled.', 'TIMEOUT', { retryable: true }));
      });
      socket.on('close', () => {
        this.closed = true;
        if (this.waiter) {
          this.waiter.reject(this.error ?? new DownloadError('The FTP server closed the connection.', 'NETWORK', { retryable: true }));
          this.waiter = null;
        }
      });
      const onAbort = () => {
        socket.destroy(new DownloadError('The download was stopped.', 'ABORTED'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      socket.once('close', () => signal.removeEventListener('abort', onAbort));
    });
    return this.readResponse();
  }

  async command(command: string): Promise<FtpResponse> {
    if (!this.socket || this.closed) throw new DownloadError('The FTP connection is closed.', 'NETWORK', { retryable: true });
    this.socket.write(`${command}\r\n`);
    return this.readResponse();
  }

  async commandExpect(command: string, expected: number[]): Promise<FtpResponse> {
    const response = await this.command(command);
    if (!expected.includes(response.code)) {
      throw new DownloadError(`FTP server rejected ${command.split(' ')[0]}: ${response.code} ${response.message}`, 'NETWORK', {
        retryable: response.code >= 400 && response.code < 500
      });
    }
    return response;
  }

  readResponse(): Promise<FtpResponse> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    if (this.closed) return Promise.reject(this.error ?? new DownloadError('The FTP connection is closed.', 'NETWORK', { retryable: true }));
    return new Promise<FtpResponse>((resolve, reject) => {
      if (this.waiter) {
        const previous = this.waiter;
        this.waiter = { resolve: (response) => { previous.resolve(response); resolve(response); }, reject };
      } else {
        this.waiter = { resolve, reject };
      }
    });
  }

  async close(): Promise<void> {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    try {
      if (!this.closed) socket.write('QUIT\r\n');
      socket.destroy();
    } catch {
      // Best-effort.
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      this.consumeLine(line);
    }
  }

  private pendingMultiline: { code: number; lines: string[] } | null = null;

  private consumeLine(line: string): void {
    const multilineStart = /^(\d{3})-(.*)$/.exec(line);
    if (this.pendingMultiline) {
      const end = new RegExp(`^${this.pendingMultiline.code} (.*)$`).exec(line);
      if (end) {
        this.pendingMultiline.lines.push(end[1] ?? '');
        const response = { code: this.pendingMultiline.code, message: this.pendingMultiline.lines.join('\n') };
        this.pendingMultiline = null;
        this.deliver(response);
      } else {
        this.pendingMultiline.lines.push(line);
      }
      return;
    }
    if (multilineStart) {
      this.pendingMultiline = { code: Number(multilineStart[1]), lines: [multilineStart[2] ?? ''] };
      return;
    }
    const match = /^(\d{3})(?: (.*))?$/.exec(line);
    if (!match) return;
    this.deliver({ code: Number(match[1]), message: match[2] ?? '' });
  }

  private deliver(response: FtpResponse): void {
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      waiter.resolve(response);
    } else {
      this.queue.push(response);
    }
  }
}

interface FtpProbe {
  size: number | null;
  resumeSupported: boolean;
  lastModified: string;
  finalUrl: string;
}

async function connectControl(url: URL, timeoutMs: number, signal: AbortSignal): Promise<FtpControl> {
  const control = new FtpControl();
  const port = url.port ? Number(url.port) : 21;
  const greeting = await control.connect(url.hostname, port, timeoutMs, signal);
  if (greeting.code !== 220) {
    await control.close();
    throw new DownloadError(`FTP server refused the connection: ${greeting.code} ${greeting.message}`, 'NETWORK', {
      retryable: true
    });
  }
  const user = decodeURIComponent(url.username || 'anonymous');
  const pass = decodeURIComponent(url.password || 'anonymous@');
  const userResponse = await control.command(sanitizeCommandArg(`USER ${user}`));
  if (userResponse.code === 331) {
    await control.commandExpect(sanitizeCommandArg(`PASS ${pass}`), [230, 202]);
  } else if (userResponse.code !== 230) {
    await control.close();
    throw new DownloadError(`FTP login failed: ${userResponse.code} ${userResponse.message}`, 'HTTP_403');
  }
  return control;
}

function sanitizeCommandArg(value: string): string {
  return value.replace(/[\r\n]/g, '');
}

async function enterPassive(control: FtpControl, controlHost: string): Promise<net.Socket> {
  let response = await control.command('EPSV');
  if (response.code === 229) {
    const match = /\(\|\|\|(\d+)\|\)/.exec(response.message);
    if (match) {
      return await openDataSocket(controlHost, Number(match[1]));
    }
  }
  response = await control.command('PASV');
  if (response.code !== 227) {
    throw new DownloadError(`FTP server refused passive mode: ${response.code} ${response.message}`, 'NETWORK', { retryable: true });
  }
  const match = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(response.message);
  if (!match) throw new DownloadError('FTP server returned an invalid passive port.', 'NETWORK', { retryable: true });
  const host = `${match[1]}.${match[2]}.${match[3]}.${match[4]}`;
  const port = Number(match[5]) * 256 + Number(match[6]);
  try {
    return await openDataSocket(host, port);
  } catch {
    return await openDataSocket(controlHost, port);
  }
}

function openDataSocket(host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new DownloadError('The FTP data connection timed out.', 'TIMEOUT', { retryable: true }));
    }, 20_000);
    timer.unref?.();
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(mapNetworkError(error));
    });
  });
}

export async function probeFtp(url: string, runtime: EngineRuntime, signal?: AbortSignal): Promise<FtpProbe> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DownloadError('The FTP URL is not valid.', 'INVALID_URL');
  }
  if (parsed.protocol !== 'ftp:') throw new DownloadError('Not an FTP URL.', 'UNSUPPORTED_PROTOCOL');
  const localController = new AbortController();
  const abort = () => localController.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const control = await connectControl(parsed, 20_000, localController.signal);
  try {
    await control.commandExpect('TYPE I', [200]);
    const remotePath = normalizeRemotePath(parsed);
    let size: number | null = null;
    const sizeResponse = await control.command(`SIZE ${sanitizeCommandArg(remotePath)}`).catch(() => null);
    if (sizeResponse?.code === 213) {
      const parsedSize = Number(sizeResponse.message.trim());
      if (Number.isFinite(parsedSize)) size = parsedSize;
    }
    let lastModified = '';
    const mdtm = await control.command(`MDTM ${sanitizeCommandArg(remotePath)}`).catch(() => null);
    if (mdtm?.code === 213) lastModified = mdtm.message.trim();
    let resumeSupported = false;
    const rest = await control.command('REST 0').catch(() => null);
    resumeSupported = rest?.code === 350;
    return { size, resumeSupported, lastModified, finalUrl: parsed.toString() };
  } finally {
    await control.close();
    signal?.removeEventListener('abort', abort);
  }
}

function normalizeRemotePath(url: URL): string {
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    pathname = url.pathname;
  }
  return pathname || '/';
}

export class FtpDownloadTask {
  private readonly config: DownloadConfig;
  private readonly runtime: EngineRuntime;
  private readonly callbacks: EngineCallbacks;
  private readonly controller = new AbortController();
  private readonly speedMeter = new SpeedMeter();
  private paused = false;
  private canceled = false;
  private attempts = 0;
  private prepared: PreparedDownload | null = null;
  private writer: SparseFileWriter | null = null;
  private lastProgressAt = 0;
  private lastCheckpointAt = 0;
  private checkpointChain: Promise<void> = Promise.resolve();
  private control: FtpControl | null = null;
  private dataSocket: net.Socket | null = null;

  constructor(config: DownloadConfig, runtime: EngineRuntime, callbacks: EngineCallbacks) {
    this.config = config;
    this.runtime = runtime;
    this.callbacks = callbacks;
  }

  pause(): void {
    if (this.canceled || this.paused) return;
    this.paused = true;
    this.controller.abort();
    this.dataSocket?.destroy();
    void this.control?.close();
  }

  cancel(): void {
    if (this.canceled) return;
    this.canceled = true;
    this.controller.abort();
    this.dataSocket?.destroy();
    void this.control?.close();
  }

  async run(): Promise<EngineOutcome> {
    try {
      const parsed = new URL(this.config.url);
      const probe = await probeFtp(this.config.url, this.runtime, this.controller.signal).catch((error) => {
        if (this.paused || this.canceled) throw error;
        throw error;
      });
      if (this.paused) return this.pausedOutcome();
      if (this.canceled) return { status: 'canceled' };
      await this.prepare(parsed, probe);
      await this.download();
      if (this.paused) return this.pausedOutcome();
      if (this.canceled) return { status: 'canceled' };
      return await this.finalize();
    } catch (error) {
      if (this.canceled) {
        await this.cleanupTemp();
        return { status: 'canceled' };
      }
      if (this.paused) return this.pausedOutcome();
      throw mapNetworkError(error);
    } finally {
      await this.closeControl();
      await this.closeWriter();
    }
  }

  private async prepare(parsed: URL, probe: FtpProbe): Promise<void> {
    const rawName = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? 'ftp-download');
    const fileName = sanitizeFileName(this.config.fileNameExplicit && this.config.fileName ? this.config.fileName : rawName);
    let destinationDir = path.resolve(this.config.destinationDir);
    if (this.runtime.resolveDirectory) {
      destinationDir = await this.runtime.resolveDirectory(fileName, 'application/octet-stream');
    }
    await fsp.mkdir(destinationDir, { recursive: true });

    const resume = this.config.resume;
    let reusable = false;
    if (resume && probe.resumeSupported && probe.size !== null && resume.totalBytes === probe.size && resume.tempPath) {
      if (path.dirname(path.resolve(resume.tempPath)) === path.resolve(destinationDir)) {
        reusable = await fileExists(resume.tempPath);
      }
    }
    const tempPath = reusable && resume ? resume.tempPath : tempFilePath(destinationDir, this.config.id);
    if (!reusable && resume?.tempPath) {
      await fsp.rm(resume.tempPath, { force: true }).catch(() => undefined);
    }
    const targetPath =
      reusable && resume
        ? await resolveTargetPath(destinationDir, path.basename(resume.targetPath), 'rename', this.reservedSet())
        : await resolveTargetPath(destinationDir, fileName, this.config.conflictPolicy, this.reservedSet());
    const total = probe.size;
    await checkDiskSpace(destinationDir, total, this.runtime.diskSpaceProbe);
    const already = reusable && resume ? Math.min(resume.downloadedBytes, total ?? 0) : 0;
    const segments: DownloadSegment[] = [
      { index: 0, startByte: 0, endByte: total !== null ? total - 1 : null, downloadedBytes: already, status: already > 0 ? 'active' : 'pending' }
    ];
    this.prepared = {
      finalUrl: probe.finalUrl,
      fileName,
      destinationDir,
      targetPath,
      tempPath,
      totalBytes: total,
      downloadedBytes: already,
      resumable: probe.resumeSupported && total !== null,
      etag: '',
      lastModified: probe.lastModified,
      mimeType: 'application/octet-stream',
      segments,
      kind: 'ftp'
    };
    this.writer = new SparseFileWriter(tempPath);
    await this.writer.open(total);
    await this.callbacks.onPrepared(this.prepared, [this.config.url]);
    await this.saveCheckpoint(true);
    this.emitProgress('downloading');
  }

  private async download(): Promise<void> {
    if (!this.prepared || !this.writer) throw new DownloadError('FTP download not prepared.', 'INTERNAL');
    const segment = this.prepared.segments[0];
    if (!segment) return;
    for (;;) {
      if (this.paused || this.canceled) throw new DownloadError('The download was stopped.', 'ABORTED');
      const offset = segment.downloadedBytes;
      if (this.prepared.totalBytes !== null && offset >= this.prepared.totalBytes) {
        segment.status = 'complete';
        return;
      }
      try {
        await this.fetch(offset);
        if (this.prepared.totalBytes === null || segment.downloadedBytes >= this.prepared.totalBytes) {
          segment.status = 'complete';
          return;
        }
        throw new DownloadError('The FTP connection ended before the file was complete.', 'NETWORK', { retryable: true });
      } catch (error) {
        if (this.paused || this.canceled) throw error;
        const mapped = mapNetworkError(error);
        if (!isRetryableNetworkError(mapped) || this.attempts >= this.config.maxRetries) throw mapped;
        this.attempts++;
        const delay = backoffDelay(this.attempts, this.config.retryBaseDelayMs, mapped.retryAfterMs);
        this.log('warn', `${friendlyErrorMessage(mapped)} Retrying FTP in ${Math.round(delay / 1000)}s.`);
        void this.saveCheckpoint(true);
        await this.sleep(delay);
      }
    }
  }

  private async fetch(offset: number): Promise<void> {
    if (!this.prepared || !this.writer) throw new DownloadError('FTP download not prepared.', 'INTERNAL');
    const parsed = new URL(this.config.url);
    const control = await connectControl(parsed, 20_000, this.controller.signal);
    this.control = control;
    try {
      await control.commandExpect('TYPE I', [200]);
      const pathName = sanitizeCommandArg(normalizeRemotePath(parsed));
      if (offset > 0) {
        if (!this.prepared.resumable) {
          await this.writer.truncate(0);
          offset = 0;
          const segment = this.prepared.segments[0];
          if (segment) segment.downloadedBytes = 0;
          this.prepared.downloadedBytes = 0;
        } else {
          await control.commandExpect(`REST ${offset}`, [350]);
        }
      }
      const dataSocket = await enterPassive(control, parsed.hostname);
      this.dataSocket = dataSocket;
      let expected = this.prepared.totalBytes !== null ? this.prepared.totalBytes - offset : null;
      const retrResponse = await control.command(`RETR ${pathName}`);
      if (retrResponse.code !== 150 && retrResponse.code !== 125) {
        dataSocket.destroy();
        throw new DownloadError(`FTP download failed: ${retrResponse.code} ${retrResponse.message}`, 'NETWORK', {
          retryable: retrResponse.code >= 400
        });
      }
      let received = 0;
      dataSocket.setTimeout(30_000, () => {
        dataSocket.destroy(new DownloadError('The FTP data connection stalled.', 'TIMEOUT', { retryable: true }));
      });
      try {
        for await (const rawChunk of dataSocket) {
          if (this.paused || this.canceled) throw new DownloadError('The download was stopped.', 'ABORTED');
          const buffer = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
          await this.runtime.globalLimiter.consume(buffer.length, this.controller.signal);
          await this.writer.writeAt(offset + received, buffer);
          received += buffer.length;
          const segment = this.prepared.segments[0];
          if (segment) {
            segment.downloadedBytes = offset + received;
            segment.status = 'active';
          }
          this.prepared.downloadedBytes = offset + received;
          this.speedMeter.add(buffer.length);
          this.emitProgress('downloading');
          if (Date.now() - this.lastCheckpointAt >= CHECKPOINT_INTERVAL_MS) void this.saveCheckpoint(false);
        }
      } finally {
        dataSocket.destroy();
        this.dataSocket = null;
      }
      if (expected !== null && received < expected) {
        throw new DownloadError('The FTP transfer ended early.', 'NETWORK', { retryable: true });
      }
      const completion = await control.readResponse().catch(() => null);
      if (completion && completion.code >= 400) {
        throw new DownloadError(`FTP server reported an error: ${completion.code} ${completion.message}`, 'NETWORK', {
          retryable: completion.code >= 400
        });
      }
      if (this.prepared.totalBytes === null) {
        this.prepared.totalBytes = offset + received;
        expected = received;
      }
    } finally {
      this.control = null;
      await control.close();
    }
  }

  private async finalize(): Promise<EngineOutcome> {
    if (!this.prepared || !this.writer) throw new DownloadError('FTP download not prepared.', 'INTERNAL');
    const downloaded = this.prepared.downloadedBytes;
    const total = this.prepared.totalBytes ?? downloaded;
    await this.writer.flush();
    await this.writer.truncate(total);
    await this.writer.close();
    this.writer = null;
    const stat = await fsp.stat(this.prepared.tempPath);
    if (stat.size !== total) throw new DownloadError('The FTP download size is incorrect.', 'SIZE_MISMATCH');
    let checksumStatus: ChecksumStatus = 'none';
    if (this.config.checksum && this.config.checksumAlgorithm) {
      const actual = await hashFile(this.prepared.tempPath, this.config.checksumAlgorithm);
      if (actual.toLowerCase() !== this.config.checksum.trim().toLowerCase()) {
        throw new DownloadError('Checksum mismatch.', 'CHECKSUM_MISMATCH');
      }
      checksumStatus = 'verified';
    }
    this.emitProgress('finalizing');
    const finalPath = await resolveTargetPath(
      this.prepared.destinationDir,
      this.prepared.fileName,
      this.config.conflictPolicy,
      reservedPathsExcept(this.reservedSet(), this.prepared.targetPath)
    );
    const placed = await atomicPlace(
      this.prepared.tempPath,
      finalPath,
      this.config.conflictPolicy === 'overwrite',
      { sourceUrl: this.config.url, referrer: this.config.referrer }
    );
    this.prepared.targetPath = placed;
    this.prepared.downloadedBytes = total;
    this.prepared.totalBytes = total;
    return {
      status: 'completed',
      result: {
        fileName: path.basename(placed),
        targetPath: placed,
        finalUrl: this.prepared.finalUrl,
        totalBytes: total,
        downloadedBytes: total,
        checksumStatus,
        segments: this.prepared.segments.map((segment) => ({ ...segment })),
        mimeType: 'application/octet-stream'
      }
    };
  }

  private pausedOutcome(): EngineOutcome {
    if (!this.prepared) return { status: 'paused', checkpoint: null };
    return {
      status: 'paused',
      checkpoint: {
        prepared: { ...this.prepared, segments: this.prepared.segments.map((segment) => ({ ...segment })) },
        status: 'paused',
        downloadedBytes: this.prepared.downloadedBytes,
        totalBytes: this.prepared.totalBytes,
        attempts: this.attempts
      }
    };
  }

  private async cleanupTemp(): Promise<void> {
    await this.closeWriter();
    const temp = this.prepared?.tempPath ?? this.config.resume?.tempPath;
    if (temp) await fsp.rm(temp, { force: true }).catch(() => undefined);
  }

  private async closeWriter(): Promise<void> {
    if (!this.writer) return;
    const writer = this.writer;
    this.writer = null;
    await writer.close().catch(() => undefined);
  }

  private async closeControl(): Promise<void> {
    const control = this.control;
    this.control = null;
    await control?.close();
  }

  private emitProgress(status: 'connecting' | 'downloading' | 'verifying' | 'finalizing'): void {
    if (!this.prepared) return;
    const now = Date.now();
    if (status === 'downloading' && now - this.lastProgressAt < PROGRESS_INTERVAL_MS) return;
    this.lastProgressAt = now;
    const speed = status === 'downloading' ? this.speedMeter.speed() : 0;
    const total = this.prepared.totalBytes;
    const downloaded = this.prepared.downloadedBytes;
    this.callbacks.onProgress({
      status,
      downloadedBytes: downloaded,
      totalBytes: total,
      speedBps: Math.round(speed),
      etaSeconds: speed > 0 && total !== null ? Math.max(0, (total - downloaded) / speed) : null,
      segments: this.prepared.segments.map((segment) => ({ ...segment })),
      attempts: this.attempts
    });
  }

  private saveCheckpoint(force: boolean): Promise<void> {
    if (!this.prepared) return this.checkpointChain;
    const now = Date.now();
    if (!force && now - this.lastCheckpointAt < CHECKPOINT_INTERVAL_MS) return this.checkpointChain;
    this.lastCheckpointAt = now;
    const checkpoint: EngineCheckpoint = {
      prepared: { ...this.prepared, segments: this.prepared.segments.map((segment) => ({ ...segment })) },
      status: 'downloading',
      downloadedBytes: this.prepared.downloadedBytes,
      totalBytes: this.prepared.totalBytes,
      attempts: this.attempts,
      progressOnly: !force
    };
    this.checkpointChain = this.checkpointChain
      .then(() => this.callbacks.onCheckpoint(checkpoint))
      .catch((error) => this.log('warn', `Could not persist FTP progress: ${(error as Error).message}`));
    return this.checkpointChain;
  }

  private async sleep(ms: number): Promise<void> {
    if (this.runtime.sleep) {
      await this.runtime.sleep(ms, this.controller.signal);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controller.signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DownloadError('The download was stopped.', 'ABORTED'));
      };
      this.controller.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private reservedSet(): Set<string> {
    return this.runtime.reservedTargetPaths ?? new Set<string>();
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.runtime.logger(level, message, { downloadId: this.config.id });
    try {
      this.callbacks.onLog(level, message);
    } catch {
      // Ignore logging errors.
    }
  }
}


