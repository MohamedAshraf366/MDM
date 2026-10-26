import type { DownloadRecord, QueueRecord } from '../../shared/types';

export type DownloadFilter = 'all' | 'active' | 'queued' | 'completed' | 'failed';
export type DownloadSort = 'created' | 'name' | 'size' | 'progress' | 'speed' | 'status' | 'priority';

const ACTIVE = new Set(['connecting', 'downloading', 'verifying', 'finalizing', 'paused']);
const QUEUED = new Set(['queued', 'scheduled']);
const FAILED = new Set(['failed', 'canceled']);

export function matchesFilter(record: DownloadRecord, filter: DownloadFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'active') return ACTIVE.has(record.status);
  if (filter === 'queued') return QUEUED.has(record.status);
  if (filter === 'completed') return record.status === 'completed';
  return FAILED.has(record.status);
}

export function filterAndSort(
  records: DownloadRecord[],
  options: {
    filter: DownloadFilter;
    queueId: string;
    search: string;
    sort: DownloadSort;
    direction: 'asc' | 'desc';
  }
): DownloadRecord[] {
  const query = options.search.trim().toLowerCase();
  const filtered = records.filter((record) => {
    if (!matchesFilter(record, options.filter)) return false;
    if (options.queueId !== 'all' && record.queueId !== options.queueId) return false;
    if (!query) return true;
    return (
      record.fileName.toLowerCase().includes(query) ||
      record.url.toLowerCase().includes(query) ||
      record.finalUrl?.toLowerCase().includes(query) ||
      record.category.toLowerCase().includes(query)
    );
  });
  const direction = options.direction === 'asc' ? 1 : -1;
  return filtered.sort((a, b) => compare(a, b, options.sort) * direction);
}

function compare(a: DownloadRecord, b: DownloadRecord, sort: DownloadSort): number {
  if (sort === 'name') return a.fileName.localeCompare(b.fileName);
  if (sort === 'size') return (a.totalBytes ?? 0) - (b.totalBytes ?? 0);
  if (sort === 'speed') return (a.speedBps ?? 0) - (b.speedBps ?? 0);
  if (sort === 'progress') {
    const ar = a.totalBytes ? a.downloadedBytes / a.totalBytes : 0;
    const br = b.totalBytes ? b.downloadedBytes / b.totalBytes : 0;
    return ar - br;
  }
  if (sort === 'status') return a.status.localeCompare(b.status);
  if (sort === 'priority') {
    const score = (value: DownloadRecord['priority']): number => (value === 'high' ? 2 : value === 'low' ? 0 : 1);
    return score(a.priority) - score(b.priority);
  }
  return a.createdAt.localeCompare(b.createdAt);
}

export function queueName(queues: QueueRecord[], queueId: string): string {
  return queues.find((queue) => queue.id === queueId)?.name ?? 'Default';
}

export function computeStats(records: DownloadRecord[]) {
  let active = 0;
  let queued = 0;
  let completed = 0;
  let failed = 0;
  let totalBytes = 0;
  let totalDownloaded = 0;
  let currentSpeed = 0;
  for (const record of records) {
    if (['connecting', 'downloading', 'verifying', 'finalizing'].includes(record.status)) active++;
    else if (['queued', 'scheduled'].includes(record.status)) queued++;
    else if (record.status === 'completed') completed++;
    else if (['failed', 'canceled'].includes(record.status)) failed++;
    totalBytes += record.totalBytes ?? 0;
    totalDownloaded += record.downloadedBytes ?? 0;
    currentSpeed += record.speedBps || 0;
  }
  return { active, queued, completed, failed, totalBytes, totalDownloaded, currentSpeed };
}

export function canPause(record: DownloadRecord): boolean {
  return ['queued', 'scheduled', 'connecting', 'downloading'].includes(record.status);
}

export function canResume(record: DownloadRecord): boolean {
  return ['paused', 'failed', 'canceled'].includes(record.status);
}

export function canCancel(record: DownloadRecord): boolean {
  return !['completed', 'canceled'].includes(record.status);
}

export function statusGroup(status: DownloadRecord['status']): string {
  if (ACTIVE.has(status)) return 'Active';
  if (QUEUED.has(status)) return 'Queued';
  if (status === 'completed') return 'Completed';
  if (FAILED.has(status)) return 'Failed';
  return 'Other';
}
