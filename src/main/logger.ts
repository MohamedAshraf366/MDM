import type { AppDatabase } from './database';
import type { LogRecord } from '../shared/types';
import { redactHeaders, redactUrl } from '../shared/validation';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

export class AppLogger {
  private listeners = new Set<(log: LogRecord) => void>();
  private level: keyof typeof LEVELS = 'info';

  constructor(
    private readonly db: AppDatabase,
    private readonly getLevel: () => keyof typeof LEVELS = () => 'info'
  ) {}

  setLevel(level: keyof typeof LEVELS): void {
    this.level = level;
  }

  onLog(listener: (log: LogRecord) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  debug(scope: string, message: string, detail?: unknown): void {
    this.write('debug', scope, message, detail);
  }

  info(scope: string, message: string, detail?: unknown): void {
    this.write('info', scope, message, detail);
  }

  warn(scope: string, message: string, detail?: unknown): void {
    this.write('warn', scope, message, detail);
  }

  error(scope: string, message: string, detail?: unknown): void {
    this.write('error', scope, message, detail);
  }

  private write(level: keyof typeof LEVELS, scope: string, message: string, detail?: unknown): void {
    const configured = this.getLevel() || this.level;
    if (LEVELS[level] < LEVELS[configured]) return;
    const redactedMessage = redactMessage(message);
    const detailText = detail === undefined ? '' : redactDetail(detail);
    try {
      const log = this.db.addLog(level, scope, redactedMessage, detailText);
      for (const listener of this.listeners) listener(log);
    } catch (error) {
      console.error(`[${scope}] ${redactedMessage}`, error);
    }
  }
}

export function redactMessage(message: string): string {
  return message
    .replace(/([?&](?:token|key|auth|signature|sig|password|secret|expires)=)[^&\s]+/gi, '$1***')
    .replace(/\/\/[^/@\s:]+:[^/@\s]+@/g, '//***:***@');
}

export function redactDetail(detail: unknown): string {
  let value: unknown = detail;
  if (typeof detail === 'string') {
    value = { message: detail };
  }
  try {
    const serialized = JSON.stringify(value, (key, item) => {
      if (/authorization|cookie|token|secret|password|proxy-authorization|api[-_]?key/i.test(key)) return '***';
      if (typeof item === 'string' && /^https?:\/\//i.test(item)) return redactUrl(item);
      if (item && typeof item === 'object' && !Array.isArray(item) && key.toLowerCase() === 'headers') {
        return redactHeaders(item as Record<string, string>);
      }
      return item;
    });
    return serialized.length > 16_384 ? `${serialized.slice(0, 16_384)}…` : serialized;
  } catch {
    return '[unserializable detail]';
  }
}
