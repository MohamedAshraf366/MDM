'use strict';

const ext = globalThis.MDMExt;
const api = ext.api;
const elements = {
  status: document.getElementById('status'),
  statusText: document.getElementById('status-text'),
  notice: document.getElementById('notice'),
  address: document.getElementById('bridge-address'),
  autoCapture: document.getElementById('auto-capture'),
  autoCaptureState: document.getElementById('auto-capture-state'),
  autoCaptureHint: document.getElementById('auto-capture-hint'),
  version: document.getElementById('extension-version'),
  test: document.getElementById('test-button'),
  options: document.getElementById('options-button'),
  showOverlays: document.getElementById("show-overlays")
};

function setStatus(kind, text) {
  elements.status.className = `status is-${kind}`;
  elements.statusText.textContent = text;
}

function showNotice(tone, message) {
  elements.notice.className = `notice${tone ? ` is-${tone}` : ''}`;
  elements.notice.textContent = message;
  elements.notice.hidden = !message;
}

function renderCapture(enabled) {
  elements.autoCapture.checked = enabled;
  elements.autoCaptureState.textContent = enabled ? 'On' : 'Off';
  elements.autoCaptureState.classList.toggle('is-on', enabled);
  elements.autoCaptureHint.textContent = enabled
    ? 'New HTTP, HTTPS, and FTP downloads open in MDM instead of this browser.'
    : 'Browser downloads stay in this browser.';
}

async function setCapture(enabled) {
  elements.autoCapture.disabled = true;
  try {
    const config = await ext.saveConfig({ autoCapture: enabled });
    renderCapture(config.autoCapture);
    showNotice(
      'success',
      config.autoCapture
        ? 'MDM will now take over browser downloads.'
        : 'Browser downloads are back to normal.'
    );
  } catch (error) {
    renderCapture(!enabled);
    showNotice('error', error?.message ?? 'Could not save the setting.');
  } finally {
    elements.autoCapture.disabled = false;
  }
}

async function requestBackground(message) {
  const response = await api.runtime.sendMessage(message);
  if (!response || response.ok !== true) throw new Error(response?.error ?? 'The extension request failed.');
  return response.data;
}

async function checkConnection() {
  setStatus('checking', 'Checking');
  try {
    const result = await requestBackground({ type: 'test-connection' });
    setStatus('ok', 'Connected');
    elements.address.textContent = `127.0.0.1 - ${result.version || 'ready'}`;
  } catch (error) {
    setStatus('error', 'Offline');
    elements.address.textContent = 'Start MDM to connect';
    if (error.message) showNotice('error', error.message);
  }
}

async function initialize() {
  const config = await ext.getConfig();
  elements.version.textContent = `MDM ${api.runtime.getManifest().version}`;
  elements.address.textContent = `127.0.0.1:${config.port}`;
  renderCapture(config.autoCapture);
  await checkConnection();
}

api.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.config?.newValue) return;
  renderCapture(Boolean(changes.config.newValue.autoCapture));
});
elements.autoCapture.addEventListener('change', () => void setCapture(elements.autoCapture.checked));
elements.test.addEventListener('click', () => void checkConnection());
elements.options.addEventListener('click', () => void api.runtime.openOptionsPage());
elements.showOverlays.addEventListener('click', async () => {
  try {
    await requestBackground({ type: 'mdm-show-overlays', allTabs: true });
    showNotice('success', 'Video overlays restored on open pages.');
  } catch (error) {
    showNotice('error', error?.message ?? 'Could not reach the page.');
  }
});

void initialize();
