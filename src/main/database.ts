import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AppSettings,
  CategoryRule,
  ChecksumAlgorithm,
  ChecksumStatus,
  DownloadKind,
  DownloadPriority,
  DownloadRecord,
  DownloadSegment,
  DownloadStatus,
  FileCategory,
  LogRecord,
  QueueCompletionAction,
  QueueRecord,
  ScheduleAction,
  ScheduleRecord,
  SiteAction,
  SiteRule
} from '../shared/types';
import { DEFAULT_RULES } from '../shared/defaults';

export interface SecretBox {
  encrypt(value: string): string;
  decrypt(value: string): string;
}

export class PlainTextSecretBox implements SecretBox {
  encrypt(value: string): string {
    return value;
  }
  decrypt(value: string): string {
    return value;
  }
}

interface DownloadRow {
  id: string;
  kind: DownloadKind;
  url: string;
  final_url: string | null;
  file_name: string;
  file_name_explicit: number;
  destination_dir: string;
  destination_explicit: number;
  tls_allow_insecure: number;
  target_path: string | null;
  temp_path: string | null;
  category: FileCategory;
  queue_id: string;
  status: DownloadStatus;
  priority: DownloadPriority;
  total_bytes: number | null;
  downloaded_bytes: number;
  resumable: number;
  connections: number;
  speed_limit: number;
  headers_enc: string;
  cookies_enc: string;
  referrer: string;
  mime_type: string;
  etag: string;
  last_modified: string;
  checksum: string;
  checksum_algorithm: ChecksumAlgorithm | '';
  checksum_status: ChecksumStatus;
  error: string;
  error_code: string;
  retry_count: number;
  max_retries: number;
  speed_bps: number;
  eta_seconds: number | null;
  media_format_json: string;
  media_state_json: string;
  source_page_url: string;
  auto_open: number;
  scheduled_at: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  record_log_json: string;
}

interface SegmentRow {
  download_id: string;
  idx: number;
  start_byte: number;
  end_byte: number | null;
  downloaded_bytes: number;
  status: DownloadSegment['status'];
}

interface QueueRow {
  id: string;
  name: string;
  priority: number;
  max_concurrent: number;
  speed_limit: number;
  status: 'active' | 'paused';
  is_default: number;
  on_complete: QueueCompletionAction;
  created_at: string;
  updated_at: string;
}

interface ScheduleRow {
  id: string;
  name: string;
  queue_id: string | null;
  action: ScheduleAction;
  days: string;
  start_time: string;
  stop_time: string;
  enabled: number;
  last_fired_key: string;
  created_at: string;
  updated_at: string;
}

interface RuleRow {
  id: string;
  name: string;
  enabled: number;
  priority: number;
  match_type: 'extension' | 'mime' | 'host';
  pattern: string;
  category: FileCategory;
  destination_dir: string;
  auto_open: number;
  created_at: string;
  updated_at: string;
}

interface SiteRuleRow {
  id: string;
  name: string;
  pattern: string;
  action: SiteAction;
  file_types: string;
  destination_dir: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface LogRow {
  id: number;
  timestamp: string;
  level: LogRecord['level'];
  scope: string;
  message: string;
  detail: string;
}

export interface DownloadFields {
  kind?: DownloadKind;
  url?: string;
  finalUrl?: string | null;
  fileName?: string;
  fileNameExplicit?: boolean;
  destinationDir?: string;
  destinationExplicit?: boolean;
  targetPath?: string | null;
  tempPath?: string | null;
  category?: FileCategory;
  queueId?: string;
  status?: DownloadStatus;
  priority?: DownloadPriority;
  totalBytes?: number | null;
  downloadedBytes?: number;
  resumable?: boolean;
  connections?: number;
  speedLimitBps?: number;
  headers?: Record<string, string>;
  cookies?: string;
  referrer?: string;
  mimeType?: string;
  etag?: string;
  lastModified?: string;
  checksum?: string;
  checksumAlgorithm?: ChecksumAlgorithm | '';
  checksumStatus?: ChecksumStatus;
  error?: string;
  errorCode?: string;
  retryCount?: number;
  maxRetries?: number;
  speedBps?: number;
  etaSeconds?: number | null;
  mediaFormatJson?: string;
  mediaStateJson?: string;
  sourcePageUrl?: string;
  autoOpen?: boolean;
  tlsAllowInsecure?: boolean;
  scheduledAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  recordLogJson?: string;
}

export class AppDatabase {
  private db: DatabaseSync | null = null;
  private readonly filePath: string;
  private readonly cipher: SecretBox;
  private stmtCache = new Map<string, ReturnType<DatabaseSync['prepare']>>();

  constructor(filePath: string, cipher: SecretBox) {
    this.filePath = filePath;
    this.cipher = cipher;
  }

  open(): void {
    if (this.db) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.db = new DatabaseSync(this.filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.migrate();
    this.seed();
  }

  close(): void {
    this.stmtCache.clear();
    this.db?.close();
    this.db = null;
  }

  private get connection(): DatabaseSync {
    if (!this.db) throw new Error('Database is not open');
    return this.db;
  }

  private prep(sql: string) {
    let statement = this.stmtCache.get(sql);
    if (!statement) {
      statement = this.connection.prepare(sql);
      this.stmtCache.set(sql, statement);
    }
    return statement;
  }

  private migrate(): void {
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const row = this.connection.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null };
    const current = row?.version ?? 0;
    if (current < 1) {
      this.transaction(() => {
        this.connection.exec(`
          CREATE TABLE settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            secret INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE queues (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            priority INTEGER NOT NULL DEFAULT 0,
            max_concurrent INTEGER NOT NULL DEFAULT 0,
            speed_limit INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'active',
            is_default INTEGER NOT NULL DEFAULT 0,
            on_complete TEXT NOT NULL DEFAULT 'none',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE downloads (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            url TEXT NOT NULL,
            final_url TEXT,
            file_name TEXT NOT NULL,
            file_name_explicit INTEGER NOT NULL DEFAULT 0,
            destination_dir TEXT NOT NULL,
            destination_explicit INTEGER NOT NULL DEFAULT 0,
            target_path TEXT,
            temp_path TEXT,
            category TEXT NOT NULL DEFAULT 'other',
            queue_id TEXT NOT NULL REFERENCES queues(id) ON DELETE RESTRICT,
            status TEXT NOT NULL,
            priority TEXT NOT NULL DEFAULT 'normal',
            total_bytes INTEGER,
            downloaded_bytes INTEGER NOT NULL DEFAULT 0,
            resumable INTEGER NOT NULL DEFAULT 1,
            connections INTEGER NOT NULL DEFAULT 8,
            speed_limit INTEGER NOT NULL DEFAULT 0,
            headers_enc TEXT NOT NULL DEFAULT '',
            cookies_enc TEXT NOT NULL DEFAULT '',
            referrer TEXT NOT NULL DEFAULT '',
            mime_type TEXT NOT NULL DEFAULT '',
            etag TEXT NOT NULL DEFAULT '',
            last_modified TEXT NOT NULL DEFAULT '',
            checksum TEXT NOT NULL DEFAULT '',
            checksum_algorithm TEXT NOT NULL DEFAULT '',
            checksum_status TEXT NOT NULL DEFAULT 'pending',
            error TEXT NOT NULL DEFAULT '',
            error_code TEXT NOT NULL DEFAULT '',
            retry_count INTEGER NOT NULL DEFAULT 0,
            max_retries INTEGER NOT NULL DEFAULT 5,
            speed_bps INTEGER NOT NULL DEFAULT 0,
            eta_seconds INTEGER,
            media_format_json TEXT NOT NULL DEFAULT '',
            media_state_json TEXT NOT NULL DEFAULT '',
            source_page_url TEXT NOT NULL DEFAULT '',
            auto_open INTEGER NOT NULL DEFAULT 0,
            scheduled_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            started_at TEXT,
            completed_at TEXT,
            record_log_json TEXT NOT NULL DEFAULT '[]'
          );
          CREATE TABLE download_segments (
            download_id TEXT NOT NULL REFERENCES downloads(id) ON DELETE CASCADE,
            idx INTEGER NOT NULL,
            start_byte INTEGER NOT NULL,
            end_byte INTEGER,
            downloaded_bytes INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending',
            PRIMARY KEY (download_id, idx)
          );
          CREATE TABLE schedules (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            queue_id TEXT REFERENCES queues(id) ON DELETE CASCADE,
            action TEXT NOT NULL,
            days TEXT NOT NULL,
            start_time TEXT NOT NULL,
            stop_time TEXT NOT NULL DEFAULT '',
            enabled INTEGER NOT NULL DEFAULT 1,
            last_fired_key TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE rules (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            priority INTEGER NOT NULL DEFAULT 100,
            match_type TEXT NOT NULL,
            pattern TEXT NOT NULL,
            category TEXT NOT NULL,
            destination_dir TEXT NOT NULL DEFAULT '',
            auto_open INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE site_rules (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            pattern TEXT NOT NULL,
            action TEXT NOT NULL DEFAULT 'ask',
            file_types TEXT NOT NULL DEFAULT '',
            destination_dir TEXT NOT NULL DEFAULT '',
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            level TEXT NOT NULL,
            scope TEXT NOT NULL,
            message TEXT NOT NULL,
            detail TEXT NOT NULL DEFAULT ''
          );
          CREATE INDEX idx_downloads_status ON downloads(status);
          CREATE INDEX idx_downloads_queue ON downloads(queue_id);
          CREATE INDEX idx_downloads_url ON downloads(url);
          CREATE INDEX idx_downloads_created ON downloads(created_at DESC);
          CREATE INDEX idx_logs_timestamp ON logs(timestamp DESC);
        `);
        this.connection.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)').run(now());
      });
    }
    if (current < 2) {
      this.transaction(() => {
        this.connection.exec('CREATE INDEX IF NOT EXISTS idx_downloads_target ON downloads(target_path);');
        this.connection.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)').run(now());
      });
    }
    if (current < 3) {
      this.transaction(() => {
        const columns = this.connection.prepare('PRAGMA table_info(downloads)').all() as Array<{ name: string }>;
        if (!columns.some((column) => column.name === 'destination_explicit')) {
          this.connection.exec('ALTER TABLE downloads ADD COLUMN destination_explicit INTEGER NOT NULL DEFAULT 0;');
        }
        this.connection.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (3, ?)').run(now());
      });
    }
    if (current < 4) {
      this.transaction(() => {
        const columns = this.connection.prepare('PRAGMA table_info(downloads)').all() as Array<{ name: string }>;
        if (!columns.some((column) => column.name === 'tls_allow_insecure')) {
          this.connection.exec('ALTER TABLE downloads ADD COLUMN tls_allow_insecure INTEGER NOT NULL DEFAULT 0;');
        }
        this.connection.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (4, ?)').run(now());
      });
    }
  }

  private seed(): void {
    const defaultQueue = this.connection.prepare('SELECT id FROM queues WHERE is_default = 1').get() as { id: string } | undefined;
    if (!defaultQueue) {
      const timestamp = now();
      this.connection
        .prepare(
          `INSERT INTO queues (id, name, priority, max_concurrent, speed_limit, status, is_default, on_complete, created_at, updated_at)
           VALUES ('default', 'Main queue', 0, 0, 0, 'active', 1, 'none', ?, ?)`
        )
        .run(timestamp, timestamp);
    }
    const ruleCount = this.connection.prepare('SELECT COUNT(*) AS count FROM rules').get() as { count: number };
    if ((ruleCount?.count ?? 0) === 0) {
      const timestamp = now();
      for (const rule of DEFAULT_RULES) {
        this.connection
          .prepare(
            `INSERT INTO rules (id, name, enabled, priority, match_type, pattern, category, destination_dir, auto_open, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            crypto.randomUUID(),
            rule.name,
            rule.enabled ? 1 : 0,
            rule.priority,
            rule.matchType,
            rule.pattern,
            rule.category,
            rule.destinationDir,
            rule.autoOpen ? 1 : 0,
            timestamp,
            timestamp
          );
      }
    }
  }

  private transaction<T>(fn: () => T): T {
    this.connection.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.connection.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.connection.exec('ROLLBACK');
      } catch {
        // Ignore rollback errors.
      }
      throw error;
    }
  }

  listDownloads(): DownloadRecord[] {
    const rows = this.connection.prepare('SELECT * FROM downloads ORDER BY created_at DESC').all() as unknown as DownloadRow[];
    const segmentRows = this.connection.prepare('SELECT * FROM download_segments ORDER BY download_id, idx').all() as unknown as SegmentRow[];
    const byDownload = new Map<string, DownloadSegment[]>();
    for (const segment of segmentRows) {
      const list = byDownload.get(segment.download_id) ?? [];
      list.push({
        index: segment.idx,
        startByte: segment.start_byte,
        endByte: segment.end_byte,
        downloadedBytes: segment.downloaded_bytes,
        status: segment.status
      });
      byDownload.set(segment.download_id, list);
    }
    return rows.map((row) => this.mapDownload(row, byDownload.get(row.id) ?? []));
  }

  getDownload(id: string): DownloadRecord | null {
    const row = this.connection.prepare('SELECT * FROM downloads WHERE id = ?').get(id) as unknown as DownloadRow | undefined;
    if (!row) return null;
    const segments = this.connection
      .prepare('SELECT * FROM download_segments WHERE download_id = ? ORDER BY idx')
      .all(id) as unknown as SegmentRow[];
    return this.mapDownload(
      row,
      segments.map((segment) => ({
        index: segment.idx,
        startByte: segment.start_byte,
        endByte: segment.end_byte,
        downloadedBytes: segment.downloaded_bytes,
        status: segment.status
      }))
    );
  }

  insertDownload(record: DownloadRecord): void {
    this.connection
      .prepare(
        `INSERT INTO downloads (
          id, kind, url, final_url, file_name, file_name_explicit, destination_dir, destination_explicit, tls_allow_insecure, target_path, temp_path,
          category, queue_id, status, priority, total_bytes, downloaded_bytes, resumable, connections, speed_limit,
          headers_enc, cookies_enc, referrer, mime_type, etag, last_modified, checksum, checksum_algorithm,
          checksum_status, error, error_code, retry_count, max_retries, speed_bps, eta_seconds,
          media_format_json, media_state_json, source_page_url, auto_open, scheduled_at,
          created_at, updated_at, started_at, completed_at, record_log_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.kind,
        record.url,
        record.finalUrl,
        record.fileName,
        record.fileNameExplicit ? 1 : 0,
        record.destinationDir,
        record.destinationExplicit ? 1 : 0,
        record.tlsAllowInsecure ? 1 : 0,
        record.targetPath,
        record.tempPath,
        record.category,
        record.queueId,
        record.status,
        record.priority,
        record.totalBytes,
        record.downloadedBytes,
        record.resumable ? 1 : 0,
        record.connections,
        record.speedLimitBps,
        this.encodeJson(record.headers),
        this.cipher.encrypt(record.cookies || ''),
        record.referrer,
        record.mimeType,
        record.etag,
        record.lastModified,
        record.checksum,
        record.checksumAlgorithm,
        record.checksumStatus,
        record.error,
        record.errorCode,
        record.retryCount,
        record.maxRetries,
        record.speedBps,
        record.etaSeconds,
        record.mediaFormatJson,
        record.mediaState,
        record.sourcePageUrl,
        record.autoOpen ? 1 : 0,
        record.scheduledAt,
        record.createdAt,
        record.updatedAt,
        record.startedAt,
        record.completedAt,
        JSON.stringify(record.recordLog)
      );
    this.replaceSegments(record.id, record.segments);
  }

  updateDownload(id: string, fields: DownloadFields): void {
    const columns: string[] = [];
    const values: Array<string | number | null> = [];
    const mapping: Record<keyof DownloadFields, string> = {
      kind: 'kind',
      url: 'url',
      finalUrl: 'final_url',
      fileName: 'file_name',
      fileNameExplicit: 'file_name_explicit',
      destinationDir: 'destination_dir',
      destinationExplicit: 'destination_explicit',
      tlsAllowInsecure: 'tls_allow_insecure',
      targetPath: 'target_path',
      tempPath: 'temp_path',
      category: 'category',
      queueId: 'queue_id',
      status: 'status',
      priority: 'priority',
      totalBytes: 'total_bytes',
      downloadedBytes: 'downloaded_bytes',
      resumable: 'resumable',
      connections: 'connections',
      speedLimitBps: 'speed_limit',
      headers: 'headers_enc',
      cookies: 'cookies_enc',
      referrer: 'referrer',
      mimeType: 'mime_type',
      etag: 'etag',
      lastModified: 'last_modified',
      checksum: 'checksum',
      checksumAlgorithm: 'checksum_algorithm',
      checksumStatus: 'checksum_status',
      error: 'error',
      errorCode: 'error_code',
      retryCount: 'retry_count',
      maxRetries: 'max_retries',
      speedBps: 'speed_bps',
      etaSeconds: 'eta_seconds',
      mediaFormatJson: 'media_format_json',
      mediaStateJson: 'media_state_json',
      sourcePageUrl: 'source_page_url',
      autoOpen: 'auto_open',
      scheduledAt: 'scheduled_at',
      startedAt: 'started_at',
      completedAt: 'completed_at',
      recordLogJson: 'record_log_json'
    };
    for (const [key, value] of Object.entries(fields) as Array<[keyof DownloadFields, unknown]>) {
      if (value === undefined) continue;
      columns.push(`${mapping[key]} = ?`);
      if (key === 'headers') values.push(this.encodeJson(value as Record<string, string>));
      else if (key === 'cookies') values.push(this.cipher.encrypt(String(value)));
      else if (typeof value === 'boolean') values.push(value ? 1 : 0);
      else values.push(value as string | number | null);
    }
    if (!columns.length) return;
    columns.push('updated_at = ?');
    values.push(now());
    values.push(id);
    this.connection.prepare(`UPDATE downloads SET ${columns.join(', ')} WHERE id = ?`).run(...values);
  }

  saveCheckpoint(
    id: string,
    fields: DownloadFields,
    segments: DownloadSegment[] | null,
    mediaStateJson?: string,
    recordLogJson?: string
  ): void {
    this.transaction(() => {
      const patch: DownloadFields = { ...fields };
      if (mediaStateJson !== undefined) patch.mediaStateJson = mediaStateJson;
      if (recordLogJson !== undefined) patch.recordLogJson = recordLogJson;
      this.updateDownload(id, patch);
      if (segments) this.replaceSegments(id, segments);
    });
  }

  replaceSegments(downloadId: string, segments: DownloadSegment[]): void {
    this.connection.prepare('DELETE FROM download_segments WHERE download_id = ?').run(downloadId);
    const insert = this.connection.prepare(
      `INSERT INTO download_segments (download_id, idx, start_byte, end_byte, downloaded_bytes, status)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const segment of segments) {
      insert.run(downloadId, segment.index, segment.startByte, segment.endByte, segment.downloadedBytes, segment.status);
    }
  }

  deleteDownload(id: string): void {
    this.connection.prepare('DELETE FROM downloads WHERE id = ?').run(id);
  }

  deleteCompletedDownloads(): void {
    this.connection.prepare("DELETE FROM downloads WHERE status IN ('completed', 'canceled')").run();
  }

  recoverInterrupted(): number {
    const result = this.connection
      .prepare(
        `UPDATE downloads SET status = 'paused', error = 'Interrupted by application restart. Resume to continue.', error_code = 'INTERRUPTED', updated_at = ?
         WHERE status IN ('connecting', 'downloading', 'verifying', 'finalizing')`
      )
      .run(now());
    return Number(result.changes ?? 0);
  }

  findActiveByUrl(url: string): DownloadRecord | null {
    const row = this.connection
      .prepare(
        `SELECT * FROM downloads WHERE url = ? AND status IN ('queued','scheduled','connecting','downloading','paused','verifying','finalizing') ORDER BY created_at DESC LIMIT 1`
      )
      .get(url) as unknown as DownloadRow | undefined;
    if (!row) return null;
    return this.getDownload(row.id);
  }

  findByTargetPath(targetPath: string): DownloadRecord | null {
    const row = this.connection
      .prepare("SELECT * FROM downloads WHERE target_path = ? AND status = 'completed' LIMIT 1")
      .get(targetPath) as unknown as DownloadRow | undefined;
    return row ? this.getDownload(row.id) : null;
  }

  listQueues(): QueueRecord[] {
    const rows = this.connection.prepare('SELECT * FROM queues ORDER BY is_default DESC, priority DESC, name').all() as unknown as QueueRow[];
    return rows.map(mapQueue);
  }

  getQueue(id: string): QueueRecord | null {
    const row = this.connection.prepare('SELECT * FROM queues WHERE id = ?').get(id) as unknown as QueueRow | undefined;
    return row ? mapQueue(row) : null;
  }

  insertQueue(queue: QueueRecord): void {
    this.connection
      .prepare(
        `INSERT INTO queues (id, name, priority, max_concurrent, speed_limit, status, is_default, on_complete, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        queue.id,
        queue.name,
        queue.priority,
        queue.maxConcurrent,
        queue.speedLimitBps,
        queue.status,
        queue.isDefault ? 1 : 0,
        queue.onComplete,
        queue.createdAt,
        queue.updatedAt
      );
  }

  updateQueue(queue: QueueRecord): void {
    this.connection
      .prepare(
        `UPDATE queues SET name = ?, priority = ?, max_concurrent = ?, speed_limit = ?, status = ?, on_complete = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        queue.name,
        queue.priority,
        queue.maxConcurrent,
        queue.speedLimitBps,
        queue.status,
        queue.onComplete,
        queue.updatedAt,
        queue.id
      );
  }

  deleteQueue(id: string): void {
    this.transaction(() => {
      this.connection.prepare("UPDATE downloads SET queue_id = 'default' WHERE queue_id = ?").run(id);
      this.connection.prepare('DELETE FROM queues WHERE id = ? AND is_default = 0').run(id);
    });
  }

  listSchedules(): ScheduleRecord[] {
    const rows = this.connection.prepare('SELECT * FROM schedules ORDER BY name').all() as unknown as ScheduleRow[];
    return rows.map(mapSchedule);
  }

  insertSchedule(schedule: ScheduleRecord): void {
    this.connection
      .prepare(
        `INSERT INTO schedules (id, name, queue_id, action, days, start_time, stop_time, enabled, last_fired_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        schedule.id,
        schedule.name,
        schedule.queueId,
        schedule.action,
        JSON.stringify(schedule.days),
        schedule.startTime,
        schedule.stopTime,
        schedule.enabled ? 1 : 0,
        schedule.lastFiredKey,
        schedule.createdAt,
        schedule.updatedAt
      );
  }

  updateSchedule(schedule: ScheduleRecord): void {
    this.connection
      .prepare(
        `UPDATE schedules SET name = ?, queue_id = ?, action = ?, days = ?, start_time = ?, stop_time = ?, enabled = ?, last_fired_key = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        schedule.name,
        schedule.queueId,
        schedule.action,
        JSON.stringify(schedule.days),
        schedule.startTime,
        schedule.stopTime,
        schedule.enabled ? 1 : 0,
        schedule.lastFiredKey,
        schedule.updatedAt,
        schedule.id
      );
  }

  deleteSchedule(id: string): void {
    this.connection.prepare('DELETE FROM schedules WHERE id = ?').run(id);
  }

  listRules(): CategoryRule[] {
    const rows = this.connection.prepare('SELECT * FROM rules ORDER BY priority DESC, name').all() as unknown as RuleRow[];
    return rows.map(mapRule);
  }

  insertRule(rule: CategoryRule): void {
    this.connection
      .prepare(
        `INSERT INTO rules (id, name, enabled, priority, match_type, pattern, category, destination_dir, auto_open, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        rule.id,
        rule.name,
        rule.enabled ? 1 : 0,
        rule.priority,
        rule.matchType,
        rule.pattern,
        rule.category,
        rule.destinationDir,
        rule.autoOpen ? 1 : 0,
        rule.createdAt,
        rule.updatedAt
      );
  }

  updateRule(rule: CategoryRule): void {
    this.connection
      .prepare(
        `UPDATE rules SET name = ?, enabled = ?, priority = ?, match_type = ?, pattern = ?, category = ?, destination_dir = ?, auto_open = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        rule.name,
        rule.enabled ? 1 : 0,
        rule.priority,
        rule.matchType,
        rule.pattern,
        rule.category,
        rule.destinationDir,
        rule.autoOpen ? 1 : 0,
        rule.updatedAt,
        rule.id
      );
  }

  deleteRule(id: string): void {
    this.connection.prepare('DELETE FROM rules WHERE id = ?').run(id);
  }

  listSiteRules(): SiteRule[] {
    const rows = this.connection.prepare('SELECT * FROM site_rules ORDER BY name').all() as unknown as SiteRuleRow[];
    return rows.map(mapSiteRule);
  }

  insertSiteRule(rule: SiteRule): void {
    this.connection
      .prepare(
        `INSERT INTO site_rules (id, name, pattern, action, file_types, destination_dir, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        rule.id,
        rule.name,
        rule.pattern,
        rule.action,
        rule.fileTypes.join(','),
        rule.destinationDir,
        rule.enabled ? 1 : 0,
        rule.createdAt,
        rule.updatedAt
      );
  }

  updateSiteRule(rule: SiteRule): void {
    this.connection
      .prepare(
        `UPDATE site_rules SET name = ?, pattern = ?, action = ?, file_types = ?, destination_dir = ?, enabled = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        rule.name,
        rule.pattern,
        rule.action,
        rule.fileTypes.join(','),
        rule.destinationDir,
        rule.enabled ? 1 : 0,
        rule.updatedAt,
        rule.id
      );
  }

  deleteSiteRule(id: string): void {
    this.connection.prepare('DELETE FROM site_rules WHERE id = ?').run(id);
  }

  getSetting(key: string): { value: string; secret: boolean } | null {
    const row = this.connection.prepare('SELECT value, secret FROM settings WHERE key = ?').get(key) as
      | { value: string; secret: number }
      | undefined;
    if (!row) return null;
    const secret = row.secret === 1;
    return { value: secret ? this.cipher.decrypt(row.value) : row.value, secret };
  }

  setSetting(key: string, value: string, secret = false): void {
    const stored = secret ? this.cipher.encrypt(value) : value;
    this.connection
      .prepare(
        `INSERT INTO settings (key, value, secret, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, secret = excluded.secret, updated_at = excluded.updated_at`
      )
      .run(key, stored, secret ? 1 : 0, now());
  }

  deleteSetting(key: string): void {
    this.connection.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  loadSettings(): AppSettings | null {
    const row = this.getSetting('app');
    if (!row) return null;
    try {
      return JSON.parse(row.value) as AppSettings;
    } catch {
      return null;
    }
  }

  saveSettings(settings: AppSettings): void {
    this.setSetting('app', JSON.stringify(settings));
  }

  addLog(level: LogRecord['level'], scope: string, message: string, detail = ''): LogRecord {
    const timestamp = now();
    const result = this.connection
      .prepare('INSERT INTO logs (timestamp, level, scope, message, detail) VALUES (?, ?, ?, ?, ?)')
      .run(timestamp, level, scope, message, detail);
    const id = Number(result.lastInsertRowid ?? 0);
    this.connection.prepare('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 5000)').run();
    return { id, timestamp, level, scope, message, detail };
  }

  listLogs(limit = 500, level?: string): LogRecord[] {
    const safeLimit = Math.max(1, Math.min(2000, limit));
    const rows = level
      ? (this.connection.prepare('SELECT * FROM logs WHERE level = ? ORDER BY id DESC LIMIT ?').all(level, safeLimit) as unknown as LogRow[])
      : (this.connection.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(safeLimit) as unknown as LogRow[]);
    return rows.map((row) => ({ ...row }));
  }

  clearLogs(): void {
    this.connection.prepare('DELETE FROM logs').run();
  }

  getStats(): { counts: Record<DownloadStatus, number>; totalBytes: number; downloadedBytes: number } {
    const rows = this.connection.prepare('SELECT status, COUNT(*) AS count, SUM(total_bytes) AS total, SUM(downloaded_bytes) AS downloaded FROM downloads GROUP BY status').all() as Array<{
      status: DownloadStatus;
      count: number;
      total: number | null;
      downloaded: number | null;
    }>;
    const counts = {
      queued: 0,
      scheduled: 0,
      connecting: 0,
      downloading: 0,
      paused: 0,
      verifying: 0,
      finalizing: 0,
      completed: 0,
      failed: 0,
      canceled: 0
    } as Record<DownloadStatus, number>;
    let totalBytes = 0;
    let downloadedBytes = 0;
    for (const row of rows) {
      counts[row.status] = row.count;
      totalBytes += row.total ?? 0;
      downloadedBytes += row.downloaded ?? 0;
    }
    return { counts, totalBytes, downloadedBytes };
  }

  exportRecords(): { downloads: DownloadRecord[] } {
    return { downloads: this.listDownloads() };
  }

  private mapDownload(row: DownloadRow, segments: DownloadSegment[]): DownloadRecord {
    let headers: Record<string, string> = {};
    try {
      const decoded = this.cipher.decrypt(row.headers_enc || '');
      if (decoded) headers = JSON.parse(decoded) as Record<string, string>;
    } catch {
      headers = {};
    }
    let cookies = '';
    try {
      cookies = this.cipher.decrypt(row.cookies_enc || '');
    } catch {
      cookies = '';
    }
    let recordLog: DownloadRecord['recordLog'] = [];
    try {
      recordLog = JSON.parse(row.record_log_json || '[]') as DownloadRecord['recordLog'];
    } catch {
      recordLog = [];
    }
    return {
      id: row.id,
      kind: row.kind,
      url: row.url,
      finalUrl: row.final_url,
      fileName: row.file_name,
      fileNameExplicit: row.file_name_explicit === 1,
      destinationDir: row.destination_dir,
      destinationExplicit: row.destination_explicit === 1,
      targetPath: row.target_path,
      tempPath: row.temp_path,
      category: row.category,
      queueId: row.queue_id,
      status: row.status,
      priority: row.priority,
      totalBytes: row.total_bytes,
      downloadedBytes: row.downloaded_bytes,
      resumable: row.resumable === 1,
      connections: row.connections,
      speedLimitBps: row.speed_limit,
      headers,
      cookies,
      referrer: row.referrer,
      mimeType: row.mime_type,
      etag: row.etag,
      lastModified: row.last_modified,
      checksum: row.checksum,
      checksumAlgorithm: row.checksum_algorithm,
      checksumStatus: row.checksum_status,
      error: row.error,
      errorCode: row.error_code,
      retryCount: row.retry_count,
      maxRetries: row.max_retries,
      speedBps: row.speed_bps,
      etaSeconds: row.eta_seconds,
      segments,
      scheduledAt: row.scheduled_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      autoOpen: row.auto_open === 1,
      tlsAllowInsecure: row.tls_allow_insecure === 1,
      mediaFormatJson: row.media_format_json,
      mediaState: row.media_state_json,
      sourcePageUrl: row.source_page_url,
      recordLog
    };
  }

  private encodeJson(value: unknown): string {
    return this.cipher.encrypt(JSON.stringify(value ?? {}));
  }
}

function now(): string {
  return new Date().toISOString();
}

function mapQueue(row: QueueRow): QueueRecord {
  return {
    id: row.id,
    name: row.name,
    priority: row.priority,
    maxConcurrent: row.max_concurrent,
    speedLimitBps: row.speed_limit,
    status: row.status,
    isDefault: row.is_default === 1,
    onComplete: row.on_complete,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapSchedule(row: ScheduleRow): ScheduleRecord {
  let days: number[] = [];
  try {
    days = JSON.parse(row.days);
  } catch {
    days = [];
  }
  return {
    id: row.id,
    name: row.name,
    queueId: row.queue_id,
    action: row.action,
    days,
    startTime: row.start_time,
    stopTime: row.stop_time,
    enabled: row.enabled === 1,
    lastFiredKey: row.last_fired_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapRule(row: RuleRow): CategoryRule {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    priority: row.priority,
    matchType: row.match_type,
    pattern: row.pattern,
    category: row.category,
    destinationDir: row.destination_dir,
    autoOpen: row.auto_open === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapSiteRule(row: SiteRuleRow): SiteRule {
  return {
    id: row.id,
    name: row.name,
    pattern: row.pattern,
    action: row.action,
    fileTypes: row.file_types ? row.file_types.split(',').map((value) => value.trim()).filter(Boolean) : [],
    destinationDir: row.destination_dir,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
