import { useApp } from '../app/store';
import type { Toast, ToastAction } from '../app/toast-types';
import { Icon, type IconName } from './Icons';

export function ToastViewport() {
  const { toasts, dismissToast, focusDownload, navigate, call } = useApp();

  const runAction = async (toast: Toast, action: ToastAction): Promise<void> => {
    dismissToast(toast.id);
    if (action.kind === 'focus-download') {
      focusDownload(action.downloadId, action.details);
      return;
    }
    if (action.kind === 'open-logs') {
      navigate('logs');
      return;
    }
    if (action.kind === 'open-file') {
      await call(window.mdm.openFile(action.downloadId), 'Opening file');
      return;
    }
    await call(window.mdm.retryDownload(action.downloadId));
    focusDownload(action.downloadId);
  };

  return (
    <div className="toast-viewport" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => {
        const icon: IconName =
          toast.type === 'success'
            ? 'check-circle'
            : toast.type === 'error' || toast.type === 'warning'
              ? 'alert'
              : 'info';
        return (
          <div
            key={toast.id}
            className={`toast toast-${toast.type}`}
            role={toast.type === 'error' ? 'alert' : 'status'}
            aria-label={`${toast.title}${toast.message ? `: ${toast.message}` : ''}`}
          >
            <span className="toast-icon" aria-hidden="true">
              <Icon name={icon} size={18} />
            </span>
            <div className="toast-copy">
              <strong>{toast.title}</strong>
              {toast.message ? <p>{toast.message}</p> : null}
              {toast.actions?.length ? (
                <div className="toast-actions">
                  {toast.actions.map((action) => (
                    <button
                      key={`${action.kind}-${action.label}`}
                      type="button"
                      className="toast-action"
                      onClick={() => void runAction(toast, action)}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="toast-close"
              onClick={() => dismissToast(toast.id)}
              aria-label={`Dismiss ${toast.title}`}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
