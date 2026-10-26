import { useEffect, useRef, useState } from 'react';
import type { QueueCompletionAction, QueueInput, QueueRecord } from '../../shared/types';
import { formatBytes, formatSpeed, parseByteSize } from '../../shared/format';
import { useApp } from '../app/store';
import { downloadTextFile, readTextFile } from '../lib/files';
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  IconButton,
  InlineNote,
  Modal,
  PageHeader,
  ProgressBar,
  Select,
  TextInput
} from '../components/Ui';
import { Icon } from '../components/Icons';

export function QueuesPage() {
  const { snapshot, call, notify } = useApp();
  const [editor, setEditor] = useState<QueueRecord | 'new' | null>(null);
  const [removeTarget, setRemoveTarget] = useState<QueueRecord | null>(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const queues = snapshot?.queues ?? [];
  const downloads = snapshot?.downloads ?? [];

  const exportQueues = async () => {
    const result = await window.mdm.exportQueue();
    if (!result.ok || !result.data) {
      notify('error', 'Could not export queues', result.error);
      return;
    }
    downloadTextFile(`mdm-queues-${new Date().toISOString().slice(0, 10)}.json`, result.data);
    notify('success', 'Queue configuration exported');
  };

  const importQueues = async (file: File | undefined) => {
    if (!file) return;
    setImporting(true);
    try {
      const text = await readTextFile(file);
      const result = await call(window.mdm.importQueue(text), 'Queue configuration imported');
      if (result !== null) notify('info', 'Import complete', `${result} item${result === 1 ? '' : 's'} added.`);
    } finally {
      setImporting(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="Automation"
        title="Queues"
        description="Group transfers, control concurrency, and decide what happens when a queue finishes."
        actions={
          <>
            <Button icon="upload" onClick={() => fileRef.current?.click()} loading={importing}>
              Import
            </Button>
            <Button icon="download" onClick={() => void exportQueues()}>
              Export
            </Button>
            <Button variant="primary" icon="plus" onClick={() => setEditor('new')}>
              New queue
            </Button>
          </>
        }
      />

      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(event) => void importQueues(event.target.files?.[0])}
      />

      {queues.length ? (
        <div className="queue-grid">
          {queues.map((queue) => {
            const queueDownloads = downloads.filter((record) => record.queueId === queue.id);
            const active = queueDownloads.filter((record) =>
              ['connecting', 'downloading', 'verifying', 'finalizing'].includes(record.status)
            ).length;
            const complete = queueDownloads.filter((record) => record.status === 'completed').length;
            const failed = queueDownloads.filter((record) => record.status === 'failed').length;
            const queued = queueDownloads.filter((record) => ['queued', 'scheduled'].includes(record.status)).length;
            const totalBytes = queueDownloads.reduce((sum, record) => sum + (record.totalBytes ?? 0), 0);
            const downloadedBytes = queueDownloads.reduce((sum, record) => sum + record.downloadedBytes, 0);
            return (
              <Card key={queue.id} className={`queue-card ${queue.status === 'paused' ? 'is-paused' : ''}`.trim()}>
                <div className="queue-head">
                  <div className="queue-title">
                    <span className={`queue-status ${queue.status}`}>
                      <span />
                    </span>
                    <div>
                      <h2>
                        {queue.name}
                        {queue.isDefault ? <span className="mini-badge">Default</span> : null}
                      </h2>
                      <p>
                        {queue.status === 'active' ? 'Accepting downloads' : 'Paused'} · Priority {queue.priority}
                      </p>
                    </div>
                  </div>
                  <div className="queue-head-actions">
                    <IconButton
                      icon={queue.status === 'active' ? 'pause' : 'play'}
                      label={queue.status === 'active' ? 'Stop queue' : 'Start queue'}
                      onClick={() =>
                        void call(
                          queue.status === 'active'
                            ? window.mdm.stopQueue(queue.id)
                            : window.mdm.startQueue(queue.id),
                          queue.status === 'active' ? 'Queue stopped' : 'Queue started'
                        )
                      }
                    />
                    <IconButton icon="edit" label="Edit queue" onClick={() => setEditor(queue)} />
                    {!queue.isDefault ? (
                      <IconButton icon="trash" label="Delete queue" variant="danger" onClick={() => setRemoveTarget(queue)} />
                    ) : null}
                  </div>
                </div>

                <div className="queue-stats">
                  <div>
                    <span>Downloads</span>
                    <strong>{queueDownloads.length}</strong>
                  </div>
                  <div>
                    <span>Active</span>
                    <strong>{active}</strong>
                  </div>
                  <div>
                    <span>Queued</span>
                    <strong>{queued}</strong>
                  </div>
                  <div>
                    <span>Finished</span>
                    <strong>{complete}</strong>
                  </div>
                </div>

                <div className="queue-progress">
                  <div className="queue-progress-labels">
                    <span>{formatBytes(downloadedBytes)} of {formatBytes(totalBytes)}</span>
                    <span>{failed ? `${failed} failed` : queue.speedLimitBps ? `${formatSpeed(queue.speedLimitBps)} cap` : 'No speed cap'}</span>
                  </div>
                  <ProgressBar downloaded={downloadedBytes} total={totalBytes || null} status={active ? 'downloading' : 'completed'} />
                </div>

                <div className="queue-foot">
                  <span>
                    <Icon name="server" size={14} />
                    {queue.maxConcurrent ? `${queue.maxConcurrent} at once` : 'Unlimited concurrency'}
                  </span>
                  <span>
                    <Icon name="clock" size={14} />
                    {queue.onComplete === 'none'
                      ? 'No action'
                      : queue.onComplete === 'notify'
                        ? 'Notify when done'
                        : 'Shut down when done'}
                  </span>
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <Card>
          <EmptyState
            icon="queue"
            title="No queues yet"
            description="Create a queue to control how many downloads run and when."
            action={
              <Button variant="primary" icon="plus" onClick={() => setEditor('new')}>
                Create a queue
              </Button>
            }
          />
        </Card>
      )}

      <Card className="queue-help" title="How queues work">
        <div className="feature-row">
          <div className="feature">
            <span className="feature-icon"><Icon name="server" size={18} /></span>
            <div>
              <strong>Concurrency is scoped</strong>
              <p>Each queue can limit how many transfers run at once while the global limit still applies.</p>
            </div>
          </div>
          <div className="feature">
            <span className="feature-icon"><Icon name="zap" size={18} /></span>
            <div>
              <strong>Priority wins</strong>
              <p>High-priority items and higher-priority queues are picked first when capacity opens.</p>
            </div>
          </div>
          <div className="feature">
            <span className="feature-icon"><Icon name="shield" size={18} /></span>
            <div>
              <strong>Finish safely</strong>
              <p>Shutdown actions only run after a queue is empty with no failed transfers.</p>
            </div>
          </div>
        </div>
      </Card>

      <QueueEditor
        target={editor}
        onClose={() => setEditor(null)}
        onSaved={() => setEditor(null)}
      />

      <ConfirmDialog
        open={Boolean(removeTarget)}
        title="Delete queue?"
        message={`Downloads in "${removeTarget?.name ?? ''}" will be moved to the default queue. The queue settings will be removed.`}
        confirmLabel="Delete queue"
        danger
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => {
          const target = removeTarget;
          setRemoveTarget(null);
          if (target) void call(window.mdm.deleteQueue(target.id), 'Queue deleted');
        }}
      />
    </div>
  );
}

function QueueEditor({
  target,
  onClose,
  onSaved
}: {
  target: QueueRecord | 'new' | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { notify } = useApp();
  const [name, setName] = useState('');
  const [priority, setPriority] = useState('0');
  const [maxConcurrent, setMaxConcurrent] = useState('0');
  const [speedLimit, setSpeedLimit] = useState('');
  const [onComplete, setOnComplete] = useState<QueueCompletionAction>('none');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setError('');
    if (target && target !== 'new') {
      setName(target.name);
      setPriority(String(target.priority));
      setMaxConcurrent(String(target.maxConcurrent));
      setSpeedLimit(target.speedLimitBps ? String(Math.round(target.speedLimitBps / 1024)) : '');
      setOnComplete(target.onComplete);
    } else if (target === 'new') {
      setName('');
      setPriority('0');
      setMaxConcurrent('0');
      setSpeedLimit('');
      setOnComplete('none');
    }
  }, [target]);

  const save = async () => {
    setError('');
    if (!name.trim()) {
      setError('Give this queue a name.');
      return;
    }
    setSaving(true);
    try {
      const input: QueueInput = {
        name: name.trim(),
        priority: Number(priority) || 0,
        maxConcurrent: Number(maxConcurrent) || 0,
        speedLimitBps: speedLimit.trim() ? Math.max(0, parseByteSize(`${speedLimit} KB`) ?? 0) : 0,
        onComplete
      };
      if (target && target !== 'new') input.id = target.id;
      const result = await window.mdm.saveQueue(input);
      if (!result.ok) throw new Error(result.error ?? 'The queue could not be saved.');
      notify('success', target === 'new' ? 'Queue created' : 'Queue updated');
      onSaved();
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={Boolean(target)}
      onClose={onClose}
      title={target === 'new' ? 'Create queue' : 'Edit queue'}
      subtitle="Queue limits stack on top of the global download settings."
      width={560}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="check" loading={saving} onClick={() => void save()}>
            {target === 'new' ? 'Create queue' : 'Save changes'}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Queue name" className="span-2">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Overnight" />
        </Field>
        <Field label="Priority" hint="Higher values are picked first.">
          <TextInput
            type="number"
            min={-100}
            max={100}
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
          />
        </Field>
        <Field label="Concurrent downloads" hint="0 means unlimited within the global limit.">
          <TextInput
            type="number"
            min={0}
            max={20}
            value={maxConcurrent}
            onChange={(event) => setMaxConcurrent(event.target.value)}
          />
        </Field>
        <Field label="Queue speed limit" hint="KB/s. Leave blank for no extra cap." className="span-2">
          <TextInput
            type="number"
            min={0}
            placeholder="Unlimited"
            value={speedLimit}
            onChange={(event) => setSpeedLimit(event.target.value)}
          />
        </Field>
        <Field label="When the queue finishes" className="span-2">
          <Select value={onComplete} onChange={(event) => setOnComplete(event.target.value as QueueCompletionAction)}>
            <option value="none">Do nothing</option>
            <option value="notify">Show a notification</option>
            <option value="shutdown">Shut down the computer</option>
          </Select>
        </Field>
      </div>
      {onComplete === 'shutdown' ? (
        <InlineNote tone="warning">
          Windows will begin shutting down after every download in this queue completes successfully. Windows gives
          you a 60-second warning.
        </InlineNote>
      ) : null}
      {error ? <InlineNote tone="danger">{error}</InlineNote> : null}
    </Modal>
  );
}
