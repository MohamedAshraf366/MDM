import { useApp, type Page } from '../app/store';
import { APP_VERSION } from '../../shared/defaults';
import { formatSpeed } from '../../shared/format';
import { Icon, type IconName } from './Icons';

interface NavItem {
  page: Page;
  label: string;
  icon: IconName;
}

const LIBRARY: NavItem[] = [
  { page: 'downloads', label: 'Downloads', icon: 'download' },
  { page: 'queues', label: 'Queues', icon: 'queue' }
];

const AUTOMATION: NavItem[] = [
  { page: 'schedule', label: 'Schedule', icon: 'calendar' },
  { page: 'rules', label: 'Rules', icon: 'rules' },
  { page: 'browser', label: 'Browser', icon: 'puzzle' }
];

const SYSTEM: NavItem[] = [
  { page: 'settings', label: 'Settings', icon: 'settings' },
  { page: 'logs', label: 'Activity log', icon: 'logs' }
];

export function Sidebar() {
  const { page, navigate, snapshot } = useApp();
  const activeCount =
    snapshot?.downloads.filter((record) =>
      ['connecting', 'downloading', 'verifying', 'finalizing'].includes(record.status)
    ).length ?? 0;
  const queuedCount =
    snapshot?.downloads.filter((record) => ['queued', 'scheduled'].includes(record.status)).length ?? 0;

  return (
    <aside className="sidebar">
      <nav className="sidebar-nav">
        <NavGroup label="Library" items={LIBRARY} activePage={page} onNavigate={navigate} badges={{ downloads: activeCount }} />
        <NavGroup label="Automation" items={AUTOMATION} activePage={page} onNavigate={navigate} />
        <NavGroup label="System" items={SYSTEM} activePage={page} onNavigate={navigate} />
      </nav>
      <div className="sidebar-footer">
        <div className="sidebar-queue">
          <div className="sidebar-queue-head">
            <span>
              <span className={`pulse-dot ${activeCount ? '' : 'is-muted'}`} />
              {activeCount ? `${activeCount} active` : 'Idle'}
            </span>
            <strong>{queuedCount ? `${queuedCount} queued` : 'No queue'}</strong>
          </div>
          <div className="sidebar-speed">
            <Icon name="activity" size={14} />
            {formatSpeed(snapshot?.downloads.reduce((sum, record) => sum + (record.speedBps || 0), 0) ?? 0)}
          </div>
        </div>
        <div className="sidebar-meta">
          <span>MDM {APP_VERSION}</span>
          <span className={`bridge-dot ${snapshot?.bridge.enabled ? 'is-on' : ''}`}>
            {snapshot?.bridge.enabled ? 'Bridge ready' : 'Bridge off'}
          </span>
        </div>
      </div>
    </aside>
  );
}

function NavGroup({
  label,
  items,
  activePage,
  onNavigate,
  badges
}: {
  label: string;
  items: NavItem[];
  activePage: Page;
  onNavigate: (page: Page) => void;
  badges?: Partial<Record<Page, number>>;
}) {
  return (
    <div className="nav-group">
      <span className="nav-label">{label}</span>
      {items.map((item) => {
        const badge = badges?.[item.page] ?? 0;
        return (
          <button
            key={item.page}
            type="button"
            className={`nav-item ${activePage === item.page ? 'is-active' : ''}`.trim()}
            onClick={() => onNavigate(item.page)}
            aria-current={activePage === item.page ? 'page' : undefined}
          >
            <Icon name={item.icon} size={18} />
            <span>{item.label}</span>
            {badge > 0 ? <span className="nav-badge">{badge}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
