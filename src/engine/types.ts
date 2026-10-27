import type {
  ChecksumAlgorithm,
  ChecksumStatus,
  DownloadKind,
  DownloadSegment,
  DownloadStatus,
  MediaFormat
} from '../shared/types';
import type { HttpClient } from './http-client';
import type { DiskSpaceProbe } from './fs-utils';
import type { HostLimiter, TokenBucket } from './rate-limiter';

export interface EngineLogger {
  (level: 'debug' | 'info' | 'warn' | 'error', message: string, detail?: unknown): void;
}

export interface EngineRuntime {
  http: HttpClient;
  hostLimiter: HostLimiter;
  globalLimiter: TokenBucket;
  logger: EngineLogger;
  diskSpaceProbe?: DiskSpaceProbe;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  reservedTargetPaths?: Set<string>;
  resolveDirectory?: (fileName: string, mimeType: string) => Promise<string>;
  maxConnectionsPerHost?: number;
  ytDlpPath?: string;
  ffmpegPath?: string;
  jsRuntimePath?: string;
}

export interface ResumeState {
  tempPath: string;
  targetPath: string;
  fileName: string;
  finalUrl: string;
  totalBytes: number | null;
  downloadedBytes: number;
  resumable: boolean;
  etag: string;
  lastModified: string;
  mimeType: string;
  segments: DownloadSegment[];
  mediaState?: string;
}

export interface DownloadConfig {
  id: string;
  kind: DownloadKind;
  url: string;
  destinationDir: string;
  fileName?: string;
  fileNameExplicit?: boolean;
  headers: Record<string, string>;
  cookies: string;
  referrer: string;
  connections: number;
  speedLimitBps: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  checksum: string;
  checksumAlgorithm: ChecksumAlgorithm | '';
  conflictPolicy: 'rename' | 'overwrite' | 'skip';
  tlsAllowInsecure: boolean;
  resume?: ResumeState;
  mediaFormat?: MediaFormat;
  sourcePageUrl: string;
}

export interface PreparedDownload {
  finalUrl: string;
  fileName: string;
  destinationDir: string;
  targetPath: string;
  tempPath: string;
  totalBytes: number | null;
  downloadedBytes: number;
  resumable: boolean;
  etag: string;
  lastModified: string;
  mimeType: string;
  segments: DownloadSegment[];
  kind: DownloadKind;
  mediaState?: string;
}

export interface ProgressState {
  status: DownloadStatus;
  downloadedBytes: number;
  totalBytes: number | null;
  speedBps: number;
  etaSeconds: number | null;
  segments: DownloadSegment[];
  attempts: number;
  checksumStatus?: ChecksumStatus;
}

export interface EngineCheckpoint {
  prepared: PreparedDownload;
  status: DownloadStatus;
  downloadedBytes: number;
  totalBytes: number | null;
  attempts: number;
  error?: string;
  errorCode?: string;
  checksumStatus?: ChecksumStatus;
  mediaState?: string;
  /**
   * True when only byte counters and segment haven't structurally changed.
   * The manager may then skip rewriting immutable download columns.
   */
  progressOnly?: boolean;
}

export interface CompletedDownload {
  fileName: string;
  targetPath: string;
  finalUrl: string;
  totalBytes: number;
  downloadedBytes: number;
  checksumStatus: ChecksumStatus;
  segments: DownloadSegment[];
  mimeType: string;
  mediaState?: string;
}

export type EngineOutcome =
  | { status: 'completed'; result: CompletedDownload }
  | { status: 'paused'; checkpoint: EngineCheckpoint | null }
  | { status: 'canceled' };

export interface EngineCallbacks {
  onPrepared(prepared: PreparedDownload, definitions: string[]): Promise<void> | void;
  onProgress(progress: ProgressState): void;
  onCheckpoint(checkpoint: EngineCheckpoint): Promise<void> | void;
  onLog(level: 'info' | 'warn' | 'error', message: string): void;
}

export interface HttpProbeResult {
  finalUrl: string;
  statusCode: number;
  totalBytes: number | null;
  resumable: boolean;
  etag: string;
  lastModified: string;
  mimeType: string;
  contentDisposition: string;
  fileName: string;
  acceptRanges: string;
}
