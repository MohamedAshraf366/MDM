import { describe, expect, it } from 'vitest';
import { canManuallyRetry, downloadLifecycleToast } from '../src/renderer/app/download-toasts';
import type { DownloadLifecycleEvent, DownloadRecord, DownloadStatus } from '../src/shared/types';

function record(status: DownloadStatus, overrides: Partial<DownloadRecord> = {}): DownloadRecord {
  return {
    id: 'download-1',
    fileName: 'archive.zip',
    status,
    error: '',
    errorCode: '',
    retryCount: 0,
    maxRetries: 5,
    ...overrides
  } as DownloadRecord;
}

function event(state: DownloadLifecycleEvent['state'], status: DownloadStatus, overrides: Partial<DownloadRecord> = {}): DownloadLifecycleEvent {
  return {
    id: 'download-1',
    state,
    record: record(status, overrides),
    at: '2026-01-01T00:00:00.000Z'
  };
}

describe('download lifecycle toasts', () => {
  it('announces a download when it starts transferring with an open action', () => {
    expect(downloadLifecycleToast(event('started', 'downloading'))).toEqual({
      type: 'info',
      title: 'Download started',
      message: 'archive.zip',
      dedupeKey: 'download:download-1:started',
      actions: [{ kind: 'focus-download', label: 'Open download', downloadId: 'download-1', details: false }]
    });
  });

  it('reports completion with open-file and details actions', () => {
    expect(downloadLifecycleToast(event('completed', 'completed'))).toMatchObject({
      type: 'success',
      title: 'Download complete',
      message: 'archive.zip',
      actions: [
        { kind: 'open-file', label: 'Open file', downloadId: 'download-1' },
        { kind: 'focus-download', label: 'Details', downloadId: 'download-1', details: true }
      ]
    });
  });

  it('includes the failure reason plus details and retry actions for transient errors', () => {
    expect(
      downloadLifecycleToast(
        event('failed', 'failed', {
          error: 'The network connection was interrupted. Retry to resume.',
          errorCode: 'NETWORK'
        })
      )
    ).toMatchObject({
      type: 'error',
      title: 'Download failed',
      message: 'archive.zip: The network connection was interrupted. Retry to resume.',
      actions: [
        { kind: 'retry-download', label: 'Retry', downloadId: 'download-1' },
        { kind: 'focus-download', label: 'Details', downloadId: 'download-1', details: true }
      ]
    });
  });

  it('omits retry for permanent failures and skips queued or cancelled events', () => {
    const permanent = downloadLifecycleToast(
      event('failed', 'failed', {
        error: 'Access denied (HTTP 403). The link may have expired.',
        errorCode: 'HTTP_403'
      })
    );
    expect(canManuallyRetry(record('failed', { errorCode: 'HTTP_403' }))).toBe(false);
    expect(canManuallyRetry(record('failed', { errorCode: 'DISK_FULL' }))).toBe(true);
    expect(canManuallyRetry(record('failed', { errorCode: 'TLS_CHAIN' }))).toBe(true);
    expect(permanent?.actions).toEqual([
      { kind: 'focus-download', label: 'Details', downloadId: 'download-1', details: true }
    ]);
    expect(downloadLifecycleToast(event('queued', 'queued'))).toBeNull();
    expect(downloadLifecycleToast(event('cancelled', 'canceled'))).toBeNull();
  });
});
