import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import type { DownloadSegment, ChecksumAlgorithm, ChecksumStatus } from '../shared/types';
import {
  deriveFileNameFromUrl,
  ensureExtension,
  extensionFromMime,
  parseContentDisposition,
  redactUrl,
  sanitizeFileName
} from '../shared/validation';
import {
  CHECKPOINT_INTERVAL_MS,
  MIN_SEGMENT_SIZE,
  PROGRESS_INTERVAL_MS,
  RESUME_SAFETY_MARGIN_BYTES,
  SEGMENT_SPLIT_THRESHOLD,
  SEGMENT_WRITE_HIGH_WATER
} from '../shared/defaults';
import {
  DownloadError,
  RangeUnsupportedError,
  friendlyErrorMessage,
  isRetryableNetworkError,
  mapNetworkError
} from './errors';
import {
  contentLength,
  httpStatusError,
  parseContentRange,
  CookieJar as CookieJarClass,
  type CookieJar,
  type HttpResponse
} from './http-client';
import {
  atomicPlace,
  checkDiskSpace,
  fileExists,
  resolveTargetPath,
  reservedPathsExcept,
  SparseFileWriter,
  tempFilePath
} from './fs-utils';
import { backoffDelay, SpeedMeter, TokenBucket } from './rate-limiter';

function retryLimitFor(error: DownloadError, maxRetries: number): number {
  return error.code === 'TLS_CHAIN' ? Math.max(0, Math.min(1, maxRetries)) : maxRetries;
}
import { hashFile } from './checksum';
import type {
  CompletedDownload,
  DownloadConfig,
  EngineCallbacks,
  EngineCheckpoint,
  EngineOutcome,
  EngineRuntime,
  HttpProbeResult,
  PreparedDownload,
  ProgressState,
  ResumeState
} from './types';

export interface ResolvedResume {
  resume: ResumeState | null;
  reused: boolean;
}

export class HttpDownloadTask {
  private readonly config: DownloadConfig;
  private readonly runtime: EngineRuntime;
  private readonly callbacks: EngineCallbacks;
  private readonly controller = new AbortController();
  private readonly downloadLimiter: TokenBucket;
  private readonly speedMeter = new SpeedMeter();
  private readonly cookieJar: CookieJar;
  private paused = false;
  private canceled = false;
  private attempts = 0;
  private prepared: PreparedDownload | null = null;
  private writer: SparseFileWriter | null = null;
  private lastProgressAt = 0;
  private lastCheckpointAt = 0;
  private checkpointChain: Promise<void> = Promise.resolve();
  private rangeFallback = false;
  private downloadedTotal = 0;
  private compressedDownload = false;
  private readonly claimed = new Set<number>();
  private nextSegmentIndex = 0;

  constructor(config: DownloadConfig, runtime: EngineRuntime, callbacks: EngineCallbacks) {
    this.config = config;
    this.runtime = runtime;
    this.callbacks = callbacks;
    this.downloadLimiter = new TokenBucket(config.speedLimitBps);
    this.cookieJar = new CookieJarClass();
  }

  pause(): void {
    if (this.canceled || this.paused) return;
    this.paused = true;
    this.controller.abort();
  }

  cancel(): void {
    if (this.canceled) return;
    this.canceled = true;
    this.controller.abort();
  }

  async run(): Promise<EngineOutcome> {
    try {
      const probe = await this.probe();
      if (this.paused) return this.pausedOutcome();
      if (this.canceled) return this.canceledOutcome();
      await this.prepare(probe);
      this.emitProgress('connecting');
      await this.downloadAll();
      if (this.paused) return this.pausedOutcome();
      if (this.canceled) return this.canceledOutcome();
      return await this.finalize();
    } catch (error) {
      if (this.canceled) {
        await this.cleanupTemp();
        return { status: 'canceled' };
      }
      if (this.paused) {
        return this.pausedOutcome();
      }
      throw error;
    } finally {
      await this.closeWriter();
    }
  }

  private async probeRequest(headers: Record<string, string>): Promise<HttpResponse> {
    let attempts = 0;
    for (;;) {
      try {
        return await this.runtime.http.request(this.config.url, {
          headers,
          signal: this.controller.signal,
          cookieJar: this.cookieJar,
          method: 'GET'
        });
      } catch (error) {
        const mapped = mapNetworkError(error);
        const retryLimit = retryLimitFor(mapped, this.config.maxRetries);
        if (!isRetryableNetworkError(mapped) || attempts >= retryLimit) throw mapped;
        attempts += 1;
        this.attempts = Math.max(this.attempts, attempts);
        const delay = backoffDelay(attempts, this.config.retryBaseDelayMs, mapped.retryAfterMs);
        this.log('warn', `${friendlyErrorMessage(mapped)} Retrying in ${Math.round(delay / 1000)}s (${attempts}/${retryLimit}).`);
        await sleepWithSignal(delay, this.controller.signal, this.runtime.sleep);
      }
    }
  }

  private async probe(): Promise<HttpProbeResult> {
    this.log('info', `Probing ${redactUrl(this.config.url)}`);
    const headers: Record<string, string> = { ...this.config.headers, Range: 'bytes=0-0' };
    if (this.config.cookies) headers.Cookie = this.config.cookies;
    if (this.config.referrer) headers.Referer = this.config.referrer;
    let response = await this.probeRequest(headers);
    // Some signed CDN URLs reject Range requests during negotiation. A plain
    // GET still reveals the size and content type, even if it is not resumable.
    if ([400, 403, 405, 501].includes(response.status)) {
      response.close();
      this.log('warn', 'The server rejected the range probe; retrying without a Range header.');
      delete headers.Range;
      response = await this.probeRequest(headers);
    }
    try {
      const status = response.status;
      if (status !== 200 && status !== 206 && status !== 416) {
        throw httpStatusError(status, response.headers, response.url);
      }
      const contentType = headerString(response.headers['content-type']);
      const disposition = headerString(response.headers['content-disposition']);
      const etag = headerString(response.headers.etag);
      const lastModified = headerString(response.headers['last-modified']);
      const acceptRanges = headerString(response.headers['accept-ranges']);
      let totalBytes: number | null = null;
      let resumable = false;
      if (status === 206) {
        const range = parseContentRange(headerString(response.headers['content-range']));
        totalBytes = range.total;
        resumable = totalBytes !== null;
      } else if (status === 416) {
        const range = parseContentRange(headerString(response.headers['content-range']));
        if (range.total !== null) {
          totalBytes = range.total;
          resumable = true;
        } else {
          throw httpStatusError(status, response.headers, response.url);
        }
      } else {
        totalBytes = contentLength(response.headers);
        resumable = false;
      }

      const parsedDisposition = parseContentDisposition(disposition);
      let fileName = parsedDisposition.fileName;
      if (!fileName) fileName = deriveFileNameFromUrl(response.url, 'download');
      const mimeType = contentType || 'application/octet-stream';

      if (
        !parsedDisposition.isAttachment &&
        !parsedDisposition.fileName &&
        /^text\/html/i.test(mimeType) &&
        !/\.html?$/i.test(new URL(response.url).pathname)
      ) {
        throw new DownloadError(
          'The server returned a web page instead of a file. The link may have expired or require a browser session.',
          'HTTP_ERROR',
          { statusCode: status }
        );
      }

      return {
        finalUrl: response.url,
        statusCode: status,
        totalBytes,
        resumable,
        etag,
        lastModified,
        mimeType,
        contentDisposition: disposition,
        fileName,
        acceptRanges
      };
    } finally {
      const drained = await drainResponse(response, this.controller.signal);
      if (!drained) response.close();
    }
  }

  private async prepare(probe: HttpProbeResult): Promise<void> {
    const previous = this.config.resume;
    let fileName = this.resolveFileName(probe);
    let destinationDir = this.config.destinationDir;
    if (this.runtime.resolveDirectory) {
      destinationDir = await this.runtime.resolveDirectory(fileName, probe.mimeType);
    } else {
      destinationDir = path.resolve(destinationDir);
    }
    await fsp.mkdir(destinationDir, { recursive: true });

    const reusable = await this.canReuseResume(previous, destinationDir, probe);
    let targetPath: string;
    let tempPath: string;
    let segments: DownloadSegment[];
    let resumable = probe.resumable && probe.totalBytes !== null;

    if (reusable && previous) {
      fileName = this.config.fileNameExplicit && this.config.fileName ? sanitizeFileName(this.config.fileName) : previous.fileName || fileName;
      const previousTargetInside = path.dirname(path.resolve(previous.targetPath)) === path.resolve(destinationDir);
      targetPath = previousTargetInside
        ? await resolveTargetPath(destinationDir, path.basename(previous.targetPath), 'rename', this.reservedSet())
        : await resolveTargetPath(destinationDir, fileName, this.config.conflictPolicy, this.reservedSet());
      tempPath = previous.tempPath;
      segments = this.normalizeSegments(previous.segments, previous.totalBytes ?? probe.totalBytes);
      resumable = previous.resumable && probe.resumable;
      if (!probe.resumable) {
        segments = this.planSegments(probe.totalBytes, 1, false);
        resumable = false;
        await this.truncateTemp(tempPath);
      } else {
        // Buffered writes can outlive a checkpoint by up to one write batch;
        // re-download a safety margin instead of trusting bytes that may never
        // have reached the disk before a crash.
        for (const segment of segments) {
          if (segment.downloadedBytes > RESUME_SAFETY_MARGIN_BYTES) segment.downloadedBytes -= RESUME_SAFETY_MARGIN_BYTES;
          else segment.downloadedBytes = 0;
          segment.status = segment.downloadedBytes > 0 ? 'active' : 'pending';
        }
      }
    } else {
      if (previous?.tempPath) {
        const oldTemp = previous.tempPath;
        if (path.dirname(path.resolve(oldTemp)) === path.resolve(destinationDir) && !reusable) {
          await fsp.rm(oldTemp, { force: true }).catch(() => undefined);
        }
      }
      tempPath = tempFilePath(destinationDir, this.config.id);
      segments = this.planSegments(probe.totalBytes, this.config.connections, resumable);
      if (!resumable && probe.totalBytes !== null) {
        segments = this.planSegments(probe.totalBytes, 1, false);
      }
      if (probe.totalBytes !== null) await this.truncateTemp(tempPath);
      targetPath = await resolveTargetPath(
        destinationDir,
        fileName,
        this.config.conflictPolicy,
        this.reservedSet()
      );
    }

    await checkDiskSpace(destinationDir, probe.totalBytes, this.runtime.diskSpaceProbe);
    const downloadedBytes = segments.reduce((sum, segment) => sum + segment.downloadedBytes, 0);

    this.prepared = {
      finalUrl: probe.finalUrl,
      fileName,
      destinationDir,
      targetPath,
      tempPath,
      totalBytes: probe.totalBytes,
      downloadedBytes,
      resumable,
      etag: probe.etag,
      lastModified: probe.lastModified,
      mimeType: probe.mimeType,
      segments,
      kind: 'http'
    };

    this.writer = new SparseFileWriter(tempPath);
    await this.writer.open(probe.totalBytes);
    this.downloadedTotal = downloadedBytes;
    this.compressedDownload = false;
    await this.callbacks.onPrepared(this.prepared, [this.config.url]);
    await this.saveCheckpoint(true);
    this.emitProgress('downloading');
  }

  private resolveFileName(probe: HttpProbeResult): string {
    let fileName: string;
    if (this.config.fileName && this.config.fileNameExplicit) {
      fileName = this.config.fileName;
    } else if (probe.fileName) {
      fileName = probe.fileName;
    } else if (this.config.fileName) {
      fileName = this.config.fileName;
    } else {
      fileName = deriveFileNameFromUrl(probe.finalUrl, 'download');
    }
    fileName = sanitizeFileName(fileName);
    const mime = probe.mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
    const mimeExt = extensionFromMime(mime);
    if (!path.extname(fileName) && mimeExt && mime !== 'application/octet-stream' && mime !== 'text/html') {
      fileName = ensureExtension(fileName, mime, '');
    }
    if (fileName.length > 200) {
      const ext = path.extname(fileName);
      fileName = `${fileName.slice(0, 200 - ext.length)}${ext}`;
    }
    return fileName;
  }

  private async canReuseResume(
    resume: ResumeState | undefined,
    destinationDir: string,
    probe: HttpProbeResult
  ): Promise<boolean> {
    if (!resume || !resume.tempPath || resume.segments.length === 0) return false;
    const tempDir = path.dirname(path.resolve(resume.tempPath));
    if (tempDir !== path.resolve(destinationDir)) return false;
    if (!(await fileExists(resume.tempPath))) return false;
    if (probe.totalBytes === null || resume.totalBytes === null) return false;
    if (probe.totalBytes !== resume.totalBytes) {
      this.log('warn', 'The remote size changed; restarting the download.');
      return false;
    }
    const etagMatches = !probe.etag || !resume.etag || normalizeEtag(probe.etag) === normalizeEtag(resume.etag);
    if (!etagMatches) {
      const modifiedMatches = probe.lastModified && resume.lastModified && probe.lastModified === resume.lastModified;
      if (!modifiedMatches) {
        this.log('warn', 'The remote file changed (ETag and date differ); restarting the download.');
        return false;
      }
      // Weak ETags can legitimately differ across mirrors; identical size and
      // Last-Date is enough to trust the resume.
    }
    if (probe.lastModified && resume.lastModified && probe.lastModified !== resume.lastModified) {
      this.log('warn', 'The remote modification date changed; restarting the download.');
      return false;
    }
    if (!probe.resumable) {
      this.log('warn', 'The server no longer supports range requests; restarting the download.');
      return false;
    }
    const normalized = this.normalizeSegments(resume.segments, resume.totalBytes);
    if (normalized.length === 0) return false;
    const last = normalized[normalized.length - 1];
    if (!last || last.endByte === null || last.endByte !== resume.totalBytes - 1) return false;
    return true;
  }

  private normalizeSegments(segments: DownloadSegment[], totalBytes: number | null): DownloadSegment[] {
    if (!segments.length || totalBytes === null) return [];
    const result = segments.map((segment) => {
      const maxLength = segment.endByte === null ? Infinity : segment.endByte - segment.startByte + 1;
      const downloaded = Math.max(0, Math.min(segment.downloadedBytes, maxLength === Infinity ? segment.downloadedBytes : maxLength));
      return {
        ...segment,
        downloadedBytes: downloaded,
        status: downloaded >= maxLength ? ('complete' as const) : downloaded > 0 ? ('active' as const) : ('pending' as const)
      };
    });
    return result;
  }

  private planSegments(totalBytes: number | null, connections: number, resumable: boolean): DownloadSegment[] {
    if (totalBytes === 0) return [];
    if (totalBytes === null || !resumable) {
      return [{ index: 0, startByte: 0, endByte: totalBytes !== null ? totalBytes - 1 : null, downloadedBytes: 0, status: 'pending' }];
    }
    const maxUseful = Math.max(1, Math.floor(totalBytes / MIN_SEGMENT_SIZE));
    const count = Math.max(1, Math.min(Math.floor(connections), maxUseful));
    if (count === 1) {
      return [{ index: 0, startByte: 0, endByte: totalBytes - 1, downloadedBytes: 0, status: 'pending' }];
    }
    const chunk = Math.ceil(totalBytes / count);
    const segments: DownloadSegment[] = [];
    for (let index = 0; index < count; index++) {
      const start = index * chunk;
      const end = Math.min(totalBytes - 1, start + chunk - 1);
      if (start > end) break;
      segments.push({ index, startByte: start, endByte: end, downloadedBytes: 0, status: 'pending' });
    }
    return segments;
  }

  private async downloadAll(): Promise<void> {
    if (!this.prepared) throw new DownloadError('Download not prepared.', 'INTERNAL');
    if (!this.prepared.segments.length) return;

    this.emitProgress('downloading');
    for (;;) {
      this.nextSegmentIndex = this.prepared.segments.reduce((max, segment) => Math.max(max, segment.index + 1), 0);
      this.claimed.clear();
      const workerCount = Math.max(1, this.config.connections);
      const workers: Promise<void>[] = [];
      for (let index = 0; index < workerCount; index += 1) {
        workers.push(this.downloadWorker());
      }
      const results = await Promise.allSettled(workers);
      if (this.rangeFallback && !this.paused && !this.canceled) {
        this.rangeFallback = false;
        this.log('warn', 'The server ignored range requests; restarting with a single connection.');
        await this.resetToSequential();
        continue;
      }
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure) throw failure.reason;
      if (this.prepared.segments.every((segment) => segment.status === 'complete')) return;
      throw new DownloadError('The download finished with incomplete segments.', 'INTERNAL');
    }
  }

  /**
   * Worker-pool download: each worker claims the next unfinished segment and,
   * when none is left, splits the largest in-progress segment and steals its
   * tail. Fast connections therefore never idle while a slow one grinds on.
   */
  private async downloadWorker(): Promise<void> {
    for (;;) {
      if (this.paused || this.canceled) throw new DownloadError('The download was stopped.', 'ABORTED');
      const segment = this.claimSegment();
      if (!segment) {
        const stolen = this.splitLargestSegment();
        if (!stolen) return;
        try {
          await this.downloadSegment(stolen);
        } finally {
          this.claimed.delete(stolen.index);
        }
        continue;
      }
      try {
        await this.downloadSegment(segment);
      } finally {
        this.claimed.delete(segment.index);
      }
    }
  }

  private claimSegment(): DownloadSegment | null {
    if (!this.prepared) return null;
    for (const segment of this.prepared.segments) {
      if (segment.status !== 'complete' && !this.claimed.has(segment.index)) {
        this.claimed.add(segment.index);
        return segment;
      }
    }
    return null;
  }

  private splitLargestSegment(): DownloadSegment | null {
    if (!this.prepared) return null;
    let largest: DownloadSegment | null = null;
    let largestRemaining = 0;
    for (const segment of this.prepared.segments) {
      if (segment.status === 'complete' || !this.claimed.has(segment.index)) continue;
      const remaining = segment.endByte === null ? 0 : segment.endByte - segment.startByte + 1 - segment.downloadedBytes;
      if (remaining > largestRemaining) {
        largestRemaining = remaining;
        largest = segment;
      }
    }
    if (!largest || largest.endByte === null || largestRemaining < SEGMENT_SPLIT_THRESHOLD) return null;
    const mid = largest.startByte + largest.downloadedBytes + Math.floor(largestRemaining / 2);
    const stolen: DownloadSegment = {
      index: this.nextSegmentIndex++,
      startByte: mid + 1,
      endByte: largest.endByte,
      downloadedBytes: 0,
      status: 'pending'
    };
    largest.endByte = mid;
    this.prepared.segments.push(stolen);
    this.claimed.add(stolen.index);
    this.log('info', 'Reassigned part of a slow segment to an idle connection.');
    void this.saveCheckpoint(true);
    return stolen;
  }

  private async resetToSequential(): Promise<void> {
    if (!this.prepared || !this.writer) return;
    for (const segment of this.prepared.segments) {
      segment.downloadedBytes = 0;
      segment.status = 'pending';
    }
    this.prepared.segments = this.planSegments(this.prepared.totalBytes, 1, false);
    this.prepared.resumable = false;
    this.prepared.downloadedBytes = 0;
    this.downloadedTotal = 0;
    await this.writer.truncate(0);
    await this.saveCheckpoint(true);
    this.emitProgress('downloading');
  }

  private async downloadSegment(segment: DownloadSegment): Promise<void> {
    let attempts = 0;
    for (;;) {
      if (this.paused || this.canceled) throw new DownloadError('The download was stopped.', 'ABORTED');
      const length = segment.endByte === null ? null : segment.endByte - segment.startByte + 1;
      if (length !== null && segment.downloadedBytes >= length) {
        segment.status = 'complete';
        return;
      }
      try {
        await this.fetchSegment(segment);
        if (length === null) {
          segment.status = 'complete';
          return;
        }
        if (segment.downloadedBytes >= length) {
          segment.status = 'complete';
          return;
        }
        throw new DownloadError('The connection ended before the download completed.', 'NETWORK', { retryable: true });
      } catch (error) {
        if (this.paused || this.canceled) throw error;
        if (error instanceof RangeUnsupportedError) {
          this.rangeFallback = true;
          throw error;
        }
        const mapped = mapNetworkError(error);
        // Retry budget is per segment: one flaky range must not consume the
        // whole download's allowance.
        const retryLimit = retryLimitFor(mapped, this.config.maxRetries);
        if (!isRetryableNetworkError(mapped) || attempts >= retryLimit) {
          throw mapped;
        }
        attempts += 1;
        this.attempts = Math.max(this.attempts, attempts);
        const delay = backoffDelay(attempts, this.config.retryBaseDelayMs, mapped.retryAfterMs);
        this.log('warn', `${friendlyErrorMessage(mapped)} Retrying in ${Math.round(delay / 1000)}s (${attempts}/${retryLimit}).`);
        this.emitProgress('downloading');
        void this.saveCheckpoint(true);
        await sleepWithSignal(delay, this.controller.signal, this.runtime.sleep);
      }
    }
  }

  private async fetchSegment(segment: DownloadSegment): Promise<void> {
    if (!this.prepared || !this.writer) throw new DownloadError('Download not prepared.', 'INTERNAL');
    const start = segment.startByte + segment.downloadedBytes;
    const end = segment.endByte;
    if (end !== null && start > end) {
      segment.status = 'complete';
      return;
    }
    const headers: Record<string, string> = { ...this.config.headers };
    const wholeFileRequest = !this.prepared.resumable && start === 0 && segment.downloadedBytes === 0;
    if (!wholeFileRequest) {
      headers.Range = `bytes=${start}-${end === null ? '' : end}`;
      if (start > 0 && (this.prepared.etag || this.prepared.lastModified)) {
        headers['If-Range'] = this.prepared.etag || this.prepared.lastModified;
      }
    }
    if (this.config.cookies) headers.Cookie = this.config.cookies;
    if (this.config.referrer) headers.Referer = this.config.referrer;

    let releaseHost: (() => void) | null = null;
    let response: HttpResponse | undefined;
    try {
      const hostname = new URL(this.prepared.finalUrl).hostname;
      releaseHost = await this.runtime.hostLimiter.acquire(hostname, this.controller.signal);
      response = await this.runtime.http.request(this.prepared.finalUrl, {
        headers,
        signal: this.controller.signal,
        cookieJar: this.cookieJar
      });
      if (this.paused || this.canceled) throw new DownloadError('The download was stopped.', 'ABORTED');
      const status = response.status;
      const contentEncoding = headerString(response.headers['content-encoding']).toLowerCase();
      let stream: import('node:stream').Readable = response.stream;
      if (contentEncoding && contentEncoding !== 'identity') {
        if (start > 0 || this.prepared.segments.length > 1 || this.prepared.resumable) {
          throw new RangeUnsupportedError();
        }
        // Some CDNs compress regardless of Accept-Encoding: identity. A plain
        // single-stream download can still proceed with an explicit decoder.
        const decoder = createBodyDecoder(contentEncoding);
        if (!decoder) {
          throw new DownloadError('The server sent a compressed response MDM cannot decode.', 'HTTP_ERROR', {
            statusCode: status
          });
        }
        stream = response.stream.pipe(decoder);
        this.compressedDownload = true;
      }

      if (status === 416) {
        if (this.prepared.totalBytes !== null && start >= this.prepared.totalBytes) {
          segment.downloadedBytes = end !== null ? end - segment.startByte + 1 : segment.downloadedBytes;
          response.close();
          return;
        }
        throw httpStatusError(status, response.headers, response.url);
      }

      let expectedLength: number | null = null;
      if (status === 206) {
        const range = parseContentRange(headerString(response.headers['content-range']));
        if (range.start === null || range.start !== start) {
          throw new DownloadError('The server returned an unexpected byte range.', 'CONTENT_CHANGED');
        }
        if (this.prepared.totalBytes !== null && range.total !== null && range.total !== this.prepared.totalBytes) {
          throw new DownloadError('The file changed on the server.', 'CONTENT_CHANGED');
        }
        expectedLength = range.end !== null ? range.end - range.start + 1 : null;
        if (end !== null && range.end !== null && range.end !== end) {
          expectedLength = Math.min(expectedLength ?? Infinity, end - start + 1);
        }
      } else if (status === 200) {
        if (start > 0 || this.prepared.segments.length > 1) {
          throw new RangeUnsupportedError();
        }
        expectedLength = this.prepared.totalBytes !== null ? this.prepared.totalBytes : contentLength(response.headers);
      } else {
        throw httpStatusError(status, response.headers, response.url);
      }
      if (this.compressedDownload) {
        // The reported lengths describe the compressed body; the decoded size
        // is only known once the transfer finishes.
        expectedLength = null;
      }

      const absolutePosition = start;
      let received = 0;
      let pending: Buffer[] = [];
      let pendingBytes = 0;
      let pendingOffset = absolutePosition;
      const flushPending = async (force = false) => {
        if (!pendingBytes || (!force && pendingBytes < SEGMENT_WRITE_HIGH_WATER)) return;
        if (!this.writer) throw new DownloadError('Download not prepared.', 'INTERNAL');
        try {
          await this.writer.writeAt(pendingOffset, pendingBytes === 1 && pending[0] ? pending[0] : Buffer.concat(pending));
        } catch (error) {
          throw mapNetworkError(error);
        }
        pending = [];
        pendingOffset += pendingBytes;
        pendingBytes = 0;
      };
      for await (const rawChunk of stream) {
        if (this.paused || this.canceled) throw new DownloadError('The download was stopped.', 'ABORTED');
        let buffer = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
        // The segment's end may have been reassigned to an idle connection
        // mid-transfer; never write past it.
        const capLength = segment.endByte === null ? Number.POSITIVE_INFINITY : segment.endByte - segment.startByte + 1;
        const allowed = capLength - segment.downloadedBytes;
        if (allowed <= 0) break;
        if (buffer.length > allowed) {
          buffer = buffer.subarray(0, allowed);
        }
        if (!buffer.length) break;
        if (this.runtime.globalLimiter.getRate() > 0) {
          await this.runtime.globalLimiter.consume(buffer.length, this.controller.signal);
        }
        if (this.downloadLimiter.getRate() > 0) {
          await this.downloadLimiter.consume(buffer.length, this.controller.signal);
        }
        if (this.paused || this.canceled) throw new DownloadError('The download was stopped.', 'ABORTED');
        pending.push(buffer);
        pendingBytes += buffer.length;
        received += buffer.length;
        segment.downloadedBytes += buffer.length;
        segment.status = 'active';
        this.downloadedTotal += buffer.length;
        this.prepared.downloadedBytes = this.downloadedTotal;
        this.speedMeter.add(buffer.length);
        this.emitProgress('downloading');
        if (Date.now() - this.lastCheckpointAt >= CHECKPOINT_INTERVAL_MS) {
          void this.saveCheckpoint(false);
        }
        await flushPending();
      }
      await flushPending(true);

      if (end !== null && !this.compressedDownload) {
        // The end may have shrunk mid-transfer when a connection stole the
        // tail; only data still owned by this segment is required.
        const currentEnd = segment.endByte;
        const remaining = currentEnd === null ? 0 : currentEnd - start - received + 1;
        if (remaining > 0) {
          throw new DownloadError('The connection closed before the byte range was complete.', 'NETWORK', { retryable: true });
        }
      } else if (end === null && !this.compressedDownload && expectedLength !== null && received < expectedLength) {
        throw new DownloadError('The connection closed before the byte range was complete.', 'NETWORK', { retryable: true });
      }
      segment.status = 'complete';
    } finally {
      response?.close();
      releaseHost?.();
    }
  }

  private sumDownloaded(): number {
    return this.downloadedTotal || this.prepared?.segments.reduce((sum, segment) => sum + segment.downloadedBytes, 0) || 0;
  }

  private async finalize(): Promise<EngineOutcome> {
    if (!this.prepared || !this.writer) throw new DownloadError('Download not prepared.', 'INTERNAL');
    const missing = this.prepared.segments.filter((segment) => segment.status !== 'complete');
    if (missing.length) {
      throw new DownloadError('The download finished with incomplete segments.', 'SIZE_MISMATCH');
    }
    const downloaded = this.sumDownloaded();
    const total = this.prepared.totalBytes ?? downloaded;
    if (total < 0) throw new DownloadError('Invalid download size.', 'SIZE_MISMATCH');

    this.emitProgress('verifying');
    // A single fsync before the size fix-up and placement; close() skips its
    // own sync because the data was just synced.
    await this.writer.truncate(total);
    await this.writer.flush();
    await this.writer.close({ skipSync: true });
    this.writer = null;

    const stat = await fsp.stat(this.prepared.tempPath);
    if (this.prepared.totalBytes !== null && stat.size !== this.prepared.totalBytes) {
      throw new DownloadError(
        `Expected ${this.prepared.totalBytes} bytes but the file is ${stat.size} bytes.`,
        'SIZE_MISMATCH'
      );
    }

    let checksumStatus: ChecksumStatus = 'none';
    if (this.config.checksum && this.config.checksumAlgorithm) {
      this.log('info', `Verifying ${this.config.checksumAlgorithm} checksum.`);
      const actual = await hashFile(this.prepared.tempPath, this.config.checksumAlgorithm);
      if (actual.toLowerCase() !== this.config.checksum.trim().toLowerCase()) {
        await this.publishCheckpoint('failed', 'Integrity verification failed.', 'CHECKSUM_MISMATCH', 'mismatch');
        throw new DownloadError(
          `Checksum mismatch. Expected ${this.config.checksum}, got ${actual}.`,
          'CHECKSUM_MISMATCH'
        );
      }
      checksumStatus = 'verified';
    }

    this.emitProgress('finalizing');
    await this.saveCheckpoint(true);
    const finalPath = await resolveTargetPath(
      this.prepared.destinationDir,
      this.prepared.fileName,
      this.config.conflictPolicy,
      reservedPathsExcept(this.reservedSet(), this.prepared.targetPath)
    );
    let placedPath: string;
    try {
      placedPath = await atomicPlace(this.prepared.tempPath, finalPath, this.config.conflictPolicy === 'overwrite');
    } catch (error) {
      throw mapNetworkError(error);
    }
    this.prepared.targetPath = placedPath;
    this.prepared.downloadedBytes = total;
    this.prepared.totalBytes = total;

    const result: CompletedDownload = {
      fileName: path.basename(placedPath),
      targetPath: placedPath,
      finalUrl: this.prepared.finalUrl,
      totalBytes: total,
      downloadedBytes: total,
      checksumStatus,
      segments: cloneSegments(this.prepared.segments),
      mimeType: this.prepared.mimeType
    };
    this.log('info', `Completed ${path.basename(placedPath)}`);
    return { status: 'completed', result };
  }

  private pausedOutcome(): EngineOutcome {
    if (!this.prepared) return { status: 'paused', checkpoint: null };
    this.prepared.downloadedBytes = this.sumDownloaded();
    return {
      status: 'paused',
      checkpoint: {
        prepared: clonePrepared(this.prepared),
        status: 'paused',
        downloadedBytes: this.prepared.downloadedBytes,
        totalBytes: this.prepared.totalBytes,
        attempts: this.attempts
      }
    };
  }

  private canceledOutcome(): EngineOutcome {
    return { status: 'canceled' };
  }

  private async cleanupTemp(): Promise<void> {
    await this.closeWriter();
    if (this.prepared?.tempPath) {
      await fsp.rm(this.prepared.tempPath, { force: true }).catch(() => undefined);
    } else if (this.config.resume?.tempPath) {
      await fsp.rm(this.config.resume.tempPath, { force: true }).catch(() => undefined);
    }
  }

  private async closeWriter(): Promise<void> {
    if (!this.writer) return;
    const writer = this.writer;
    this.writer = null;
    await writer.close().catch(() => undefined);
  }

  private emitProgress(status: ProgressState['status']): void {
    if (!this.prepared) return;
    const now = Date.now();
    if (status === 'downloading' && now - this.lastProgressAt < PROGRESS_INTERVAL_MS) return;
    this.lastProgressAt = now;
    const speed = status === 'downloading' ? this.speedMeter.speed() : 0;
    const downloaded = this.sumDownloaded();
    const total = this.prepared.totalBytes;
    const eta = speed > 0 && total !== null ? Math.max(0, (total - downloaded) / speed) : null;
    this.callbacks.onProgress({
      status,
      downloadedBytes: downloaded,
      totalBytes: total,
      speedBps: Math.round(speed),
      etaSeconds: eta,
      segments: cloneSegments(this.prepared.segments),
      attempts: this.attempts
    });
  }

  private buildCheckpoint(
    status: EngineCheckpoint['status'],
    error?: string,
    errorCode?: string,
    checksumStatus?: ChecksumStatus
  ): EngineCheckpoint | null {
    if (!this.prepared) return null;
    this.prepared.downloadedBytes = this.sumDownloaded();
    return {
      prepared: clonePrepared(this.prepared),
      status,
      downloadedBytes: this.prepared.downloadedBytes,
      totalBytes: this.prepared.totalBytes,
      attempts: this.attempts,
      error,
      errorCode,
      checksumStatus
    };
  }

  private saveCheckpoint(force: boolean, status: EngineCheckpoint['status'] = 'downloading'): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastCheckpointAt < CHECKPOINT_INTERVAL_MS) {
      return this.checkpointChain;
    }
    const checkpoint = this.buildCheckpoint(status);
    if (!checkpoint) return this.checkpointChain;
    this.lastCheckpointAt = now;
    this.checkpointChain = this.checkpointChain
      .then(() => this.callbacks.onCheckpoint(checkpoint))
      .catch((error) => {
        this.log('warn', `Could not persist progress: ${(error as Error).message}`);
      });
    return this.checkpointChain;
  }

  private async publishCheckpoint(
    status: EngineCheckpoint['status'],
    error: string,
    errorCode: string,
    checksumStatus: ChecksumStatus
  ): Promise<void> {
    const checkpoint = this.buildCheckpoint(status, error, errorCode, checksumStatus);
    if (!checkpoint) return;
    try {
      await this.callbacks.onCheckpoint(checkpoint);
    } catch (callbackError) {
      this.log('warn', `Could not persist status: ${(callbackError as Error).message}`);
    }
  }

  private async truncateTemp(tempPath: string): Promise<void> {
    try {
      const handle = await fsp.open(tempPath, 'w');
      await handle.close();
    } catch {
      // The writer will create the file later.
    }
  }

  private reservedSet(): Set<string> {
    return this.runtime.reservedTargetPaths ?? new Set<string>();
  }

  private log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.runtime.logger(level, message, { downloadId: this.config.id });
    if (level !== 'debug') {
      try {
        this.callbacks.onLog(level === 'warn' ? 'warn' : level === 'error' ? 'error' : 'info', message);
      } catch {
        // Logging must never break a download.
      }
    }
  }
}

function createBodyDecoder(contentEncoding: string): import('node:stream').Transform | null {
  const normalized = contentEncoding.trim().toLowerCase();
  if (normalized === 'gzip' || normalized === 'x-gzip') return zlib.createGunzip();
  if (normalized === 'deflate' || normalized === 'x-deflate') return zlib.createInflate();
  if (normalized === 'br') return zlib.createBrotliDecompress();
  return null;
}

function normalizeEtag(etag: string): string {
  return etag.trim().replace(/^W\//i, '');
}

function headerString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

const PROBE_DRAIN_LIMIT = 64 * 1024;

/**
 * Discards an unread probe response body so the underlying keep-alive socket
 * can return to the agent pool cleanly instead of being destroyed mid-body
 * (which sends a TCP reset and can poison the next request on some servers).
 * Returns false when the body had to be cut short and the socket was destroyed.
 */
async function drainResponse(response: HttpResponse, signal: AbortSignal): Promise<boolean> {
  const stream = response.stream;
  return new Promise<boolean>((resolve) => {
    let drained = 0;
    let settled = false;
    const finish = (fully: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!fully) stream.destroy();
      resolve(fully);
    };
    const onData = (chunk: Buffer) => {
      drained += chunk.length;
      if (drained > PROBE_DRAIN_LIMIT || signal.aborted) finish(false);
    };
    const cleanup = () => {
      stream.off('data', onData);
      stream.off('end', finish);
      stream.off('close', finish);
      stream.off('error', finish);
    };
    stream.on('data', onData);
    stream.once('end', () => finish(true));
    stream.once('close', () => finish(false));
    stream.once('error', () => finish(false));
    stream.resume();
  });
}

function cloneSegments(segments: DownloadSegment[]): DownloadSegment[] {
  return segments.map((segment) => ({ ...segment }));
}

function clonePrepared(prepared: PreparedDownload): PreparedDownload {
  return { ...prepared, segments: cloneSegments(prepared.segments) };
}

export async function sleepWithSignal(
  ms: number,
  signal: AbortSignal,
  customSleep?: (ms: number, signal?: AbortSignal) => Promise<void>
): Promise<void> {
  if (signal.aborted) throw new DownloadError('The download was stopped.', 'ABORTED');
  if (customSleep) {
    await customSleep(ms, signal);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DownloadError('The download was stopped.', 'ABORTED'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function validateChecksumAlgorithm(value: string): ChecksumAlgorithm | '' {
  return value === 'sha256' || value === 'sha1' || value === 'md5' ? value : '';
}
