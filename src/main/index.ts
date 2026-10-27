import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  session,
  shell,
  Tray,
  type NativeImage
} from 'electron';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { AppInfo, AppSettings, BrowserDownloadConfirmation, QueueRecord } from '../shared/types';
import { APP_NAME, APP_SHORT_NAME, APP_VERSION } from '../shared/defaults';
import { AppDatabase } from './database';
import { SafeStorageSecretBox } from './secure';
import { SettingsService } from './settings';
import { AppLogger } from './logger';
import { DownloadManager, type ManagerHost } from './manager';
import { SchedulerService } from './scheduler';
import { BrowserBridge } from './bridge';
import { registerIpc, performSystemShutdown } from './ipc';
import { migrateLegacyProfile } from './migration';

const APP_ID = 'com.mdm.desktop';
const PROGRESS_EVENT = 'mdm:progress';
const SNAPSHOT_EVENT = 'mdm:snapshot';
const UPDATED_EVENT = 'mdm:download-updated';
const LIFECYCLE_EVENT = 'mdm:download-lifecycle';
const FOCUS_DOWNLOAD_EVENT = 'mdm:focus-download';
const LOG_EVENT = 'mdm:log';
const NAVIGATE_EVENT = 'mdm:navigate';
const TOAST_EVENT = 'mdm:toast';
const BROWSER_DOWNLOAD_EVENT = 'mdm:browser-download';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let db: AppDatabase | null = null;
let settingsService: SettingsService | null = null;
let logger: AppLogger | null = null;
let manager: DownloadManager | null = null;
let scheduler: SchedulerService | null = null;
let bridge: BrowserBridge | null = null;
let appInfo: AppInfo | null = null;
let quitting = false;
let shuttingDown = false;
let startHidden = false;
let pendingFocusDownloadId: string | null = null;
let snapshotTimer: NodeJS.Timeout | null = null;
let taskbarTimer: NodeJS.Timeout | null = null;
const pendingUrls: string[] = [];
const notifications = new Set<Notification>();
const devServerUrl = process.env.VITE_DEV_SERVER_URL ?? '';

app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);
if (process.env.MDM_USER_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.MDM_USER_DATA_DIR));
} else {
  const migration = migrateLegacyProfile(app.getPath('userData'), path.join(app.getPath('appData'), 'AeroFetch'));
  if (migration.migrated) console.info('Migrated existing data from AeroFetch.');
}
startHidden = process.argv.includes('--background');
for (const argument of process.argv.slice(1)) {
  const url = safeDownloadUrl(argument);
  if (url) pendingUrls.push(url);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    showMainWindow();
    const url = argv.map(safeDownloadUrl).find(Boolean);
    if (url) {
      if (manager) void addUrl(url);
      else pendingUrls.push(url);
    }
  });

  app.on('activate', () => {
    if (mainWindow) showMainWindow();
    else if (app.isReady()) createMainWindow();
  });

  app.on('window-all-closed', () => {
    if (process.platform === 'darwin') return;
    if (!quitting && (settingsService?.get().closeToTray ?? false) && tray) return;
    app.quit();
  });

  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void shutdown().finally(() => app.quit());
  });

  app.on('will-quit', () => {
    notifications.clear();
    tray?.destroy();
    tray = null;
  });

  app.whenReady().then(bootstrap).catch((error) => {
    console.error(error);
    dialog.showErrorBox(`${APP_NAME} could not start`, (error as Error).message);
    app.exit(1);
  });
}

async function bootstrap(): Promise<void> {
  configureSession();
  const dbPath = path.join(app.getPath('userData'), 'mdm.db');
  const database = new AppDatabase(dbPath, new SafeStorageSecretBox());
  database.open();
  db = database;

  const settings = new SettingsService(database, app.getPath('downloads'));
  settings.initialize();
  settingsService = settings;

  const appLogger = new AppLogger(database, () => settingsService?.get().loggingLevel ?? 'info');
  appLogger.setLevel(settings.get().loggingLevel);
  logger = appLogger;

  const tools = resolveMediaTools();
  appInfo = await buildAppInfo(settings, tools);

  const host = buildHost();
  const downloadManager = new DownloadManager({
    db: database,
    settings,
    logger: appLogger,
    host,
    ...tools
  });
  manager = downloadManager;
  await downloadManager.initialize();

  scheduler = new SchedulerService(database, downloadManager, appLogger);
  bridge = new BrowserBridge(
    downloadManager,
    appLogger,
    (confirmation: BrowserDownloadConfirmation) => {
      showMainWindow();
      send(BROWSER_DOWNLOAD_EVENT, confirmation);
    },
    (result) => showMainWindow('downloads', result.id)
  );
  applyBridgeSettings(settings.get());
  scheduler.start();

  registerIpc({
    db: database,
    settings,
    manager: downloadManager,
    logger: appLogger,
    getWindow: () => mainWindow,
    getAppInfo: () => appInfo!,
    openExtensionFolder: () => openExtensionFolder(appInfo!.extensionPath),
    openResourcesFolder: () => openResourcesFolder(appInfo!.extensionPath),
    testBridge: () => bridge?.testConnection() ?? Promise.resolve({ ok: false, message: 'The browser bridge is not available.' }),
    setBadge,
    openExternal: (target) => shell.openExternal(target)
  });

  wireManager(downloadManager);
  wireSettings(settings);
  wireLogs(appLogger);
  applyWindowTheme();
  applyLoginItem(settings.get());
  createMainWindow();
  createTray();
  installMenu();
  await flushPendingUrls();
  if (!mainWindow) showMainWindow();

  appLogger.info('system', `${APP_NAME} ${APP_VERSION} started.`);
}

function buildHost(): ManagerHost {
  return {
    async createSystemProxy(url: string) {
      let resolved: string;
      try {
        resolved = await session.defaultSession.resolveProxy(url);
      } catch {
        return null;
      }
      for (const directive of resolved.split(';')) {
        const [kind = '', address = ''] = directive.trim().split(/\s+/, 2);
        if (!kind || kind === 'DIRECT') continue;
        const type = kind.toUpperCase();
        if (type !== 'PROXY' && type !== 'HTTPS') {
          throw new Error(
            `The system proxy ${type} at ${address} is not supported. Choose an HTTP or HTTPS proxy in Settings.`
          );
        }
        let parsed: URL;
        try {
          parsed = new URL(`${type === 'HTTPS' ? 'https' : 'http'}://${address}`);
        } catch {
          throw new Error('The system proxy address could not be read.');
        }
        const port = Number(parsed.port || (type === 'HTTPS' ? 443 : 80));
        return {
          protocol: type === 'HTTPS' ? 'https' : 'http',
          host: parsed.hostname,
          port,
          username: '',
          password: '',
          bypass: [],
          url: `${parsed.protocol}//${parsed.host}`
        };
      }
      return null;
    },
    openPath: (target) => shell.openPath(target),
    revealItem: (target) => shell.showItemInFolder(target),
    notify: (title, body, downloadId) => showNotification(title, body, downloadId),
    requestShutdown: (queue: QueueRecord) => {
      showNotification(
        'Queue complete',
        `${queue.name} finished. Windows will shut down in 60 seconds.`
      );
      void performSystemShutdown(logger!).catch((error) => {
        logger?.error('system', `Shutdown failed: ${(error as Error).message}`);
        showNotification('Shutdown failed', (error as Error).message);
      });
    }
  };
}

function wireManager(downloadManager: DownloadManager): void {
  downloadManager.on('changed', scheduleSnapshot);
  downloadManager.on('progress', (event) => {
    if (isWindowVisible()) send(PROGRESS_EVENT, event);
    scheduleTaskbarUpdate();
  });
  downloadManager.on('updated', (record) => {
    send(UPDATED_EVENT, record);
    scheduleTaskbarUpdate();
  });
  downloadManager.on('lifecycle', (event) => send(LIFECYCLE_EVENT, event));
  downloadManager.on('queue-complete', (payload: { queue: QueueRecord; completed: number; failed: number }) => {
    send(TOAST_EVENT, {
      type: payload.failed ? 'error' : 'success',
      title: `Queue "${payload.queue.name}" finished`,
      message: `${payload.completed} completed${payload.failed ? `, ${payload.failed} failed` : ''}.`
    });
  });
}

function wireSettings(settings: SettingsService): void {
  settings.onChanged((next) => {
    logger?.setLevel(next.loggingLevel);
    applyLoginItem(next);
    applyBridgeSettings(next);
    applyWindowTheme();
    scheduleSnapshot();
    updateTrayMenu();
  });
}

function wireLogs(appLogger: AppLogger): void {
  appLogger.onLog((log) => send(LOG_EVENT, log));
}

function configureSession(): void {
  const currentSession = session.defaultSession;
  currentSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  currentSession.setPermissionCheckHandler(() => false);
  currentSession.webRequest.onHeadersReceived((details, callback) => {
    const isAppUrl = devServerUrl
      ? details.url.startsWith(devServerUrl)
      : details.url.startsWith('file://');
    if (!isAppUrl) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    const csp = devServerUrl
      ? "default-src 'self' http://localhost:5173; script-src 'self' 'unsafe-inline' http://localhost:5173; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://localhost:5173 http://localhost:5173; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
      : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
    const headers: Record<string, string[]> = {};
    for (const [name, value] of Object.entries(details.responseHeaders ?? {})) {
      if (name.toLowerCase() === 'content-security-policy') continue;
      headers[name] = Array.isArray(value) ? value : [String(value)];
    }
    headers['Content-Security-Policy'] = [csp];
    callback({ responseHeaders: headers });
  });
}

function createMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) return;
  const icon = loadAssetImage('icon.ico');
  const dark = useDarkUi();
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: dark ? '#09110f' : '#edf3f1',
    icon: icon && !icon.isEmpty() ? icon : undefined,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    titleBarOverlay:
      process.platform === 'win32'
        ? {
            color: dark ? '#0c1513' : '#f8fbfa',
            symbolColor: dark ? '#c2d5d0' : '#354b47',
            height: 46
          }
        : undefined,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: !app.isPackaged || process.env.MDM_DEV === '1',
      spellcheck: false
    }
  });
  mainWindow = window;

  window.webContents.setWindowOpenHandler(({ url }) => {
    const safe = safeExternalUrl(url);
    if (safe) void shell.openExternal(safe);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (devServerUrl && url.startsWith(devServerUrl)) return;
    if (url.startsWith('file://') && !app.isPackaged) return;
    event.preventDefault();
    const safe = safeExternalUrl(url);
    if (safe) void shell.openExternal(safe);
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) {
      if (!app.isPackaged || process.env.MDM_DEV === '1') window.webContents.toggleDevTools();
      event.preventDefault();
    }
    if (!app.isPackaged && input.control && input.key.toLowerCase() === 'r') {
      event.preventDefault();
      window.webContents.reload();
    }
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    logger?.error('system', `The interface process stopped (${details.reason}).`);
  });
  window.webContents.on('did-finish-load', deliverPendingFocus);

  window.once('ready-to-show', () => {
    if (!startHidden || !tray) window.show();
    send(SNAPSHOT_EVENT, manager?.getSnapshot());
  });
  window.on('close', (event) => {
    if (quitting) return;
    if (settingsService?.get().closeToTray && tray) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on('minimize', () => {
    if (!settingsService?.get().minimizeToTray || !tray) return;
    window.hide();
  });
  window.on('enter-full-screen', () => updateTitleBarOverlay(true));
  window.on('leave-full-screen', () => updateTitleBarOverlay(false));
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  if (devServerUrl) {
    void window.loadURL(devServerUrl).catch((error) => logger?.error('system', `Could not load the UI: ${error.message}`));
  } else {
    void window
      .loadFile(path.join(__dirname, '../../renderer/index.html'))
      .catch((error) => logger?.error('system', `Could not load the UI: ${error.message}`));
  }
}

function createTray(): void {
  if (tray) return;
  const image = loadAssetImage('tray.png');
  if (!image || image.isEmpty()) {
    logger?.warn('system', 'Tray icon is missing; the app will keep a normal window.');
    return;
  }
  tray = new Tray(image);
  tray.setToolTip(APP_SHORT_NAME);
  tray.on('click', () => {
    if (mainWindow?.isVisible() && mainWindow.isFocused()) mainWindow.hide();
    else showMainWindow();
  });
  tray.on('double-click', () => showMainWindow());
  updateTrayMenu();
}

function updateTrayMenu(): void {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open ${APP_SHORT_NAME}`, click: () => showMainWindow() },
      { label: 'New download', click: () => showMainWindow('add') },
      { type: 'separator' },
      { label: 'Pause all', click: () => manager?.pauseAll() },
      { label: 'Resume all', click: () => manager?.resumeAll() },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = false;
          app.quit();
        }
      }
    ])
  );
}

function installMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: APP_SHORT_NAME,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { label: 'Preferences…', accelerator: 'Cmd+,', click: () => showMainWindow('settings') },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      },
      { role: 'editMenu' },
      {
        role: 'viewMenu',
        submenu: [
          { role: 'reload' },
          ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]),
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' }
        ]
      },
      { role: 'windowMenu' }
    ])
  );
}

function scheduleSnapshot(): void {
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    const snapshot = manager?.getSnapshot();
    if (snapshot) send(SNAPSHOT_EVENT, snapshot);
  }, 120);
}

function scheduleTaskbarUpdate(): void {
  if (taskbarTimer) return;
  taskbarTimer = setTimeout(() => {
    taskbarTimer = null;
    updateTaskbar();
  }, 250);
}

function updateTaskbar(): void {
  const window = mainWindow;
  if (!window || window.isDestroyed() || !manager || !settingsService) return;
  const settings = settingsService.get();
  if (!settings.showProgressInTaskbar) {
    window.setProgressBar(-1);
    return;
  }
  const active = manager.getActiveRecords();
  if (!active.length) {
    window.setProgressBar(-1);
    return;
  }
  const known = active.filter((record) => record.totalBytes && record.totalBytes > 0);
  if (known.length !== active.length) {
    window.setProgressBar(2, { mode: 'indeterminate' });
    return;
  }
  const total = active.reduce((sum, record) => sum + (record.totalBytes ?? 0), 0);
  const done = active.reduce((sum, record) => sum + Math.min(record.downloadedBytes, record.totalBytes ?? 0), 0);
  window.setProgressBar(total > 0 ? Math.min(1, done / total) : -1, { mode: 'normal' });
}

function applyWindowTheme(): void {
  updateTitleBarOverlay(false);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const dark = useDarkUi();
  mainWindow.setBackgroundColor(dark ? '#09110f' : '#edf3f1');
}

function updateTitleBarOverlay(fullScreen: boolean): void {
  if (process.platform !== 'win32' || !mainWindow || mainWindow.isDestroyed()) return;
  if (fullScreen) {
    mainWindow.setTitleBarOverlay({ color: '#00000000', symbolColor: '#ffffff', height: 46 });
    return;
  }
  const dark = useDarkUi();
  mainWindow.setTitleBarOverlay({
    color: dark ? '#0c1513' : '#f8fbfa',
    symbolColor: dark ? '#c2d5d0' : '#354b47',
    height: 46
  });
}

function useDarkUi(): boolean {
  const theme = settingsService?.get().theme ?? 'system';
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return nativeTheme.shouldUseDarkColors;
}

function applyBridgeSettings(settings: AppSettings): void {
  void bridge?.apply({
    enabled: settings.browserIntegrationEnabled,
    port: settings.bridgePort,
    token: settings.bridgeToken
  });
}

function applyLoginItem(settings: AppSettings): void {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: settings.launchAtStartup,
      path: process.execPath,
      args: ['--background']
    });
  } catch (error) {
    logger?.warn('system', `Could not update the startup setting: ${(error as Error).message}`);
  }
}

function windowIsActive(): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  return mainWindow.isVisible() && !mainWindow.isMinimized() && mainWindow.isFocused();
}

function isWindowVisible(): boolean {
  return !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
}

function showNotification(title: string, body: string, downloadId?: string): void {
  if (!Notification.isSupported()) return;
  if (!settingsService?.get().nativeNotificationsWhenActive && windowIsActive()) return;
  const icon = loadAssetImage('icon.png');
  const notification = new Notification({
    title,
    body,
    icon: icon && !icon.isEmpty() ? icon : undefined
  });
  notifications.add(notification);
  notification.on('click', () => {
    showMainWindow('downloads', downloadId);
  });
  notification.on('close', () => notifications.delete(notification));
  notification.show();
}

function deliverPendingFocus(): void {
  if (!pendingFocusDownloadId || !mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isLoadingMainFrame()) return;
  const id = pendingFocusDownloadId;
  pendingFocusDownloadId = null;
  send(FOCUS_DOWNLOAD_EVENT, id);
}

function showMainWindow(route = 'downloads', downloadId?: string): void {
  if (downloadId) pendingFocusDownloadId = downloadId;
  if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  send(NAVIGATE_EVENT, route);
  deliverPendingFocus();
}

async function addUrl(url: string): Promise<void> {
  if (!manager) return;
  try {
    await manager.addDownload({ url });
    showMainWindow('downloads');
  } catch (error) {
    showNotification('Could not add download', (error as Error).message);
  }
}

async function flushPendingUrls(): Promise<void> {
  const urls = pendingUrls.splice(0);
  for (const url of urls) await addUrl(url);
}

function send(channel: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function setBadge(count: number): void {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    app.setBadgeCount(Math.max(0, Math.floor(count)));
  }
}

async function openExtensionFolder(extensionPath: string): Promise<void> {
  try {
    await fsp.access(extensionPath);
  } catch {
    throw new Error(`The browser extension folder is missing: ${extensionPath}`);
  }
  const error = await shell.openPath(extensionPath);
  if (error) throw new Error(error);
}

async function openResourcesFolder(extensionPath: string): Promise<void> {
  const resourcesPath = path.dirname(extensionPath);
  try {
    await fsp.access(resourcesPath);
  } catch {
    throw new Error(`The app resources folder is missing: ${resourcesPath}`);
  }
  const error = await shell.openPath(resourcesPath);
  if (error) throw new Error(error);
}

interface MediaTools {
  ffmpegPath: string;
  ytDlpPath: string;
  jsRuntimePath: string;
}

function resolveMediaTools(): MediaTools {
  return {
    ffmpegPath: resolveFfmpegPath(),
    ytDlpPath: resolveYtDlpPath(),
    jsRuntimePath: process.execPath
  };
}

function resolveFfmpegPath(): string {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'tools', 'ffmpeg.exe')]
    : [path.join(app.getAppPath(), 'tools', 'ffmpeg.exe')];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return resolveToolPath('ffmpeg', ['-version']);
}

function resolveYtDlpPath(): string {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'tools', 'yt-dlp.exe')]
    : [path.join(app.getAppPath(), 'tools', 'yt-dlp.exe')];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return resolveToolPath('yt-dlp', ['--version']);
}

function resolveToolPath(name: string, versionArgs: string[]): string {
  try {
    if (process.platform === 'win32') {
      const result = spawnSync('where.exe', [name], { timeout: 4000, windowsHide: true, encoding: 'utf8' });
      const first = String(result.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      if (result.status === 0 && first) return first;
    }
    const result = spawnSync(name, versionArgs, { timeout: 4000, windowsHide: true, stdio: 'ignore' });
    return result.status === 0 ? name : '';
  } catch {
    return '';
  }
}

async function buildAppInfo(settings: SettingsService, tools: MediaTools): Promise<AppInfo> {
  const extensionPath = app.isPackaged
    ? path.join(process.resourcesPath, 'extension')
    : path.join(app.getAppPath(), 'extension');
  return {
    version: APP_VERSION,
    platform: `${process.platform} ${process.arch}`,
    userDataPath: app.getPath('userData'),
    downloadsPath: settings.get().defaultDownloadDir,
    ffmpegAvailable: Boolean(tools.ffmpegPath),
    ytDlpAvailable: Boolean(tools.ytDlpPath),
    extensionPath
  };
}

function loadAssetImage(name: string): NativeImage {
  const base = app.isPackaged ? path.join(process.resourcesPath, 'assets') : path.join(app.getAppPath(), 'assets');
  return nativeImage.createFromPath(path.join(base, name));
}

function safeDownloadUrl(value: string | undefined): string | null {
  if (!value || !/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function safeExternalUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  if (snapshotTimer) clearTimeout(snapshotTimer);
  if (taskbarTimer) clearTimeout(taskbarTimer);
  scheduler?.stop();
  scheduler = null;
  try {
    await manager?.shutdown();
  } catch (error) {
    logger?.warn('system', `Downloads did not stop cleanly: ${(error as Error).message}`);
  }
  await bridge?.close().catch(() => undefined);
  bridge = null;
  db?.close();
  db = null;
}

nativeTheme.on('updated', () => applyWindowTheme());
