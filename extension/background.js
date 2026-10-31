'use strict';

if (typeof importScripts === 'function' && !globalThis.MDMExt) importScripts('common.js');

const ext = globalThis.MDMExt;
const api = ext.api;
const isFirefox = typeof globalThis.browser !== 'undefined';
const MENU_ID = 'mdm-send';
const MEDIA_MENU_ID = 'mdm-media';

// Some sites stream a download through a service worker inside the page. That
// URL only exists in the browser, so an external downloader cannot fetch it and
// cancelling the browser download would lose the file. Leave these to the browser.
const BROWSER_ONLY_DOWNLOAD = /\/serviceWorkerDownload\//i;

function isBrowserOnlyDownload(url) {
  return BROWSER_ONLY_DOWNLOAD.test(String(url || ''));
}

// Network-level media sniffing: catches players the DOM cannot see (workers,
// cross-origin iframes, extensionless signed URLs, blob-backed streams).
const SNIFFED_MEDIA_TTL = 10 * 60 * 1000;
const SNIFFED_MEDIA_LIMIT = 50;
const sniffedMedia = new Map();

function sniffedContentType(headers) {
  const entry = (headers || []).find((header) => header && typeof header.name === 'string' && header.name.toLowerCase() === 'content-type');
  return String(entry?.value ?? '').toLowerCase();
}

function isSniffableMedia(contentType) {
  return /^(?:video\/|audio\/|application\/(?:vnd\.apple\.mpegurl|dash\+xml|x-mpegurl|octet-stream)$)/i.test(contentType);
}

function isSniffableUrl(url) {
  return (
    /\.(?:m3u8|m3u|mpd|mp4|m4v|webm|mov|mkv|flv|avi|mp3|m4a|aac|ogg|opus|wav|flac)(?:$|[?#])/i.test(url) ||
    /\/master\.txt(?:$|[?#])/i.test(url) ||
    /\.urlset(?:\/|$)/i.test(url)
  );
}

function recordSniffedMedia(tabId, url) {
  if (!tabId || tabId < 0 || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return;
  const bucket = sniffedMedia.get(tabId) ?? new Map();
  bucket.set(url, Date.now());
  while (bucket.size > SNIFFED_MEDIA_LIMIT) {
    const oldest = bucket.keys().next().value;
    if (oldest === undefined) break;
    bucket.delete(oldest);
  }
  sniffedMedia.set(tabId, bucket);
}

function sniffedMediaFor(tabId) {
  const bucket = sniffedMedia.get(tabId);
  if (!bucket) return [];
  const now = Date.now();
  for (const [url, at] of bucket) {
    if (now - at > SNIFFED_MEDIA_TTL) bucket.delete(url);
  }
  return Array.from(bucket.keys());
}

if (api.webRequest?.onHeadersReceived) {
  const filter = { urls: ['<all_urls>'] };
  const extraInfoSpec = isFirefox ? ['responseHeaders'] : ['responseHeaders', 'extraHeaders'];
  api.webRequest.onHeadersReceived.addListener(
    (details) => {
      const contentType = sniffedContentType(details.responseHeaders);
      if (isSniffableMedia(contentType) || isSniffableUrl(details.url)) {
        recordSniffedMedia(details.tabId, details.url);
      }
    },
    filter,
    extraInfoSpec
  );
}

function httpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value) ? value : '';
}

function requestPage(message, sender, tab) {
  return (
    httpUrl(message?.pageUrl) ||
    httpUrl(sender?.url) ||
    ext.pageUrl(tab) ||
    httpUrl(sender?.tab?.url)
  );
}

function menuItems() {
  return [
    {
      id: MENU_ID,
      title: 'Download with MDM',
      contexts: ['link', 'image']
    },
    {
      id: MEDIA_MENU_ID,
      title: 'Download video with MDM',
      contexts: ['video', 'audio']
    }
  ];
}

function installMenus() {
  const items = menuItems();
  if (isFirefox) {
    api.contextMenus
      .removeAll()
      .then(() => {
        for (const item of items) api.contextMenus.create(item);
      })
      .catch(() => undefined);
    return;
  }
  api.contextMenus.removeAll(() => {
    for (const item of items) {
      api.contextMenus.create(item, () => {
        void api.runtime.lastError;
      });
    }
  });
}

installMenus();
api.runtime.onInstalled.addListener(() => {
  installMenus();
  void ext.ensureConnection().catch(() => undefined);
});
api.runtime.onStartup.addListener(() => {
  installMenus();
  void ext.ensureConnection().catch(() => undefined);
});
void ext.ensureConnection().catch(() => undefined);

api.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MEDIA_MENU_ID) {
    void (async () => {
      const page = httpUrl(info.frameUrl) || ext.pageUrl(tab);
      let target = info.srcUrl && /^https?:\/\//i.test(info.srcUrl) ? info.srcUrl : '';
      if (!target && tab?.id) {
        const found = await api.tabs.sendMessage(tab.id, { type: 'mdm-find-media' }).catch(() => null);
        target = found && /^https?:\/\//i.test(found.url) ? found.url : '';
      }
      await ext.downloadBestMedia(tab, target, page);
    })().catch((error) => {
      void ext.notify('MDM could not download this video', error.message);
    });
    return;
  }
  if (info.menuItemId !== MENU_ID) return;
  const target = info.linkUrl || info.srcUrl;
  if (!target) {
    void ext.notify('Nothing to send', 'The selected item does not have a downloadable URL.');
    return;
  }
  void ext.capture(target, tab, { pageUrl: httpUrl(info.frameUrl) || ext.pageUrl(tab) }).catch((error) => {
    void ext.notify('MDM could not capture the download', error.message);
  });
});

api.downloads.onCreated.addListener((item) => {
  void handleBrowserDownload(item);
});

async function handleBrowserDownload(item) {
  const config = await ext.getConfig();
  const target = item.finalUrl || item.url || '';
  if (!config.autoCapture || item.byExtensionId || !/^(https?|ftp):\/\//i.test(target)) return;
  if (isBrowserOnlyDownload(item.url) || isBrowserOnlyDownload(target)) return;
  const tab = item.tabId >= 0 ? await api.tabs.get(item.tabId).catch(() => null) : null;
  const fileName = item.filename ? item.filename.split(/[\\/]/).pop() : undefined;
  // Cancel the browser download immediately so the browser's own "Save As"
  // window never appears. MDM's confirmation popup picks the location instead.
  await api.downloads.cancel(item.id).catch(() => undefined);
  try {
    const result = await ext.capture(target, tab, { fileName });
    if (result?.ignored) {
      await restartBrowserDownload(target, fileName);
      return;
    }
  } catch (error) {
    await restartBrowserDownload(target, fileName);
    await ext.notify('MDM could not capture a download', error.message);
  }
}

async function restartBrowserDownload(url, fileName) {
  try {
    // Downloads started by the extension carry byExtensionId, so the listener
    // above leaves this fallback to the browser instead of capturing it again.
    await api.downloads.download({ url, filename: fileName, saveAs: false });
  } catch {
    /* The browser cannot restart it; the user can retry the link. */
  }
}

async function handleMessage(message, sender) {
  if (!message || typeof message.type !== 'string') throw new Error('Unknown extension request.');
  if (message.type === 'test-connection') {
    return ext.testConnection(message.overrides);
  }
  if (message.type === 'scan-page') {
    const tab = message.tabId ? await api.tabs.get(message.tabId) : sender.tab ?? (await ext.activeTab());
    return ext.scanTab(tab);
  }
  if (message.type === 'capture') {
    const tab = sender.tab ?? (await ext.activeTab());
    if (typeof message.url !== 'string') throw new Error('A download URL is required.');
    return ext.capture(message.url, tab, {
      fileName: message.fileName,
      pageUrl: requestPage(message, sender, tab)
    });
  }
  const tab = sender.tab ?? (await ext.activeTab());
  const page = requestPage(message, sender, tab);
  if (message.type === 'youtube-probe') {
    return ext.probeYouTube(tab, page);
  }
  if (message.type === 'youtube-download') {
    return ext.downloadYouTube(
      tab,
      message.formatId,
      {
        title: message.mediaTitle,
        quality: message.mediaQuality
      },
      page
    );
  }
  if (message.type === 'probe-media') {
    return ext.probeMedia(tab, message.url, page);
  }
  if (message.type === 'download-media') {
    return ext.downloadMedia(
      tab,
      message.url,
      message.formatId,
      {
        title: message.mediaTitle,
        quality: message.mediaQuality
      },
      page
    );
  }
  if (message.type === 'page-probe') {
    return ext.probePage(tab, page);
  }
  if (message.type === 'page-download') {
    return ext.downloadPage(
      tab,
      message.formatId,
      {
        title: message.mediaTitle,
        quality: message.mediaQuality
      },
      page
    );
  }
  if (message.type === 'sniffed-media') {
    return { urls: sniffedMediaFor(message.tabId ?? sender.tab?.id) };
  }
  if (message.type === 'mdm-show-overlays') {
    const targets = message.allTabs
      ? (await api.tabs.query({ url: ['http://*/*', 'https://*/*'] }))
      : sender.tab
        ? [sender.tab]
        : await ext.activeTab().then((tab) => (tab ? [tab] : []));
    for (const target of targets) {
      if (target?.id >= 0) {
        await api.tabs.sendMessage(target.id, { type: 'mdm-show-overlays' }).catch(() => undefined);
      }
    }
    return { ok: true };
  }
  if (message.type === 'mdm-page-candidates' || message.type === 'mdm-find-media') {
    return api.tabs.sendMessage(sender.tab?.id, message).catch(() => null);
  }
  throw new Error('Unknown extension request.');
}

api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const task = Promise.resolve().then(() => handleMessage(message, sender));
  if (isFirefox) {
    return task.then(
      (data) => ({ ok: true, data }),
      (error) => ({ ok: false, error: error?.message ?? 'The request failed.' })
    );
  }
  task.then(
    (data) => sendResponse({ ok: true, data }),
    (error) => sendResponse({ ok: false, error: error?.message ?? 'The request failed.' })
  );
  return true;
});
