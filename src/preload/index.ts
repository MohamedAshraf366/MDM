import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  AddDownloadRequest,
  AddDownloadResult,
  AppInfo,
  AppSettings,
  BrowserDownloadConfirmation,
  CategoryRule,
  DownloadLifecycleEvent,
  DownloadPriority,
  DownloadProgressEvent,
  DownloadRecord,
  IpcApi,
  IpcResult,
  LogRecord,
  MediaProbeResult,
  QueueInput,
  QueueRecord,
  RuleInput,
  ScheduleInput,
  ScheduleRecord,
  SettingsUpdate,
  SiteRule,
  SiteRuleInput,
  Snapshot,
  UpdateDownloadOptions
} from '../shared/types';

const invokeChannel = 'mdm:invoke';

function invoke<T>(method: string, ...args: unknown[]): Promise<IpcResult<T>> {
  return ipcRenderer.invoke(invokeChannel, method, args) as Promise<IpcResult<T>>;
}

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api: IpcApi = {
  getSnapshot: () => invoke<Snapshot>('getSnapshot'),
  getAppInfo: () => invoke<AppInfo>('getAppInfo'),
  addDownload: (request: AddDownloadRequest) => invoke<AddDownloadResult>('addDownload', request),
  updateDownload: (id: string, update: UpdateDownloadOptions) => invoke<DownloadRecord>('updateDownload', id, update),
  pauseDownload: (id: string) => invoke<void>('pauseDownload', id),
  resumeDownload: (id: string) => invoke<void>('resumeDownload', id),
  cancelDownload: (id: string) => invoke<void>('cancelDownload', id),
  retryDownload: (id: string) => invoke<void>('retryDownload', id),
  restartDownload: (id: string) => invoke<void>('restartDownload', id),
  removeDownload: (id: string, deleteFile: boolean) => invoke<void>('removeDownload', id, deleteFile),
  pauseAll: () => invoke<void>('pauseAll'),
  resumeAll: () => invoke<void>('resumeAll'),
  clearCompleted: () => invoke<void>('clearCompleted'),
  setPriority: (id: string, priority: DownloadPriority) => invoke<void>('setPriority', id, priority),
  moveToQueue: (ids: string[], queueId: string) => invoke<void>('moveToQueue', ids, queueId),
  verifyDownload: (id: string) => invoke<DownloadRecord>('verifyDownload', id),
  revealFile: (id: string) => invoke<void>('revealFile', id),
  openFile: (id: string) => invoke<void>('openFile', id),
  openFolder: (id: string) => invoke<void>('openFolder', id),
  probeMedia: (url: string, headers?: Record<string, string>, cookies?: string) =>
    invoke<MediaProbeResult>('probeMedia', url, headers, cookies),
  listQueues: () => invoke<QueueRecord[]>('listQueues'),
  saveQueue: (input: QueueInput) => invoke<QueueRecord>('saveQueue', input),
  deleteQueue: (id: string) => invoke<void>('deleteQueue', id),
  startQueue: (id: string) => invoke<void>('startQueue', id),
  stopQueue: (id: string) => invoke<void>('stopQueue', id),
  saveSchedule: (input: ScheduleInput) => invoke<ScheduleRecord>('saveSchedule', input),
  deleteSchedule: (id: string) => invoke<void>('deleteSchedule', id),
  saveRule: (input: RuleInput) => invoke<CategoryRule>('saveRule', input),
  deleteRule: (id: string) => invoke<void>('deleteRule', id),
  saveSiteRule: (input: SiteRuleInput) => invoke<SiteRule>('saveSiteRule', input),
  deleteSiteRule: (id: string) => invoke<void>('deleteSiteRule', id),
  updateSettings: (update: SettingsUpdate) => invoke<AppSettings>('updateSettings', update),
  resetSettings: () => invoke<AppSettings>('resetSettings'),
  exportSettings: () => invoke<string>('exportSettings'),
  importSettings: (json: string) => invoke<AppSettings>('importSettings', json),
  exportQueue: () => invoke<string>('exportQueue'),
  importQueue: (json: string) => invoke<number>('importQueue', json),
  regenerateBridgeToken: () => invoke<string>('regenerateBridgeToken'),
  getLogs: (limit?: number, level?: string) => invoke<LogRecord[]>('getLogs', limit, level),
  clearLogs: () => invoke<void>('clearLogs'),
  openExternal: (url: string) => invoke<void>('openExternal', url),
  showItemInFolder: (target: string) => invoke<void>('showItemInFolder', target),
  chooseFolder: (defaultPath?: string) => invoke<string | null>('chooseFolder', defaultPath),
  openExtensionFolder: () => invoke<void>('openExtensionFolder'),
  openResourcesFolder: () => invoke<void>('openResourcesFolder'),
  testBridge: () => invoke<{ ok: boolean; message: string }>('testBridge'),
  testProxy: () => invoke<{ ok: boolean; message: string }>('testProxy'),
  shutdownComputer: () => invoke<void>('shutdownComputer'),
  setBadge: (count: number) => invoke<void>('setBadge', count),
  onSnapshot: (listener) => subscribe<Snapshot>('mdm:snapshot', listener),
  onProgress: (listener) => subscribe<DownloadProgressEvent>('mdm:progress', listener),
  onDownloadUpdated: (listener) => subscribe<DownloadRecord>('mdm:download-updated', listener),
  onDownloadLifecycle: (listener) => subscribe<DownloadLifecycleEvent>('mdm:download-lifecycle', listener),
  onFocusDownload: (listener) => subscribe<string>('mdm:focus-download', listener),
  onLog: (listener) => subscribe<LogRecord>('mdm:log', listener),
  onNavigate: (listener) => subscribe<string>('mdm:navigate', listener),
  onToast: (listener) =>
    subscribe<{ type: 'success' | 'warning' | 'error' | 'info'; title: string; message?: string }>('mdm:toast', listener),
  onBrowserDownload: (listener) => subscribe<BrowserDownloadConfirmation>('mdm:browser-download', listener)
};

contextBridge.exposeInMainWorld('mdm', api);
