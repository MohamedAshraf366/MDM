import type { DownloadLifecycleEvent, DownloadRecord } from '../../shared/types';
import type { Toast, ToastAction } from './toast-types';

const RETRYABLE_ERROR_CODES = new Set([
  'NETWORK',
  'TIMEOUT',
  'TLS_CHAIN',
  'TLS_HANDSHAKE',
  'DNS',
  'HTTP_429',
  'SERVER_ERROR',
  'HTTP_ERROR',
  'DISK_FULL',
  'INTERRUPTED'
]);

export type DownloadToast = Omit<Toast, 'id'> & { dedupeKey?: string };

function focusAction(record: DownloadRecord, label = 'Open download', details = false): ToastAction {
  return { kind: 'focus-download', label, downloadId: record.id, details };
}

export function canManuallyRetry(record: DownloadRecord): boolean {
  if (record.status !== 'failed') return false;
  return RETRYABLE_ERROR_CODES.has(record.errorCode);
}

export function downloadLifecycleToast(event: DownloadLifecycleEvent): DownloadToast | null {
  const record = event.record;
  const dedupeKey = `download:${record.id}:${event.state}`;
  if (event.state === 'started') {
    return {
      type: 'info',
      title: 'Download started',
      message: record.fileName,
      dedupeKey,
      actions: [focusAction(record)]
    };
  }
  if (event.state === 'completed') {
    return {
      type: 'success',
      title: 'Download complete',
      message: record.fileName,
      dedupeKey,
      actions: [
        { kind: 'open-file', label: 'Open file', downloadId: record.id },
        focusAction(record, 'Details', true)
      ]
    };
  }
  if (event.state === 'failed') {
    const reason = record.error.trim() || 'The transfer stopped without an error message.';
    const actions: ToastAction[] = [focusAction(record, 'Details', true)];
    if (canManuallyRetry(record)) {
      actions.unshift({ kind: 'retry-download', label: 'Retry', downloadId: record.id });
    }
    return {
      type: 'error',
      title: 'Download failed',
      message: `${record.fileName}: ${reason}`,
      dedupeKey,
      actions
    };
  }
  return null;
}
