import { describe, expect, it } from 'vitest';
import type { ScheduleRecord, SiteRule } from '../src/shared/types';
import {
  allowedUrl,
  checksumLength,
  deriveFileNameFromUrl,
  fileTypeAllowed,
  isYouTubeUrl,
  normalizeTime,
  parseContentDisposition,
  redactUrl,
  sanitizeCookies,
  sanitizeFileName,
  sanitizeHeaderValue,
  sanitizeHeaders,
  scheduleOccurrences,
  validateChecksum,
  wildcardHostMatch
} from '../src/shared/validation';

function siteRule(overrides: Partial<SiteRule> = {}): SiteRule {
  return {
    id: 'rule-1',
    name: 'Example',
    pattern: '*.example.com',
    action: 'auto',
    fileTypes: [],
    destinationDir: '',
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

function schedule(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: 'schedule-1',
    name: 'Weeknight queue',
    queueId: 'default',
    action: 'start_queue',
    days: [1],
    startTime: '09:00',
    stopTime: '17:00',
    enabled: true,
    lastFiredKey: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

describe('validation', () => {
  it('sanitizes file names for Windows', () => {
    expect(sanitizeFileName(' report<>:"/\\|?*.pdf ')).toBe('report_________.pdf');
    expect(sanitizeFileName('CON')).toBe('_CON');
    expect(sanitizeFileName('..')).toBe('download');
    expect(sanitizeFileName('a\u0000b\nc.txt')).toBe('abc.txt');
    expect(sanitizeFileName('x'.repeat(300) + '.zip')).toHaveLength(180);
  });

  it('strips control characters from headers and cookies', () => {
    expect(sanitizeHeaderValue(' value\r\nInjected: yes ')).toBe('valueInjected: yes');
    expect(sanitizeCookies('session=abc\u0000\r\n; theme=dark')).toBe('session=abc; theme=dark');
    const headers = sanitizeHeaders({
      Accept: 'application/json',
      Host: 'evil.test',
      'Content-Length': '10',
      'Bad Header': 'x',
      'X-Test': 'one\r\ntwo'
    });
    expect(headers).toEqual({ Accept: 'application/json', 'X-Test': 'onetwo' });
  });

  it('validates URLs and redacts credentials', () => {
    expect(allowedUrl('https://example.com/file.zip')).toBe(true);
    expect(allowedUrl('ftp://example.com/file.zip')).toBe(true);
    expect(allowedUrl('file:///c:/secret.txt')).toBe(false);
    expect(allowedUrl('javascript:alert(1)')).toBe(false);
    expect(redactUrl('https://user:password@example.com/a?token=secret&x=1')).toBe(
      'https://***:***@example.com/a?token=***&x=1'
    );
  });

  it('recognizes YouTube video pages without matching unrelated pages', () => {
    expect(isYouTubeUrl('https://www.youtube.com/watch?v=9DKHX1CA33g')).toBe(true);
    expect(isYouTubeUrl('https://youtube.com/watch?v=abc&list=xyz')).toBe(true);
    expect(isYouTubeUrl('https://m.youtube.com/watch?v=abc')).toBe(true);
    expect(isYouTubeUrl('https://music.youtube.com/watch?v=abc')).toBe(true);
    expect(isYouTubeUrl('https://www.youtube.com/shorts/abc')).toBe(true);
    expect(isYouTubeUrl('https://www.youtube.com/embed/abc')).toBe(true);
    expect(isYouTubeUrl('https://www.youtube.com/live/abc')).toBe(true);
    expect(isYouTubeUrl('https://youtu.be/abc')).toBe(true);
    expect(isYouTubeUrl('https://www.youtube.com/playlist?list=abc')).toBe(false);
    expect(isYouTubeUrl('https://www.youtube.com/@channel')).toBe(false);
    expect(isYouTubeUrl('https://example.com/watch?v=abc')).toBe(false);
    expect(isYouTubeUrl('ftp://youtube.com/watch?v=abc')).toBe(false);
    expect(isYouTubeUrl('https://youtu.be/')).toBe(false);
  });

  it('parses content disposition and derives safe names', () => {
    expect(parseContentDisposition('attachment; filename="report final.pdf"')).toEqual({
      fileName: 'report final.pdf',
      isAttachment: true
    });
    expect(parseContentDisposition("attachment; filename*=UTF-8''caf%C3%A9.zip").fileName).toBe('café.zip');
    expect(deriveFileNameFromUrl('https://example.com/files/report.pdf?token=1', 'download')).toBe('report.pdf');
    expect(deriveFileNameFromUrl('https://example.com/', 'download')).toMatch(/^download-\d+$/);
  });

  it('matches wildcard hosts without leaking to unrelated domains', () => {
    expect(wildcardHostMatch('*.example.com', 'www.example.com')).toBe(true);
    expect(wildcardHostMatch('*.example.com', 'deep.media.example.com')).toBe(true);
    expect(wildcardHostMatch('example.com', 'example.com')).toBe(true);
    expect(wildcardHostMatch('example.com', 'notexample.com')).toBe(false);
    expect(wildcardHostMatch('https://*.example.com/path', 'cdn.example.com')).toBe(true);
    expect(wildcardHostMatch('', 'example.com')).toBe(false);
  });

  it('filters site rules by file type', () => {
    const rule = siteRule({ fileTypes: ['mp4', 'zip'] });
    expect(fileTypeAllowed('movie.MP4', rule)).toBe(true);
    expect(fileTypeAllowed('archive.zip', rule)).toBe(true);
    expect(fileTypeAllowed('photo.jpg', rule)).toBe(false);
    expect(fileTypeAllowed('photo.jpg', siteRule())).toBe(true);
    expect(fileTypeAllowed('photo.jpg', undefined)).toBe(true);
  });

  it('validates checksums', () => {
    expect(checksumLength('sha256')).toBe(64);
    expect(validateChecksum('a'.repeat(64), 'sha256')).toBe(true);
    expect(validateChecksum('a'.repeat(63), 'sha256')).toBe(false);
    expect(validateChecksum('', 'sha256')).toBe(true);
    expect(normalizeTime('9:05')).toBe('09:05');
    expect(normalizeTime('24:00')).toBeNull();
  });

  it('creates schedule occurrences in chronological order', () => {
    const monday = new Date(2026, 9, 19, 8, 0, 0);
    const occurrences = scheduleOccurrences(schedule(), monday, 2);
    expect(occurrences).toHaveLength(2);
    expect(occurrences[0]?.action).toBe('start_queue');
    expect(occurrences[0]?.at.getHours()).toBe(9);
    expect(occurrences[1]?.action).toBe('stop_queue');
    expect(occurrences[1]?.at.getHours()).toBe(17);
  });

  it('handles overnight schedule windows and consecutive days', () => {
    const monday = new Date(2026, 9, 19, 22, 0, 0);
    const occurrences = scheduleOccurrences(
      schedule({ days: [1, 2], startTime: '23:00', stopTime: '02:00', action: 'start_all' }),
      monday,
      3
    );
    expect(occurrences[0]?.action).toBe('start_all');
    expect(occurrences[0]?.at.getDate()).toBe(19);
    expect(occurrences[0]?.at.getHours()).toBe(23);
    expect(occurrences[1]?.action).toBe('pause_all');
    expect(occurrences[1]?.at.getDate()).toBe(20);
    expect(occurrences[1]?.at.getHours()).toBe(2);
  });

  it('returns no occurrences for disabled schedules', () => {
    expect(scheduleOccurrences(schedule({ enabled: false }), new Date(), 8)).toEqual([]);
    expect(scheduleOccurrences(schedule({ days: [] }), new Date(), 8)).toEqual([]);
  });
});
