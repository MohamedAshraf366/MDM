import type { ChecksumAlgorithm, FileCategory, SiteRule, ScheduleRecord } from './types';

const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*]/g;

const CATEGORY_EXTENSIONS: Record<Exclude<FileCategory, 'other'>, string[]> = {
  video: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'flv', 'm4v', 'ts', 'm2ts', 'mpg', 'mpeg', '3gp', 'ogv'],
  audio: ['mp3', 'flac', 'wav', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'alac', 'aiff', 'mid'],
  documents: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'csv', 'epub', 'mobi', 'odt', 'ods', 'odp', 'md'],
  archives: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'cab', 'zst', 'lz', 'tgz'],
  images: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'tif', 'tiff', 'heic', 'avif', 'ico', 'raw'],
  programs: ['exe', 'msi', 'msix', 'appx', 'apk', 'dmg', 'pkg', 'deb', 'rpm', 'bat', 'ps1']
};

const MIME_EXTENSIONS: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/x-matroska': 'mkv',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi',
  'video/mp2t': 'ts',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/flac': 'flac',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
  'audio/opus': 'opus',
  'audio/aac': 'aac',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/x-7z-compressed': '7z',
  'application/x-rar-compressed': 'rar',
  'application/gzip': 'gz',
  'application/x-tar': 'tar',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/octet-stream': 'bin'
};

const UNSAFE_HEADER_NAMES = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'upgrade',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer'
]);

function stripControlCharacters(value: string): string {
  let result = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= 32 && code !== 127) result += character;
  }
  return result;
}

export function sanitizeFileName(input: string, fallback = 'download'): string {
  // Bidi overrides and zero-width characters let "invoice<RLO>txt.exe" display
  // as "invoiceexe.txt"; a server-supplied name must not hide its real extension.
  let name = stripControlCharacters(input || '')
    .replace(/[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, '')
    .replace(INVALID_FILENAME_CHARS, '_')
    .trim();
  name = name.replace(/\s+/g, ' ');
  name = name.replace(/^[. ]+|[. ]+$/g, '');
  if (!name || name === '.' || name === '..') name = fallback;
  const extensionIndex = name.lastIndexOf('.');
  const base = extensionIndex > 0 ? name.slice(0, extensionIndex) : name;
  const ext = extensionIndex > 0 ? name.slice(extensionIndex) : '';
  const maxBaseLength = Math.max(1, 180 - ext.length);
  if (base.length > maxBaseLength) name = base.slice(0, maxBaseLength) + ext;
  if (RESERVED_WINDOWS_NAMES.test(name)) name = `_${name}`;
  return name;
}

export function sanitizeHeaderValue(value: string): string {
  return stripControlCharacters(String(value)).trim();
}

export function sanitizeHeaders(headers: Record<string, string> | undefined | null): Record<string, string> {
  const result: Record<string, string> = {};
  if (!headers) return result;
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = String(rawKey).trim();
    if (!key || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(key)) continue;
    if (UNSAFE_HEADER_NAMES.has(key.toLowerCase())) continue;
    if (rawValue === null || rawValue === undefined) continue;
    result[key] = sanitizeHeaderValue(String(rawValue));
  }
  return result;
}

export function sanitizeCookies(cookies: string): string {
  return stripControlCharacters(String(cookies || '')).trim();
}

export function isYouTubeUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (host === 'youtu.be') return url.pathname.length > 1;
    if (host === 'youtube-nocookie.com' || host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      if (url.pathname === '/watch') return Boolean(url.searchParams.get('v')?.trim());
      return /^\/(shorts|embed|live|v)\/[^/]+/i.test(url.pathname);
    }
    return false;
  } catch {
    return false;
  }
}

export function allowedUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return ['http:', 'https:', 'ftp:'].includes(url.protocol) && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export function hostnameFromUrl(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = url.username ? '***' : '';
      url.password = url.password ? '***' : '';
    }
    for (const key of Array.from(url.searchParams.keys())) {
      if (/token|key|auth|signature|sig|password|secret|expires/i.test(key)) {
        url.searchParams.set(key, '***');
      }
    }
    return url.toString();
  } catch {
    return String(raw).replace(/\/\/[^/@\s]+@/, '//***@');
  }
}

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (/authorization|cookie|token|secret|api[-_]?key|proxy-authorization/i.test(key)) {
      result[key] = '***';
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function extensionFromMime(mimeType: string): string {
  const mime = ((mimeType || '').split(';')[0] ?? '').trim().toLowerCase();
  return MIME_EXTENSIONS[mime] ?? '';
}

export function extensionFromFileName(name: string): string {
  const match = /\.([a-z0-9]{1,10})$/i.exec(name);
  return match?.[1]?.toLowerCase() ?? '';
}

export function ensureExtension(fileName: string, mimeType: string, fallback = ''): string {
  if (extensionFromFileName(fileName)) return fileName;
  const ext = extensionFromMime(mimeType) || fallback;
  return ext ? `${fileName}.${ext}` : fileName;
}

export function categoryFromFileName(fileName: string): FileCategory {
  const ext = extensionFromFileName(fileName);
  for (const [category, extensions] of Object.entries(CATEGORY_EXTENSIONS) as Array<[Exclude<FileCategory, 'other'>, string[]]>) {
    if (extensions.includes(ext)) return category;
  }
  return 'other';
}

export function extensionCategory(extension: string): FileCategory {
  return categoryFromFileName(`file.${extension.replace(/^\./, '')}`);
}

export function parseContentDisposition(value: string | undefined): { fileName: string; isAttachment: boolean } {
  if (!value) return { fileName: '', isAttachment: false };
  const isAttachment = /^\s*attachment/i.test(value);
  let fileName = '';
  const starMatch = /filename\*\s*=\s*([^']*)'[^']*'([^;]+)/i.exec(value);
  if (starMatch?.[2]) {
    try {
      fileName = decodeURIComponent(starMatch[2].trim().replace(/^"|"$/g, ''));
    } catch {
      fileName = starMatch[2].trim().replace(/^"|"$/g, '');
    }
  }
  if (!fileName) {
    const quoted = /filename\s*=\s*"((?:\\.|[^"\\])*)"/i.exec(value);
    if (quoted?.[1] !== undefined) {
      fileName = quoted[1].replace(/\\(.)/g, '$1');
    } else {
      const plain = /filename\s*=\s*([^;]+)/i.exec(value);
      if (plain?.[1]) fileName = plain[1].trim();
    }
  }
  return { fileName: sanitizeFileName(fileName, ''), isAttachment };
}

export function deriveFileNameFromUrl(raw: string, fallbackPrefix = 'download'): string {
  try {
    const url = new URL(raw);
    const pathname = decodeURIComponent(url.pathname);
    const last = pathname.split('/').filter(Boolean).pop() ?? '';
    const name = sanitizeFileName(last, '');
    if (name) return name;
    return `${fallbackPrefix}-${Date.now()}`;
  } catch {
    return `${fallbackPrefix}-${Date.now()}`;
  }
}

export function checksumLength(algorithm: ChecksumAlgorithm): number {
  return algorithm === 'md5' ? 32 : algorithm === 'sha1' ? 40 : 64;
}

export function validateChecksum(value: string, algorithm: ChecksumAlgorithm): boolean {
  if (!value) return true;
  return new RegExp(`^[a-f0-9]{${checksumLength(algorithm)}}$`, 'i').test(value.trim());
}

export function wildcardHostMatch(pattern: string, hostname: string): boolean {
  const cleaned = pattern
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^\*\./, '');
  if (!cleaned) return false;
  const escaped = cleaned.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^(?:.*\\.)?${escaped}$`, 'i').test(hostname.toLowerCase());
}

export function fileTypeAllowed(fileName: string, siteRule: SiteRule | undefined): boolean {
  if (!siteRule || siteRule.fileTypes.length === 0) return true;
  const ext = extensionFromFileName(fileName);
  return siteRule.fileTypes.some((type) => type.replace(/^\./, '').toLowerCase() === ext);
}

export function normalizeTime(value: string): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function isReasonableUrlLength(url: string): boolean {
  return url.length > 0 && url.length <= 32_768;
}

export function dayKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export interface ScheduleOccurrence {
  at: Date;
  action: ScheduleRecord['action'];
  key: string;
  isStop: boolean;
}

export function scheduleOccurrences(schedule: ScheduleRecord, from: Date, horizonDays = 8): ScheduleOccurrence[] {
  if (!schedule.enabled || schedule.days.length === 0) return [];
  const results: ScheduleOccurrence[] = [];
  const startParts = schedule.startTime.split(':').map(Number);
  const stopParts = schedule.stopTime ? schedule.stopTime.split(':').map(Number) : null;
  const startHour = startParts[0] ?? 0;
  const startMinute = startParts[1] ?? 0;
  const startEnd = startHour * 60 + startMinute;
  const stopEnd = stopParts ? (stopParts[0] ?? 0) * 60 + (stopParts[1] ?? 0) : null;
  const stopAction: ScheduleRecord['action'] =
    schedule.action === 'start_queue' ? 'stop_queue' : schedule.action === 'start_all' ? 'pause_all' : schedule.action;

  for (let offset = 0; offset < horizonDays; offset++) {
    const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset);
    if (!schedule.days.includes(day.getDay())) continue;
    if (stopEnd !== null && stopEnd < startEnd) {
      const previous = new Date(day.getFullYear(), day.getMonth(), day.getDate() - 1);
      if (schedule.days.includes(previous.getDay())) {
        const stopAt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), stopParts![0] ?? 0, stopParts![1] ?? 0);
        if (stopAt > from) {
          results.push({
            at: stopAt,
            action: stopAction,
            key: `stop:${dayKey(day)}:${schedule.startTime}-${schedule.stopTime}`,
            isStop: true
          });
        }
      }
    }
    const startAt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), startHour, startMinute);
    if (startAt > from) {
      results.push({
        at: startAt,
        action: schedule.action,
        key: `start:${dayKey(day)}:${schedule.startTime}`,
        isStop: false
      });
    }
    if (stopEnd !== null && stopEnd >= startEnd) {
      const stopAt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), stopParts![0] ?? 0, stopParts![1] ?? 0);
      if (stopAt > from) {
        results.push({
          at: stopAt,
          action: stopAction,
          key: `stop:${dayKey(day)}:${schedule.stopTime}`,
          isStop: true
        });
      }
    }
  }
  return results.sort((a, b) => a.at.getTime() - b.at.getTime());
}

export function nextScheduleTime(schedule: ScheduleRecord, from = new Date()): Date | null {
  const [occurrence] = scheduleOccurrences(schedule, from, 8);
  return occurrence?.at ?? null;
}
