import { useMemo, useState } from 'react';
import type { LogRecord } from '../../shared/types';
import { formatDate } from '../../shared/format';
import { useApp } from '../app/store';
import { copyText } from '../lib/clipboard';
import { downloadTextFile } from '../lib/files';
import { Button, ConfirmDialog, EmptyState, IconButton, PageHeader, Select, TextInput } from '../components/Ui';
import { Icon } from '../components/Icons';

type LevelFilter = 'all' | LogRecord['level'];

export function LogsPage() {
  const { logs, refreshLogs, clearLogs, notify } = useApp();
  const [query, setQuery] = useState('');
  const [level, setLevel] = useState<LevelFilter>('all');
  const [scope, setScope] = useState('all');
  const [refreshing, setRefreshing] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);

  const scopes = useMemo(() => Array.from(new Set(logs.map((log) => log.scope))).sort(), [logs]);
  const counts = useMemo(
    () => ({
      errors: logs.filter((log) => log.level === 'error').length,
      warnings: logs.filter((log) => log.level === 'warn').length
    }),
    [logs]
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return logs.filter((log) => {
      if (level !== 'all' && log.level !== level) return false;
      if (scope !== 'all' && log.scope !== scope) return false;
      if (!needle) return true;
      return (
        log.message.toLowerCase().includes(needle) ||
        log.scope.toLowerCase().includes(needle) ||
        log.detail.toLowerCase().includes(needle)
      );
    });
  }, [logs, level, query, scope]);

  const refresh = async () => {
    setRefreshing(true);
    await refreshLogs();
    setRefreshing(false);
  };

  const exportLogs = () => {
    if (!filtered.length) {
      notify('info', 'Nothing to export', 'No log entries match the current filters.');
      return;
    }
    const lines = filtered.map(
      (log) =>
        `${log.timestamp} [${log.level.toUpperCase()}] ${log.scope}: ${log.message}${log.detail ? `\n  ${log.detail}` : ''}`
    );
    downloadTextFile(
      `mdm-activity-${new Date().toISOString().slice(0, 10)}.log`,
      lines.join('\n'),
      'text/plain'
    );
    notify('success', 'Activity log exported', `${filtered.length} entries written.`);
  };

  return (
    <div className="page logs-page">
      <PageHeader
        eyebrow="Diagnostics"
        title="Activity log"
        description="Follow transfer events, bridge requests, and application messages in real time."
        actions={
          <>
            <Button icon="refresh" loading={refreshing} onClick={() => void refresh()}>
              Refresh
            </Button>
            <Button icon="download" onClick={exportLogs}>
              Export
            </Button>
            <Button variant="danger" icon="trash" onClick={() => setClearOpen(true)} disabled={!logs.length}>
              Clear
            </Button>
          </>
        }
      />

      <div className="log-summary">
        <div className="log-summary-main">
          <span className="log-summary-icon">
            <Icon name="activity" size={19} />
          </span>
          <div>
            <strong>{logs.length} entries</strong>
            <p>Showing the most recent events first. New events appear automatically.</p>
          </div>
        </div>
        <div className="log-pills">
          <span className={`log-pill log-pill-error ${counts.errors ? 'is-active' : ''}`.trim()}>
            {counts.errors} error{counts.errors === 1 ? '' : 's'}
          </span>
          <span className={`log-pill log-pill-warn ${counts.warnings ? 'is-active' : ''}`.trim()}>
            {counts.warnings} warning{counts.warnings === 1 ? '' : 's'}
          </span>
        </div>
      </div>

      <div className="log-toolbar">
        <div className="search-input">
          <Icon name="search" size={16} />
          <TextInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search messages, scopes, or details…"
            aria-label="Search activity log"
          />
        </div>
        <Select value={level} onChange={(event) => setLevel(event.target.value as LevelFilter)} aria-label="Filter by level">
          <option value="all">All levels</option>
          <option value="error">Errors</option>
          <option value="warn">Warnings</option>
          <option value="info">Info</option>
          <option value="debug">Debug</option>
        </Select>
        <Select value={scope} onChange={(event) => setScope(event.target.value)} aria-label="Filter by scope">
          <option value="all">All scopes</option>
          {scopes.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </Select>
        {query || level !== 'all' || scope !== 'all' ? (
          <button
            type="button"
            className="text-button"
            onClick={() => {
              setQuery('');
              setLevel('all');
              setScope('all');
            }}
          >
            Reset filters
          </button>
        ) : null}
        <span className="log-result-count">
          {filtered.length} of {logs.length}
        </span>
      </div>

      <div className="log-console">
        {filtered.length ? (
          filtered.map((log) => (
            <article key={log.id} className={`log-row log-${log.level}`}>
              <span className="log-time" title={new Date(log.timestamp).toLocaleString()}>
                {formatDate(log.timestamp)}
              </span>
              <span className={`log-level log-level-${log.level}`}>{log.level}</span>
              <span className="log-scope">{log.scope}</span>
              <div className="log-content">
                <p>{log.message}</p>
                {log.detail ? (
                  <details className="log-detail">
                    <summary>Details</summary>
                    <pre>{log.detail}</pre>
                  </details>
                ) : null}
              </div>
              <IconButton
                icon="copy"
                label="Copy entry"
                size={14}
                onClick={() => {
                  void copyText(`${log.timestamp} [${log.level.toUpperCase()}] ${log.scope}: ${log.message}${log.detail ? `\n${log.detail}` : ''}`)
                    .then(() => notify('success', 'Log entry copied'))
                    .catch((error: Error) => notify('error', 'Could not copy', error.message));
                }}
              />
            </article>
          ))
        ) : (
          <EmptyState
            icon="logs"
            title={logs.length ? 'No matching entries' : 'No activity recorded yet'}
            description={
              logs.length
                ? 'Try a different search term, level, or scope.'
                : 'Events will appear here as you add downloads and use the browser bridge.'
            }
            action={
              logs.length ? (
                <Button
                  onClick={() => {
                    setQuery('');
                    setLevel('all');
                    setScope('all');
                  }}
                >
                  Clear filters
                </Button>
              ) : (
                <Button icon="refresh" onClick={() => void refresh()}>
                  Refresh
                </Button>
              )
            }
          />
        )}
      </div>

      <p className="log-footnote">
        <Icon name="info" size={14} />
        Logs are stored locally on this computer. Debug-level messages are only recorded when enabled in Settings.
      </p>

      <ConfirmDialog
        open={clearOpen}
        title="Clear the activity log?"
        message="All stored log entries will be removed. This cannot be undone."
        confirmLabel="Clear activity log"
        danger
        onCancel={() => setClearOpen(false)}
        onConfirm={() => {
          setClearOpen(false);
          void clearLogs();
        }}
      />
    </div>
  );
}
