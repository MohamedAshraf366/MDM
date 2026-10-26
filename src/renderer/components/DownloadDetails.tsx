import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { DownloadRecord } from '../../shared/types';
import { formatBytes, formatDate, formatEta, formatPercent, formatSpeed } from '../../shared/format';
import { useApp } from '../app/store';
import { copyText } from '../lib/clipboard';
import { queueName } from '../lib/downloads';
import { FileGlyph, Button, ConfirmDialog, IconButton, ProgressBar, StatusBadge } from './Ui';

export function DownloadDetails({
  recordId,
  onClose,
  onEdit,
  onRequestRemove
}: {
  recordId: string;
  onClose: () => void;
  onEdit: (record: DownloadRecord) => void;
  onRequestRemove: (record: DownloadRecord) => void;
}) {
  const { snapshot, call, notify } = useApp();
  const record = snapshot?.downloads.find((item) => item.id === recordId) ?? null;
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const host = useMemo(() => {
    if (!record) return '';
    try {
      return new URL(record.finalUrl ?? record.url).hostname;
    } catch {
      return record.url;
    }
  }, [record]);

  if (!record) return null;

  const queue = snapshot?.queues.find((item) => item.id === record.queueId);
  const segments = record.segments.slice().sort((a, b) => a.index - b.index);
  const percent = formatPercent(record.downloadedBytes, record.totalBytes);

  const run = async (key: string, operation: Promise<{ ok: boolean; error?: string }>, success?: string) => {
    setBusy(key);
    const result = await call(operation, success);
    setBusy('');
    return result;
  };

  const verify = async () => {
    setBusy('verify');
    try {
      const result = await window.mdm.verifyDownload(record.id);
      if (!result.ok || !result.data) throw new Error(result.error ?? 'Verification failed.');
      if (result.data.checksumStatus === 'mismatch') {
        notify('error', 'Integrity check failed', 'The file does not match the saved checksum.');
      } else {
        notify('success', 'Integrity verified', `Algorithm: ${result.data.checksumAlgorithm || 'SHA-256'}`);
      }
    } catch (error) {
      notify('error', 'Could not verify file', (error as Error).message);
    } finally {
      setBusy('');
    }
  };

  const copy = async (value: string, label: string) => {
    try {
      await copyText(value);
      notify('success', `${label} copied`);
    } catch (error) {
      notify('error', 'Could not copy', (error as Error).message);
    }
  };

  return createPortal(
    <div className="drawer-layer" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Download details">
        <div className="drawer-head">
          <div className="drawer-title">
            <FileGlyph category={record.category} fileName={record.fileName} size="lg" />
            <div>
              <h2 title={record.fileName}>{record.fileName}</h2>
              <div className="drawer-subtitle">
                <StatusBadge status={record.status} />
                <span>{host}</span>
              </div>
            </div>
          </div>
          <IconButton icon="close" label="Close details" onClick={onClose} />
        </div>

        <div className="drawer-body">
          <section className="detail-progress">
            <div className="detail-progress-copy">
              <div>
                <strong>{record.status === 'completed' ? 'Download complete' : percent}</strong>
                <span>
                  {formatBytes(record.downloadedBytes)}
                  {record.totalBytes !== null ? ` of ${formatBytes(record.totalBytes)}` : ''}
                </span>
              </div>
              <div className="detail-speed">
                {record.status === 'downloading' ? (
                  <>
                    <strong>{formatSpeed(record.speedBps)}</strong>
                    <span>{formatEta(record.etaSeconds)} left</span>
                  </>
                ) : (
                  <>
                    <strong>{record.status === 'failed' ? 'Failed' : record.status === 'paused' ? 'Paused' : '—'}</strong>
                    <span>{record.error || (record.completedAt ? formatDate(record.completedAt) : '')}</span>
                  </>
                )}
              </div>
            </div>
            <ProgressBar downloaded={record.downloadedBytes} total={record.totalBytes} status={record.status} />
            <div className="detail-progress-meta">
              <span>{record.connections} connections</span>
              <span>{formatBytes(record.totalBytes)}</span>
              <span>{record.retryCount ? `${record.retryCount} retries` : 'No retries'}</span>
            </div>
          </section>

          {segments.length ? (
            <section className="detail-section">
              <h3>Segments</h3>
              <div className="segment-strip" aria-label="Download segments">
                {segments.map((segment) => {
                  const length = segment.endByte !== null ? segment.endByte - segment.startByte + 1 : 0;
                  const ratio = length > 0 ? Math.min(1, segment.downloadedBytes / length) : 0;
                  return (
                    <span
                      key={segment.index}
                      className={`segment-cell segment-${segment.status}`}
                      title={`Segment ${segment.index + 1} · ${Math.round(ratio * 100)}%`}
                    >
                      <span style={{ width: `${ratio * 100}%` }} />
                    </span>
                  );
                })}
              </div>
              <div className="segment-legend">
                <span><i className="legend-complete" />Complete</span>
                <span><i className="legend-active" />Active</span>
                <span><i className="legend-pending" />Pending</span>
              </div>
            </section>
          ) : null}

          <section className="detail-section">
            <div className="detail-section-head">
              <h3>Source</h3>
              <IconButton icon="copy" label="Copy download URL" onClick={() => void copy(record.url, 'URL')} />
            </div>
            <dl className="meta-grid">
              <div>
                <dt>Address</dt>
                <dd className="mono ellipsis" title={record.finalUrl ?? record.url}>{record.finalUrl ?? record.url}</dd>
              </div>
              {record.finalUrl && record.finalUrl !== record.url ? (
                <div>
                  <dt>Original URL</dt>
                  <dd className="mono ellipsis" title={record.url}>{record.url}</dd>
                </div>
              ) : null}
              <div>
                <dt>Saved to</dt>
                <dd className="ellipsis" title={record.targetPath ?? record.destinationDir}>
                  {record.targetPath ?? record.destinationDir}
                </dd>
              </div>
              <div>
                <dt>Queue</dt>
                <dd>{queue?.name ?? queueName(snapshot?.queues ?? [], record.queueId)}</dd>
              </div>
              <div>
                <dt>Type</dt>
                <dd>{record.mimeType || 'Unknown'}</dd>
              </div>
              <div>
                <dt>Added</dt>
                <dd>{formatDate(record.createdAt)}</dd>
              </div>
              {record.scheduledAt ? (
                <div>
                  <dt>Scheduled for</dt>
                  <dd>{formatDate(record.scheduledAt)}</dd>
                </div>
              ) : null}
              <div>
                <dt>Integrity</dt>
                <dd className={`integrity integrity-${record.checksumStatus}`}>
                  {record.checksumStatus === 'verified'
                    ? `Verified · ${record.checksumAlgorithm.toUpperCase()}`
                    : record.checksumStatus === 'mismatch'
                      ? 'Mismatch'
                      : record.checksumAlgorithm
                        ? `Expected ${record.checksumAlgorithm.toUpperCase()}`
                        : 'Not checked'}
                </dd>
              </div>
            </dl>
          </section>

          {record.recordLog.length ? (
            <section className="detail-section">
              <h3>Activity</h3>
              <ol className="record-log">
                {record.recordLog
                  .slice()
                  .reverse()
                  .map((entry, index) => (
                    <li key={`${entry.at}-${index}`} className={`log-${entry.level}`}>
                      <span className="log-time">{new Date(entry.at).toLocaleTimeString()}</span>
                      <span>{entry.message}</span>
                    </li>
                  ))}
              </ol>
            </section>
          ) : null}
        </div>

        <div className="drawer-footer">
          <div className="drawer-actions">
            {['connecting', 'downloading', 'queued', 'scheduled'].includes(record.status) ? (
              <Button icon="pause" loading={busy === 'pause'} onClick={() => void run('pause', window.mdm.pauseDownload(record.id), 'Download paused')}>
                Pause
              </Button>
            ) : null}
            {['paused', 'failed', 'canceled'].includes(record.status) ? (
              <Button
                variant="primary"
                icon="play"
                loading={busy === 'resume'}
                onClick={() => void run('resume', window.mdm.resumeDownload(record.id), 'Download resumed')}
              >
                Resume
              </Button>
            ) : null}
            {record.status === 'failed' || record.status === 'canceled' ? (
              <Button icon="refresh" loading={busy === 'retry'} onClick={() => void run('retry', window.mdm.retryDownload(record.id), 'Retrying download')}>
                Retry
              </Button>
            ) : null}
            {record.status === 'completed' ? (
              <>
                <Button variant="primary" icon="external" onClick={() => void run('open', window.mdm.openFile(record.id))}>
                  Open file
                </Button>
                <Button icon="folder" onClick={() => void run('folder', window.mdm.revealFile(record.id))}>
                  Show in folder
                </Button>
                <Button icon="shield" loading={busy === 'verify'} onClick={() => void verify()}>
                  Verify
                </Button>
              </>
            ) : null}
            {!['completed', 'canceled'].includes(record.status) ? (
              <Button icon="restart" onClick={() => setConfirmRestart(true)}>
                Restart
              </Button>
            ) : null}
          </div>
          <div className="drawer-actions-secondary">
            {!['completed', 'canceled', 'connecting', 'downloading', 'verifying', 'finalizing'].includes(record.status) ? (
              <Button variant="ghost" icon="edit" onClick={() => onEdit(record)}>
                Edit
              </Button>
            ) : null}
            {!['completed', 'canceled'].includes(record.status) ? (
              <Button
                variant="ghost"
                icon="close"
                loading={busy === 'cancel'}
                onClick={() => void run('cancel', window.mdm.cancelDownload(record.id), 'Download canceled')}
              >
                Cancel
              </Button>
            ) : null}
            <Button variant="ghost" icon="trash" onClick={() => onRequestRemove(record)}>
              Remove
            </Button>
          </div>
        </div>
      </aside>
      <ConfirmDialog
        open={confirmRestart}
        title="Restart download?"
        message="MDM will discard the current partial file and start from the beginning."
        confirmLabel="Restart"
        danger
        onCancel={() => setConfirmRestart(false)}
        onConfirm={() => {
          setConfirmRestart(false);
          void run('restart', window.mdm.restartDownload(record.id), 'Download restarted');
        }}
      />
    </div>,
    document.body
  );
}
