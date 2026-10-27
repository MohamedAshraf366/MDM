import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { systemExecutable } from '../engine/win-tools';
import type {
  AppInfo,
  DownloadPriority,
  IpcResult,
  SettingsUpdate
} from '../shared/types';
import type { AppDatabase } from './database';
import type { SettingsService } from './settings';
import type { DownloadManager } from './manager';
import type { AppLogger } from './logger';
import { isReasonableUrlLength } from '../shared/validation';

export const IPC_INVOKE_CHANNEL = 'mdm:invoke';

export interface IpcContext {
  db: AppDatabase;
  settings: SettingsService;
  manager: DownloadManager;
  logger: AppLogger;
  getWindow: () => BrowserWindow | null;
  getAppInfo: () => AppInfo;
  openExtensionFolder: () => Promise<void>;
  openResourcesFolder: () => Promise<void>;
  testBridge: () => Promise<{ ok: boolean; message: string }>;
  setBadge: (count: number) => void;
  openExternal: (target: string) => Promise<void>;
}

type Method = (...args: any[]) => unknown;

export function registerIpc(context: IpcContext): () => void {
  const handlers: Record<string, Method> = {
    getSnapshot: () => context.manager.getSnapshot(),
    getAppInfo: () => context.getAppInfo(),
    addDownload: (request) => context.manager.addDownload(request),
    updateDownload: (id, update) => context.manager.updateDownload(id, update),
    pauseDownload: (id) => context.manager.pauseDownload(id),
    resumeDownload: (id) => context.manager.resumeDownload(id),
    cancelDownload: (id) => context.manager.cancelDownload(id),
    retryDownload: (id) => context.manager.retryDownload(id),
    restartDownload: (id) => context.manager.restartDownload(id),
    removeDownload: (id, deleteFile) => context.manager.removeDownload(id, Boolean(deleteFile)),
    pauseAll: () => context.manager.pauseAll(),
    resumeAll: () => context.manager.resumeAll(),
    clearCompleted: () => context.manager.clearCompleted(),
    setPriority: (id, priority: DownloadPriority) => context.manager.setPriority(id, priority),
    moveToQueue: (ids: string[], queueId: string) => context.manager.moveToQueue(ids, queueId),
    verifyDownload: (id) => context.manager.verifyDownload(id),
    revealFile: (id) => context.manager.revealFile(id),
    openFile: (id) => context.manager.openFile(id),
    openFolder: (id) => context.manager.revealFolder(id),
    probeMedia: (url, headers, cookies) => context.manager.probeMedia(url, headers, cookies),
    listQueues: () => context.db.listQueues(),
    saveQueue: (input) => context.manager.saveQueue(input),
    deleteQueue: (id) => context.manager.deleteQueue(id),
    startQueue: (id) => context.manager.startQueue(id),
    stopQueue: (id) => context.manager.stopQueue(id),
    saveSchedule: (input) => context.manager.saveSchedule(input),
    deleteSchedule: (id) => context.manager.deleteSchedule(id),
    saveRule: (input) => context.manager.saveRule(input),
    deleteRule: (id) => context.manager.deleteRule(id),
    saveSiteRule: (input) => context.manager.saveSiteRule(input),
    deleteSiteRule: (id) => context.manager.deleteSiteRule(id),
    updateSettings: (update: SettingsUpdate) => context.settings.update(update),
    resetSettings: () => context.settings.reset(),
    exportSettings: () => context.settings.exportSettings(),
    importSettings: (json) => context.settings.importSettings(json),
    exportQueue: () => context.manager.exportQueue(),
    importQueue: (json) => context.manager.importQueue(json),
    regenerateBridgeToken: () => context.settings.regenerateBridgeToken(),
    getLogs: (limit, level) => context.db.listLogs(limit, level),
    clearLogs: () => context.db.clearLogs(),
    openExternal: (target) => openSafeExternal(context, target),
    showItemInFolder: (target) => {
      if (typeof target !== 'string' || !target) throw new Error('A file path is required.');
      shell.showItemInFolder(path.resolve(target));
    },
    chooseFolder: (defaultPath) => chooseFolder(context, defaultPath),
    openExtensionFolder: () => context.openExtensionFolder(),
    openResourcesFolder: () => context.openResourcesFolder(),
    testBridge: () => context.testBridge(),
    testProxy: () => context.manager.testProxy(),
    shutdownComputer: () => requestShutdown(context),
    setBadge: (count) => context.setBadge(Number(count) || 0)
  };

  ipcMain.handle(IPC_INVOKE_CHANNEL, async (event, method: unknown, args: unknown): Promise<IpcResult<unknown>> => {
    if (!trustedSender(event, context.getWindow())) {
      return { ok: false, error: 'This request did not come from the MDM window.' };
    }
    if (typeof method !== 'string' || !Array.isArray(args)) {
      return { ok: false, error: 'Invalid request.' };
    }
    const handler = handlers[method];
    if (!handler) return { ok: false, error: 'Unknown request.' };
    try {
      const data = await handler(...args);
      return data === undefined ? { ok: true } : { ok: true, data };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The request could not be completed.';
      if (!(error instanceof UserFacingError)) {
        context.logger.warn('ipc', `${method} failed: ${message}`);
      }
      return { ok: false, error: message };
    }
  });

  return () => {
    ipcMain.removeHandler(IPC_INVOKE_CHANNEL);
  };
}

function trustedSender(event: IpcMainInvokeEvent, window: BrowserWindow | null): boolean {
  if (!window || window.isDestroyed()) return false;
  if (event.sender !== window.webContents) return false;
  return !event.senderFrame || event.senderFrame === window.webContents.mainFrame;
}

async function openSafeExternal(context: IpcContext, target: unknown): Promise<void> {
  if (typeof target !== 'string' || !isReasonableUrlLength(target)) throw new UserFacingError('A valid URL is required.');
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new UserFacingError('The URL is not valid.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UserFacingError('Only HTTP and HTTPS links can be opened.');
  }
  await context.openExternal(url.toString());
}

async function chooseFolder(context: IpcContext, defaultPath: unknown): Promise<string | null> {
  const window = context.getWindow();
  const options: Electron.OpenDialogOptions = {
    title: 'Choose download folder',
    defaultPath: typeof defaultPath === 'string' && defaultPath ? defaultPath : app.getPath('downloads'),
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: 'Select folder'
  };
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

async function requestShutdown(context: IpcContext): Promise<void> {
  const window = context.getWindow();
  const options: Electron.MessageBoxOptions = {
    type: 'warning',
    title: 'Shut down this computer?',
    message: 'MDM will shut down this computer.',
    detail: 'Save your work in other applications first. Windows will warn you before shutting down.',
    buttons: ['Cancel', 'Shut down'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  };
  const confirmation = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  if (confirmation.response !== 1) return;
  await performSystemShutdown(context.logger);
}

export async function performSystemShutdown(logger: AppLogger): Promise<void> {
  if (process.platform !== 'win32') {
    throw new UserFacingError('Automatic shutdown is only supported on Windows.');
  }
  const { spawn } = await import('node:child_process');
  const child = spawn(systemExecutable('shutdown.exe'), ['/s', '/t', '60', '/c', 'MDM: downloads complete'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
  logger.info('system', 'Windows shutdown requested with a 60-second delay.');
}

class UserFacingError extends Error {}
