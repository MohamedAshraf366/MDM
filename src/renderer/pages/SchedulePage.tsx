import { useEffect, useState } from 'react';
import type { ScheduleAction, ScheduleInput, ScheduleRecord } from '../../shared/types';
import { daysLabel, formatDate, formatTime12 } from '../../shared/format';
import { nextScheduleTime } from '../../shared/validation';
import { useApp } from '../app/store';
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
  Select,
  TextInput,
  Toggle
} from '../components/Ui';
import { Icon } from '../components/Icons';

const DAYS = [
  { value: 1, short: 'M', label: 'Monday' },
  { value: 2, short: 'T', label: 'Tuesday' },
  { value: 3, short: 'W', label: 'Wednesday' },
  { value: 4, short: 'T', label: 'Thursday' },
  { value: 5, short: 'F', label: 'Friday' },
  { value: 6, short: 'S', label: 'Saturday' },
  { value: 0, short: 'S', label: 'Sunday' }
];

const ACTION_LABELS: Record<ScheduleAction, string> = {
  start_queue: 'Start queue',
  stop_queue: 'Stop queue',
  start_all: 'Resume everything',
  pause_all: 'Pause everything'
};

export function SchedulePage() {
  const { snapshot, call } = useApp();
  const [editor, setEditor] = useState<ScheduleRecord | 'new' | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ScheduleRecord | null>(null);
  const schedules = snapshot?.schedules.slice().sort((a, b) => Number(b.enabled) - Number(a.enabled)) ?? [];
  const enabled = schedules.filter((schedule) => schedule.enabled).length;

  const toggle = async (schedule: ScheduleRecord) => {
    const input = toInput(schedule);
    input.enabled = !schedule.enabled;
    await call(window.mdm.saveSchedule(input), schedule.enabled ? 'Schedule disabled' : 'Schedule enabled');
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="Automation"
        title="Schedule"
        description="Run queues at the times that suit your connection, or pause everything after hours."
        actions={
          <Button variant="primary" icon="plus" onClick={() => setEditor('new')}>
            New schedule
          </Button>
        }
      />

      <div className="schedule-overview">
        <div className="schedule-overview-copy">
          <span className="schedule-orbit">
            <Icon name="calendar" size={22} />
          </span>
          <div>
            <strong>{enabled} active rule{enabled === 1 ? '' : 's'}</strong>
            <p>
              MDM checks schedules every 10 seconds. If the app was asleep, it catches up on the last two
              minutes of events.
            </p>
          </div>
        </div>
        <div className="schedule-time">
          <span>Local time</span>
          <strong>{new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</strong>
        </div>
      </div>

      {schedules.length ? (
        <div className="schedule-list">
          {schedules.map((schedule) => {
            const next = schedule.enabled ? nextScheduleTime(schedule) : null;
            const queue = snapshot?.queues.find((item) => item.id === schedule.queueId);
            return (
              <article key={schedule.id} className={`schedule-card ${schedule.enabled ? '' : 'is-disabled'}`.trim()}>
                <div className="schedule-rail">
                  <span className={`schedule-dot ${schedule.enabled ? 'is-on' : ''}`} />
                  <span className="schedule-rail-line" />
                </div>
                <div className="schedule-main">
                  <div className="schedule-head">
                    <div>
                      <h2>{schedule.name}</h2>
                      <p>
                        {ACTION_LABELS[schedule.action]}
                        {queue ? ` · ${queue.name}` : schedule.action.endsWith('_all') ? '' : ' · No queue'}
                      </p>
                    </div>
                    <div className="schedule-head-actions">
                      <Toggle checked={schedule.enabled} onChange={() => void toggle(schedule)} label={`Enable ${schedule.name}`} />
                      <IconButton icon="edit" label="Edit schedule" onClick={() => setEditor(schedule)} />
                      <IconButton
                        icon="trash"
                        label="Delete schedule"
                        variant="danger"
                        onClick={() => setRemoveTarget(schedule)}
                      />
                    </div>
                  </div>
                  <div className="schedule-days">
                    {DAYS.map((day) => (
                      <span key={day.value} className={schedule.days.includes(day.value) ? 'is-on' : ''} title={day.label}>
                        {day.short}
                      </span>
                    ))}
                  </div>
                  <div className="schedule-facts">
                    <span>
                      <Icon name="clock" size={15} />
                      {formatTime12(schedule.startTime)} – {schedule.stopTime ? formatTime12(schedule.stopTime) : 'no stop'}
                    </span>
                    <span>
                      <Icon name="calendar" size={15} />
                      {daysLabel(schedule.days)}
                    </span>
                    <span className={`schedule-next ${next ? '' : 'is-empty'}`.trim()}>
                      <Icon name="zap" size={15} />
                      {next ? `Next ${formatDate(next.toISOString())}` : 'No upcoming run'}
                    </span>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <Card>
          <EmptyState
            icon="calendar"
            title="No schedules yet"
            description="Set a recurring time to start a queue overnight or pause transfers during work hours."
            action={
              <Button variant="primary" icon="plus" onClick={() => setEditor('new')}>
                Create your first schedule
              </Button>
            }
          />
        </Card>
      )}

      <InlineNote tone="info">
        Schedules use your current local time zone. A stop time before the start time is treated as the next morning.
      </InlineNote>

      <ScheduleEditor target={editor} onClose={() => setEditor(null)} onSaved={() => setEditor(null)} />

      <ConfirmDialog
        open={Boolean(removeTarget)}
        title="Delete schedule?"
        message={`"${removeTarget?.name ?? ''}" will no longer run automatically.`}
        confirmLabel="Delete schedule"
        danger
        onCancel={() => setRemoveTarget(null)}
        onConfirm={() => {
          const target = removeTarget;
          setRemoveTarget(null);
          if (target) void call(window.mdm.deleteSchedule(target.id), 'Schedule deleted');
        }}
      />
    </div>
  );
}

function ScheduleEditor({
  target,
  onClose,
  onSaved
}: {
  target: ScheduleRecord | 'new' | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { snapshot, notify } = useApp();
  const [name, setName] = useState('');
  const [action, setAction] = useState<ScheduleAction>('start_all');
  const [queueId, setQueueId] = useState('');
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [startTime, setStartTime] = useState('09:00');
  const [stopTime, setStopTime] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const defaultQueueId = snapshot?.queues.find((queue) => queue.isDefault)?.id ?? snapshot?.queues[0]?.id ?? '';

  useEffect(() => {
    if (!target) return;
    setError('');
    if (target === 'new') {
      setName('Weekday downloads');
      setAction('start_all');
      setQueueId(defaultQueueId);
      setDays([1, 2, 3, 4, 5]);
      setStartTime('09:00');
      setStopTime('');
      setEnabled(true);
    } else {
      setName(target.name);
      setAction(target.action);
      setQueueId(target.queueId ?? '');
      setDays(target.days);
      setStartTime(target.startTime);
      setStopTime(target.stopTime);
      setEnabled(target.enabled);
    }
  }, [target, defaultQueueId]);

  const needsQueue = action === 'start_queue' || action === 'stop_queue';

  const toggleDay = (day: number) => {
    setDays((current) => (current.includes(day) ? current.filter((value) => value !== day) : [...current, day].sort()));
  };

  const save = async () => {
    setError('');
    if (!name.trim()) {
      setError('Give this schedule a name.');
      return;
    }
    if (!days.length) {
      setError('Select at least one day.');
      return;
    }
    if (!startTime) {
      setError('Choose a start time.');
      return;
    }
    if (needsQueue && !queueId) {
      setError('Choose a queue for this action.');
      return;
    }
    setSaving(true);
    try {
      const input: ScheduleInput = {
        name: name.trim(),
        action,
        queueId: needsQueue ? queueId : null,
        days,
        startTime,
        stopTime,
        enabled
      };
      if (target && target !== 'new') input.id = target.id;
      const result = await window.mdm.saveSchedule(input);
      if (!result.ok) throw new Error(result.error ?? 'The schedule could not be saved.');
      notify('success', target === 'new' ? 'Schedule created' : 'Schedule updated');
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
      title={target === 'new' ? 'New schedule' : 'Edit schedule'}
      subtitle="Times are local. Leave the stop time empty for a one-way action."
      width={620}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon="check" loading={saving} onClick={() => void save()}>
            Save schedule
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Schedule name" className="span-2">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Overnight window" />
        </Field>
        <Field label="Action">
          <Select value={action} onChange={(event) => setAction(event.target.value as ScheduleAction)}>
            <option value="start_all">Resume everything</option>
            <option value="pause_all">Pause everything</option>
            <option value="start_queue">Start a queue</option>
            <option value="stop_queue">Stop a queue</option>
          </Select>
        </Field>
        <Field label="Queue" hint={needsQueue ? undefined : 'Only used by queue actions.'}>
          <Select value={queueId} onChange={(event) => setQueueId(event.target.value)} disabled={!needsQueue}>
            <option value="">Choose a queue…</option>
            {snapshot?.queues.map((queue) => (
              <option key={queue.id} value={queue.id}>
                {queue.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Start time">
          <TextInput type="time" value={startTime} onChange={(event) => setStartTime(event.target.value)} />
        </Field>
        <Field label="Stop time" hint="Optional. Earlier than start means the next day.">
          <TextInput type="time" value={stopTime} onChange={(event) => setStopTime(event.target.value)} />
        </Field>
        <div className="field span-2">
          <span className="field-label">Days</span>
          <div className="day-picker">
            {DAYS.map((day) => (
              <button
                key={day.value}
                type="button"
                className={days.includes(day.value) ? 'is-on' : ''}
                onClick={() => toggleDay(day.value)}
                aria-pressed={days.includes(day.value)}
              >
                {day.label.slice(0, 3)}
              </button>
            ))}
          </div>
          <div className="day-presets">
            <button type="button" className="text-button" onClick={() => setDays([1, 2, 3, 4, 5])}>
              Weekdays
            </button>
            <button type="button" className="text-button" onClick={() => setDays([0, 6])}>
              Weekends
            </button>
            <button type="button" className="text-button" onClick={() => setDays([0, 1, 2, 3, 4, 5, 6])}>
              Every day
            </button>
          </div>
        </div>
        <div className="setting-row span-2">
          <div>
            <strong>Enable this schedule</strong>
            <p>You can turn it off temporarily without deleting it.</p>
          </div>
          <Toggle checked={enabled} onChange={setEnabled} label="Enable schedule" />
        </div>
      </div>
      {error ? <InlineNote tone="danger">{error}</InlineNote> : null}
    </Modal>
  );
}

function toInput(schedule: ScheduleRecord): ScheduleInput {
  return {
    id: schedule.id,
    name: schedule.name,
    queueId: schedule.queueId,
    action: schedule.action,
    days: schedule.days,
    startTime: schedule.startTime,
    stopTime: schedule.stopTime,
    enabled: schedule.enabled
  };
}
