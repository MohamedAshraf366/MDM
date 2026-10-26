import { useMemo } from 'react';
import { formatSpeed } from '../../shared/format';
import { useApp } from '../app/store';
import { BrandMark, Icon } from './Icons';
import { IconButton } from './Ui';

export function TitleBar() {
  const { snapshot, navigate, openAddDialog } = useApp();
  const active = useMemo(
    () =>
      snapshot?.downloads.filter((record) =>
        ['connecting', 'downloading', 'verifying', 'finalizing'].includes(record.status)
      ) ?? [],
    [snapshot?.downloads]
  );
  const speed = active.reduce((sum, record) => sum + (record.speedBps || 0), 0);
  const bridge = snapshot?.bridge;

  return (
    <header className="titlebar">
      <div className="titlebar-brand">
        <BrandMark size={25} />
        <div className="titlebar-word">
          <strong>MDM</strong>
          <span>Mohamed Download Manager</span>
        </div>
      </div>
      <div className="titlebar-drag">
        {active.length ? (
          <span className="titlebar-activity">
            <span className="pulse-dot" />
            {active.length} active
            <span className="titlebar-divider" />
            {speed > 0 ? formatSpeed(speed) : 'Connecting…'}
          </span>
        ) : (
          <span className="titlebar-activity is-idle">
            <span className="idle-dot" />
            Ready
          </span>
        )}
      </div>
      <div className="titlebar-actions">
        <button
          type="button"
          className={`bridge-chip ${bridge?.enabled ? 'is-on' : ''}`}
          onClick={() => navigate('browser')}
          title={bridge?.enabled ? 'Browser integration is enabled' : 'Browser integration is off'}
        >
          <Icon name="puzzle" size={14} />
          <span>{bridge?.enabled ? 'Browser on' : 'Browser off'}</span>
        </button>
        <IconButton icon="plus" label="New download" variant="soft" onClick={openAddDialog} />
      </div>
    </header>
  );
}
