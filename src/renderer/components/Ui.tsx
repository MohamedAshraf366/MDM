import {
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes
} from 'react';
import { createPortal } from 'react-dom';
import type { DownloadStatus, FileCategory } from '../../shared/types';
import { progressRatio } from '../../shared/format';
import { Icon, type IconName } from './Icons';

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  iconRight,
  loading,
  children,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'soft';
  size?: 'sm' | 'md';
  icon?: IconName;
  iconRight?: IconName;
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      className={`button button-${variant} button-${size} ${className}`.trim()}
      {...props}
      disabled={props.disabled || loading}
    >
      {loading ? <Spinner size={15} /> : icon ? <Icon name={icon} size={size === 'sm' ? 15 : 17} /> : null}
      {children ? <span>{children}</span> : null}
      {iconRight ? <Icon name={iconRight} size={size === 'sm' ? 14 : 16} /> : null}
    </button>
  );
}

export function IconButton({
  icon,
  label,
  variant = 'ghost',
  size = 17,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: IconName;
  label: string;
  variant?: 'ghost' | 'soft' | 'danger';
  size?: number;
}) {
  return (
    <button
      type="button"
      className={`icon-button icon-button-${variant} ${className}`.trim()}
      aria-label={label}
      title={label}
      {...props}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}

export function Spinner({ size = 18, className = '' }: { size?: number; className?: string }) {
  return (
    <span
      className={`spinner ${className}`.trim()}
      style={{ width: size, height: size }}
      role="status"
      aria-label="Loading"
    />
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  className = '',
  htmlFor
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  return (
    <label className={`field ${className}`.trim()} htmlFor={htmlFor}>
      <span className="field-label">{label}</span>
      {children}
      {hint && !error ? <span className="field-hint">{hint}</span> : null}
      {error ? <span className="field-error">{error}</span> : null}
    </label>
  );
}

export function TextInput({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`input ${className}`.trim()} {...props} />;
}

export function TextArea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`input textarea ${className}`.trim()} {...props} />;
}

export function Select({ className = '', children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="select-wrap">
      <select className={`input select ${className}`.trim()} {...props}>
        {children}
      </select>
      <Icon name="chevron-down" size={14} className="select-chevron" />
    </span>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled,
  label
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle ${checked ? 'is-on' : ''}`.trim()}
      onClick={() => onChange(!checked)}
      disabled={disabled}
    >
      <span className="toggle-knob" />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label
}: {
  value: T;
  options: Array<{ value: T; label: string; icon?: IconName }>;
  onChange: (value: T) => void;
  label?: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          className={`segment ${value === option.value ? 'is-active' : ''}`.trim()}
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
        >
          {option.icon ? <Icon name={option.icon} size={14} /> : null}
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 620,
  className = ''
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  className?: string;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timer = window.setTimeout(() => {
      const focusable = panelRef.current?.querySelector<HTMLElement>(
        'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])'
      );
      focusable?.focus();
    }, 30);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const items = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((item) => item.offsetParent !== null);
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="modal-layer" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={panelRef}
        className={`modal ${className}`.trim()}
        style={{ width }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="modal-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <IconButton icon="close" label="Close" onClick={onClose} />
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>,
    document.body
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  danger = false,
  onConfirm,
  onCancel
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      width={440}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="confirm-message">{message}</p>
    </Modal>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  eyebrow
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  eyebrow?: string;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow ? <span className="page-eyebrow">{eyebrow}</span> : null}
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function Card({
  children,
  className = '',
  title,
  subtitle,
  actions
}: {
  children: ReactNode;
  className?: string;
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <section className={`card ${className}`.trim()}>
      {title || actions ? (
        <div className="card-head">
          <div>
            {title ? <h2>{title}</h2> : null}
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          {actions ? <div className="card-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

const STATUS_LABELS: Record<DownloadStatus, string> = {
  queued: 'Queued',
  scheduled: 'Scheduled',
  connecting: 'Connecting',
  downloading: 'Downloading',
  paused: 'Paused',
  verifying: 'Verifying',
  finalizing: 'Finalizing',
  completed: 'Completed',
  failed: 'Failed',
  canceled: 'Canceled'
};

export function StatusBadge({ status }: { status: DownloadStatus }) {
  return (
    <span className={`status status-${status}`}>
      <span className="status-dot" />
      {STATUS_LABELS[status]}
    </span>
  );
}

const CATEGORY_META: Record<FileCategory, { icon: IconName; label: string; tone: string }> = {
  video: { icon: 'video', label: 'Video', tone: 'violet' },
  audio: { icon: 'audio', label: 'Audio', tone: 'pink' },
  documents: { icon: 'document', label: 'Document', tone: 'blue' },
  archives: { icon: 'archive', label: 'Archive', tone: 'amber' },
  images: { icon: 'image', label: 'Image', tone: 'green' },
  programs: { icon: 'program', label: 'Program', tone: 'red' },
  other: { icon: 'file', label: 'File', tone: 'slate' }
};

export function FileGlyph({
  category,
  size = 'md',
  fileName
}: {
  category: FileCategory;
  size?: 'sm' | 'md' | 'lg';
  fileName?: string;
}) {
  const meta = CATEGORY_META[category] ?? CATEGORY_META.other;
  return (
    <span
      className={`file-glyph file-glyph-${meta.tone} file-glyph-${size}`}
      title={fileName ? `${meta.label}: ${fileName}` : meta.label}
    >
      <Icon name={meta.icon} size={size === 'lg' ? 26 : size === 'sm' ? 15 : 20} />
    </span>
  );
}

export function ProgressBar({
  downloaded,
  total,
  status,
  compact = false
}: {
  downloaded: number;
  total: number | null;
  status?: DownloadStatus;
  compact?: boolean;
}) {
  const ratio = progressRatio(downloaded, total);
  const indeterminate = total === null && ['connecting', 'downloading'].includes(status ?? '');
  const tone = status === 'completed' ? 'complete' : status === 'failed' ? 'failed' : status === 'paused' ? 'paused' : '';
  return (
    <div
      className={`progress ${compact ? 'progress-compact' : ''} ${indeterminate ? 'is-indeterminate' : ''} progress-${tone}`.trim()}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={total ? Math.round(ratio * 100) : undefined}
    >
      <span className="progress-fill" style={indeterminate ? undefined : { width: `${Math.max(ratio * 100, downloaded > 0 ? 1 : 0)}%` }} />
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action
}: {
  icon: IconName;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={26} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function StatCard({
  icon,
  label,
  value,
  detail,
  tone = 'accent',
  progress
}: {
  icon: IconName;
  label: string;
  value: string;
  detail?: string;
  tone?: 'accent' | 'blue' | 'amber' | 'green' | 'slate';
  progress?: number;
}) {
  return (
    <div className={`stat-card stat-${tone}`}>
      <span className="stat-icon">
        <Icon name={icon} size={19} />
      </span>
      <div className="stat-copy">
        <span className="stat-label">{label}</span>
        <strong>{value}</strong>
        {detail ? <span className="stat-detail">{detail}</span> : null}
        {progress !== undefined ? (
          <span className="stat-progress">
            <span style={{ width: `${Math.min(100, Math.max(0, progress * 100))}%` }} />
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function InlineNote({
  tone = 'info',
  children
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  children: ReactNode;
}) {
  return (
    <div className={`inline-note note-${tone}`}>
      <Icon name={tone === 'success' ? 'check-circle' : tone === 'info' ? 'info' : 'alert'} size={16} />
      <div>{children}</div>
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  tabs
}: {
  value: T;
  onChange: (value: T) => void;
  tabs: Array<{ value: T; label: string; count?: number }>;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          type="button"
          role="tab"
          aria-selected={value === tab.value}
          key={tab.value}
          className={`tab ${value === tab.value ? 'is-active' : ''}`.trim()}
          onClick={() => onChange(tab.value)}
        >
          {tab.label}
          {tab.count !== undefined ? <span className="tab-count">{tab.count}</span> : null}
        </button>
      ))}
    </div>
  );
}
