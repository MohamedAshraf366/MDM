export type ToastKind = 'success' | 'warning' | 'error' | 'info';

export type ToastAction =
  | { kind: 'focus-download'; label: string; downloadId: string; details?: boolean }
  | { kind: 'retry-download'; label: string; downloadId: string }
  | { kind: 'open-file'; label: string; downloadId: string }
  | { kind: 'open-logs'; label: string };

export interface ToastOptions {
  actions?: ToastAction[];
  dedupeKey?: string;
  durationMs?: number;
}

export interface Toast {
  id: string;
  type: ToastKind;
  title: string;
  message?: string;
  actions?: ToastAction[];
}
