import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { DownloadRecord } from '../../shared/types';
import { formatBytes, formatDate, formatEta, formatPercent, formatSpeed } from '../../shared/format';
import { useApp } from '../app/store';
import {
  canPause,
  canResume,
  computeStats,
  filterAndSort,
  matchesFilter,
  queueName,
  type DownloadFilter,
  type DownloadSort
} from '../lib/downloads';
import {
  Button,
  ConfirmDialog,
  EmptyState,
  FileGlyph,
  IconButton,
  Modal,
  PageHeader,
  ProgressBar,
  Select,
  StatCard,
  StatusBadge,
  Tabs,
  TextInput,
  Toggle
} from '../components/Ui';
import { Icon } from '../components/Icons';
import { DownloadDetails } from '../components/DownloadDetails';
import { EditDownloadDialog } from '../components/EditDownloadDialog';

const FILTERS: Array<{ value: DownloadFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'queued', label: 'Queued' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' }
];

interface DownloadRowProps {
  record: DownloadRecord;
  selected: boolean;
  queue: string;
  onSelect: (id: string, selected: boolean) => void;
  onDetails: (id: string) => void;
  onPause: (record: DownloadRecord) => void;
  onResume: (record: DownloadRecord) => void;
  onOpen: (record: DownloadRecord) => void;
}

const DownloadRow = memo(function DownloadRow({
  record,
  selected,
  queue,
  onSelect,
  onDetails,
  onPause,
  onResume,
  onOpen
}: DownloadRowProps) {
  const quickAction = canPause(record)
    ? { icon: 'pause' as const, label: 'Pause', run: () => onPause(record) }
    : canResume(record)
      ? { icon: 'play' as const, label: 'Resume', run: () => onResume(record) }
      : { icon: 'folder' as const, label: 'Show in folder', run: () => onOpen(record) };
  return (
    <div
      className={`download-row ${selected ? 'is-selected' : ''}`.trim()}
      data-download-id={record.id}
      onClick={() => onDetails(record.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onDetails(record.id);
        }
      }}
    >
      <label className="checkbox" onClick={(event) => event.stopPropagation()}>
        <input
          type="checkbox"
          checked={selected}
          onChange={(event) => onSelect(record.id, event.target.checked)}
          aria-label={`Select ${record.fileName}`}
        />
        <span />
      </label>
      <div className="download-name">
        <FileGlyph category={record.category} fileName={record.fileName} />
        <div className="download-name-copy">
          <strong title={record.fileName}>{record.fileName}</strong>
          <span className="download-subline">
            <span className="host-label">{hostOf(record)}</span>
            <span className="dot-separator" />
            <span>{queue}</span>
            {record.priority === 'high' ? (
              <>
                <span className="dot-separator" />
                <span className="priority-label">High priority</span>
              </>
            ) : null}
          </span>
          {record.error ? (
            <span className="download-error" title={record.error}>
              <Icon name="alert" size={12} />
              {record.error}
            </span>
          ) : null}
        </div>
      </div>
      <div className="download-progress">
        <div className="download-progress-top">
          <span>{formatPercent(record.downloadedBytes, record.totalBytes)}</span>
          <small>
            {formatBytes(record.downloadedBytes)}
            {record.totalBytes !== null ? ` / ${formatBytes(record.totalBytes)}` : ''}
          </small>
        </div>
        <ProgressBar downloaded={record.downloadedBytes} total={record.totalBytes} status={record.status} compact />
      </div>
      <div className="download-transfer">
        {record.status === 'downloading' ? (
          <>
            <strong>{formatSpeed(record.speedBps)}</strong>
            <span>{formatEta(record.etaSeconds)} left</span>
          </>
        ) : record.status === 'completed' ? (
          <>
            <strong>{formatDate(record.completedAt)}</strong>
            <span>{record.checksumStatus === 'verified' ? 'Verified' : 'Complete'}</span>
          </>
        ) : record.status === 'scheduled' ? (
          <>
            <strong>{formatDate(record.scheduledAt)}</strong>
            <span>Scheduled</span>
          </>
        ) : (
          <>
            <StatusBadge status={record.status} />
            <span>{record.status === 'paused' ? 'Ready to resume' : '—'}</span>
          </>
        )}
      </div>
      <div className="download-actions" onClick={(event) => event.stopPropagation()}>
        <IconButton icon={quickAction.icon} label={quickAction.label} onClick={() => void quickAction.run()} />
        {record.status === 'completed' ? (
          <IconButton icon="folder" label="Show in folder" onClick={() => onOpen(record)} />
        ) : null}
        <IconButton icon="more" label="Details" onClick={() => onDetails(record.id)} />
      </div>
    </div>
  );
});

export function DownloadsPage() {
  const {
    snapshot,
    selected,
    setSelected,
    toggleSelected,
    clearSelection,
    openAddDialog,
    call,
    notify,
    focusTarget,
    clearFocusTarget
  } = useApp();
  const [filter, setFilter] = useState<DownloadFilter>('all');
  const [search, setSearch] = useState('');
  const [queueId, setQueueId] = useState('all');
  const [sort, setSort] = useState<DownloadSort>('created');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [detailsId, setDetailsId] = useState<string | null>(null);
  const [editRecord, setEditRecord] = useState<DownloadRecord | null>(null);
  const [removeTargets, setRemoveTargets] = useState<DownloadRecord[]>([]);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);

  const deferredSearch = useDeferredValue(search);
  const stableDownloads = snapshot?.downloads;
  const records = useMemo(() => stableDownloads ?? [], [stableDownloads]);
  const stats = useMemo(() => computeStats(records), [records]);
  const visible = useMemo(
    () => filterAndSort(records, { filter, queueId, search: deferredSearch, sort, direction }),
    [records, filter, queueId, deferredSearch, sort, direction]
  );
  const allVisibleSelected = visible.length > 0 && visible.every((record) => selected.has(record.id));
  const selectedRecords = records.filter((record) => selected.has(record.id));
  const detailsRecord = detailsId ? records.find((record) => record.id === detailsId) ?? null : null;

  const counts = useMemo(
    () => ({
      all: records.length,
      active: records.filter((record) => matchesFilter(record, 'active')).length,
      queued: records.filter((record) => matchesFilter(record, 'queued')).length,
      completed: records.filter((record) => record.status === 'completed').length,
      failed: records.filter((record) => matchesFilter(record, 'failed')).length
    }),
    [records]
  );

  useEffect(() => {
    if (!focusTarget) return;
    if (!records.some((record) => record.id === focusTarget.id)) return;
    setFilter('all');
    setSearch('');
    setQueueId('all');
    setSelected([focusTarget.id]);
    if (focusTarget.openDetails) setDetailsId(focusTarget.id);
  }, [focusTarget, records, setSelected]);

  // The page itself scrolls (`.page-scroll`), so the virtual window follows
  // that container instead of introducing a nested scrollbar.
  const listRef = useRef<HTMLDivElement>(null);
  const ROW_HEIGHT = 70; // matches .download-row height in styles.css
  const BUFFER = 5;
  const [viewport, setViewport] = useState({ top: 0, height: 800 });

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const scroller = list.closest('.page-scroll') as HTMLElement | null;
    const measure = () => {
      const listRect = list.getBoundingClientRect();
      const bounds = scroller
        ? scroller.getBoundingClientRect()
        : { top: 0, bottom: window.innerHeight };
      const top = Math.max(0, bounds.top - listRect.top);
      const bottom = Math.min(listRect.height, bounds.bottom - listRect.top);
      const height = Math.max(0, bottom - top);
      setViewport((current) =>
        Math.abs(current.top - top) < 0.5 && Math.abs(current.height - height) < 0.5
          ? current
          : { top, height }
      );
    };
    measure();
    scroller?.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    if (scroller) observer.observe(scroller);
    return () => {
      scroller?.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      observer.disconnect();
    };
  }, [visible.length]);

  const focusIndex = focusTarget ? visible.findIndex((record) => record.id === focusTarget.id) : -1;
  const windowRows = useMemo(() => {
    const first = Math.max(0, Math.floor(viewport.top / ROW_HEIGHT) - BUFFER);
    const last = Math.min(
      visible.length,
      Math.ceil((viewport.top + viewport.height) / ROW_HEIGHT) + BUFFER
    );
    const indices: number[] = [];
    for (let index = first; index < last; index += 1) indices.push(index);
    // Keep the focused row mounted even when it starts outside the viewport so
    // scrollIntoView can reach it without rendering the whole gap.
    if (focusIndex >= 0 && (focusIndex < first || focusIndex >= last)) {
      const focusFirst = Math.max(0, focusIndex - BUFFER);
      const focusLast = Math.min(visible.length, focusIndex + BUFFER + 1);
      for (let index = focusFirst; index < focusLast; index += 1) {
        if (!indices.includes(index)) indices.push(index);
      }
      indices.sort((a, b) => a - b);
    }
    return indices.map((index) => ({ index, record: visible[index]! }));
  }, [visible, viewport.top, viewport.height, focusIndex]);

  const focusReady = !!focusTarget && visible.some((record) => record.id === focusTarget.id);

  useEffect(() => {
    if (!focusTarget || !focusReady) return;
    const nonce = focusTarget.nonce;
    let clearTimer = 0;
    const frame = window.requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(
        `[data-download-id="${focusTarget.id}"]`
      );
      row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row?.focus({ preventScroll: true });
      // Keep the row mounted while the smooth scroll finishes.
      clearTimer = window.setTimeout(() => clearFocusTarget(nonce), 700);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(clearTimer);
    };
  }, [focusTarget, focusReady, clearFocusTarget]);

  const pauseOne = useCallback(
    async (record: DownloadRecord) => {
      await call(window.mdm.pauseDownload(record.id));
    },
    [call]
  );

  const resumeOne = useCallback(
    async (record: DownloadRecord) => {
      await call(window.mdm.resumeDownload(record.id), 'Download resumed');
    },
    [call]
  );

  const openOne = useCallback(
    async (record: DownloadRecord) => {
      if (record.status === 'completed') await call(window.mdm.openFile(record.id));
      else await call(window.mdm.openFolder(record.id));
    },
    [call]
  );

  const bulkAction = async (kind: 'pause' | 'resume' | 'cancel' | 'retry') => {
    if (!selectedRecords.length) return;
    setBulkBusy(true);
    let failures = 0;
    for (const record of selectedRecords) {
      const operation =
        kind === 'pause'
          ? window.mdm.pauseDownload(record.id)
          : kind === 'resume'
            ? window.mdm.resumeDownload(record.id)
            : kind === 'cancel'
              ? window.mdm.cancelDownload(record.id)
              : window.mdm.retryDownload(record.id);
      const result = await operation;
      if (!result.ok) failures++;
    }
    setBulkBusy(false);
    if (failures) notify('error', `${failures} operation${failures === 1 ? '' : 's'} failed`);
    else notify('success', `${selectedRecords.length} download${selectedRecords.length === 1 ? '' : 's'} updated`);
    clearSelection();
  };

  const removeSelected = async () => {
    if (!removeTargets.length) return;
    setBulkBusy(true);
    let failures = 0;
    for (const record of removeTargets) {
      const result = await window.mdm.removeDownload(record.id, deleteFiles);
      if (!result.ok) failures++;
    }
    setBulkBusy(false);
    if (failures) notify('error', `${failures} item${failures === 1 ? '' : 's'} could not be removed`);
    else {
      notify(
        'success',
        `${removeTargets.length} item${removeTargets.length === 1 ? '' : 's'} removed`,
        deleteFiles ? 'The associated files were deleted.' : undefined
      );
    }
    if (removeTargets.some((record) => record.id === detailsId)) setDetailsId(null);
    for (const record of removeTargets) toggleSelected(record.id, false);
    setRemoveTargets([]);
    setDeleteFiles(false);
  };

  const clearFinished = async () => {
    setConfirmClear(false);
    await call(window.mdm.clearCompleted(), 'Finished items cleared');
  };

  return (
    <div className="page downloads-page">
      <PageHeader
        eyebrow="Library"
        title="Downloads"
        description="Fast, resilient transfers with automatic recovery and smart categorization."
        actions={
          <>
            <Button icon="pause" onClick={() => void call(window.mdm.pauseAll(), 'All downloads paused')}>
              Pause all
            </Button>
            <Button icon="play" onClick={() => void call(window.mdm.resumeAll(), 'All downloads resumed')}>
              Resume all
            </Button>
            <Button variant="primary" icon="plus" onClick={openAddDialog}>
              New download
            </Button>
          </>
        }
      />

      <div className="stats-grid">
        <StatCard
          icon="activity"
          label="Active"
          value={String(stats.active)}
          detail={stats.active ? formatSpeed(stats.currentSpeed) : 'Nothing transferring'}
          tone="accent"
        />
        <StatCard
          icon="clock"
          label="In queue"
          value={String(stats.queued)}
          detail={`${records.filter((record) => record.status === 'scheduled').length} scheduled`}
          tone="blue"
        />
        <StatCard
          icon="arrow-down"
          label="Downloaded"
          value={formatBytes(stats.totalDownloaded)}
          detail={`${formatBytes(stats.totalBytes)} total`}
          tone="amber"
        />
        <StatCard
          icon="check-circle"
          label="Completed"
          value={String(stats.completed)}
          detail={stats.failed ? `${stats.failed} need attention` : 'No failures'}
          tone={stats.failed ? 'slate' : 'green'}
        />
      </div>

      <section className="downloads-panel">
        <div className="downloads-toolbar">
          <Tabs
            value={filter}
            onChange={setFilter}
            tabs={FILTERS.map((item) => ({ ...item, count: counts[item.value] }))}
          />
          <div className="toolbar-controls">
            <div className="search-input">
              <Icon name="search" size={16} />
              <TextInput
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search downloads"
                aria-label="Search downloads"
              />
              {search ? (
                <button type="button" className="search-clear" onClick={() => setSearch('')} aria-label="Clear search">
                  <Icon name="close" size={13} />
                </button>
              ) : null}
            </div>
            <Select value={queueId} onChange={(event) => setQueueId(event.target.value)} aria-label="Filter by queue">
              <option value="all">All queues</option>
              {snapshot?.queues.map((queue) => (
                <option key={queue.id} value={queue.id}>
                  {queue.name}
                </option>
              ))}
            </Select>
            <Select value={sort} onChange={(event) => setSort(event.target.value as DownloadSort)} aria-label="Sort downloads">
              <option value="created">Date added</option>
              <option value="name">Name</option>
              <option value="size">Size</option>
              <option value="progress">Progress</option>
              <option value="speed">Speed</option>
              <option value="status">Status</option>
              <option value="priority">Priority</option>
            </Select>
            <IconButton
              icon={direction === 'desc' ? 'arrow-down' : 'arrow-up'}
              label={direction === 'desc' ? 'Descending' : 'Ascending'}
              onClick={() => setDirection((value) => (value === 'desc' ? 'asc' : 'desc'))}
            />
          </div>
        </div>

        {selected.size > 0 ? (
          <div className="bulk-bar">
            <span className="bulk-count">
              {selected.size} selected
              <button type="button" className="text-button" onClick={clearSelection}>
                Clear
              </button>
            </span>
            <div className="bulk-actions">
              <Button size="sm" icon="pause" loading={bulkBusy} onClick={() => void bulkAction('pause')}>
                Pause
              </Button>
              <Button size="sm" icon="play" loading={bulkBusy} onClick={() => void bulkAction('resume')}>
                Resume
              </Button>
              <Button size="sm" icon="close" loading={bulkBusy} onClick={() => void bulkAction('cancel')}>
                Cancel
              </Button>
              <Button size="sm" icon="trash" variant="danger" onClick={() => setRemoveTargets(selectedRecords)}>
                Remove
              </Button>
            </div>
          </div>
        ) : null}

        {visible.length ? (
          <>
            <div className="download-list-head">
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={(event) =>
                    setSelected(event.target.checked ? visible.map((record) => record.id) : [])
                  }
                  aria-label="Select all visible downloads"
                />
                <span />
              </label>
              <span>Name</span>
              <span>Progress</span>
              <span>Transfer</span>
              <span className="align-right">Actions</span>
            </div>
            <div className="download-list" ref={listRef}>
              <div style={{ height: visible.length * ROW_HEIGHT, position: 'relative' }}>
                {windowRows.map(({ index, record }) => (
                  <div
                    key={record.id}
                    style={{ position: 'absolute', top: index * ROW_HEIGHT, left: 0, right: 0 }}
                  >
                    <DownloadRow
                      record={record}
                      selected={selected.has(record.id)}
                      queue={queueName(snapshot?.queues ?? [], record.queueId)}
                      onSelect={toggleSelected}
                      onDetails={setDetailsId}
                      onPause={pauseOne}
                      onResume={resumeOne}
                      onOpen={openOne}
                    />
                  </div>
                ))}
              </div>
            </div>
            <div className="download-list-footer">
              <span>
                {visible.length} of {records.length} downloads
              </span>
              <div className="footer-actions">
                {stats.completed + records.filter((record) => record.status === 'canceled').length > 0 ? (
                  <button type="button" className="text-button" onClick={() => setConfirmClear(true)}>
                    Clear finished
                  </button>
                ) : null}
              </div>
            </div>
          </>
        ) : (
          <EmptyState
            icon={filter === 'all' ? 'download' : 'filter'}
            title={records.length ? 'No downloads match these filters' : 'Your download queue is empty'}
            description={
              records.length
                ? 'Try another status, queue, or search term.'
                : 'Add a direct link, a media stream, or send a download from your browser.'
            }
            action={
              records.length ? (
                <Button
                  onClick={() => {
                    setFilter('all');
                    setSearch('');
                    setQueueId('all');
                  }}
                >
                  Reset filters
                </Button>
              ) : (
                <Button variant="primary" icon="plus" onClick={openAddDialog}>
                  Add your first download
                </Button>
              )
            }
          />
        )}
      </section>

      {detailsRecord ? (
        <DownloadDetails
          recordId={detailsRecord.id}
          onClose={() => setDetailsId(null)}
          onEdit={(record) => setEditRecord(record)}
          onRequestRemove={(record) => setRemoveTargets([record])}
        />
      ) : null}

      <EditDownloadDialog
        record={editRecord}
        open={Boolean(editRecord)}
        onClose={() => setEditRecord(null)}
      />

      <Modal
        open={removeTargets.length > 0}
        onClose={() => {
          setRemoveTargets([]);
          setDeleteFiles(false);
        }}
        title={removeTargets.length === 1 ? 'Remove download?' : `Remove ${removeTargets.length} downloads?`}
        subtitle={
          removeTargets.some((record) => !['completed', 'canceled'].includes(record.status))
            ? 'Active transfers will be canceled before they are removed.'
            : 'This removes the entries from your download history.'
        }
        width={460}
        footer={
          <>
            <Button
              onClick={() => {
                setRemoveTargets([]);
                setDeleteFiles(false);
              }}
            >
              Cancel
            </Button>
            <Button variant="danger" icon="trash" loading={bulkBusy} onClick={() => void removeSelected()}>
              Remove
            </Button>
          </>
        }
      >
        <div className="remove-summary">
          {removeTargets.slice(0, 4).map((record) => (
            <div key={record.id} className="remove-item">
              <FileGlyph category={record.category} size="sm" />
              <span>{record.fileName}</span>
            </div>
          ))}
          {removeTargets.length > 4 ? <span className="muted">and {removeTargets.length - 4} more</span> : null}
        </div>
        <div className="setting-row">
          <div>
            <strong>Delete downloaded files</strong>
            <p>Permanently delete the finished file and any temporary part file.</p>
          </div>
          <Toggle checked={deleteFiles} onChange={setDeleteFiles} label="Delete downloaded files" />
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmClear}
        title="Clear finished downloads?"
        message="Completed and canceled entries will be removed from the list. Files already saved to disk are kept."
        confirmLabel="Clear finished"
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => void clearFinished()}
      />
    </div>
  );
}

function hostOf(record: DownloadRecord): string {
  try {
    return new URL(record.finalUrl ?? record.url).hostname;
  } catch {
    return record.url;
  }
}
