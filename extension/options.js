'use strict';

const ext = globalThis.MDMExt;
const version = document.getElementById('extension-version');
if (version) version.textContent = `v${ext.api.runtime.getManifest().version}`;
const form = document.getElementById('settings-form');
const fields = {
  port: document.getElementById('port'),
  token: document.getElementById('token'),
  autoCapture: document.getElementById('auto-capture'),
  notifications: document.getElementById('notifications')
};
const buttons = {
  reveal: document.getElementById('reveal-button'),
  test: document.getElementById('test-button'),
  reset: document.getElementById('reset-button'),
  save: document.getElementById('save-button')
};
const status = document.getElementById('connection-status');
const statusText = document.getElementById('connection-text');
const testStatus = document.getElementById('test-status');
const testText = document.getElementById('test-text');
const saveHint = document.getElementById('save-hint');

let saveHintTimer = null;
let pairingTimer = null;

function setStatus(element, textElement, kind, text) {
  element.className = `status is-${kind}`;
  textElement.textContent = text;
  element.hidden = false;
}

function readForm() {
  const port = Number(fields.port.value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Choose a port between 1024 and 65535.');
  }
  return {
    port,
    token: fields.token.value.trim(),
    autoCapture: fields.autoCapture.checked,
    notifications: fields.notifications.checked
  };
}

function applyConfig(config) {
  fields.port.value = String(config.port);
  fields.token.value = config.token;
  fields.autoCapture.checked = config.autoCapture;
  fields.notifications.checked = config.notifications;
  if (config.token) {
    setStatus(status, statusText, 'ok', 'Paired');
  } else {
    status.className = 'status';
    statusText.textContent = ext.canAutoPair ? 'Not paired' : 'Token required';
  }
}

function stopPairing() {
  if (pairingTimer) {
    window.clearTimeout(pairingTimer);
    pairingTimer = null;
  }
}

function schedulePairing(port) {
  if (pairingTimer || !ext.canAutoPair) return;
  pairingTimer = window.setTimeout(async () => {
    pairingTimer = null;
    const config = await ext.getConfig();
    if (config.token) return;
    try {
      const paired = await ext.connect(port);
      applyConfig(paired);
      setStatus(status, statusText, 'ok', 'Connected automatically');
    } catch {
      setStatus(status, statusText, 'checking', 'Waiting for MDM');
      schedulePairing(port);
    }
  }, 4000);
}

function setSaveHint(message) {
  saveHint.textContent = message;
  if (saveHintTimer) window.clearTimeout(saveHintTimer);
  saveHintTimer = window.setTimeout(() => {
    saveHint.textContent = 'Changes are stored only in this browser profile.';
  }, 3500);
}

async function loadSettings() {
  stopPairing();
  let config = await ext.getConfig();
  applyConfig(config);
  if (config.token) return;
  if (!ext.canAutoPair) {
    setStatus(status, statusText, 'checking', 'Paste the token from MDM');
    return;
  }
  setStatus(status, statusText, 'checking', 'Waiting for MDM');
  try {
    config = await ext.connect(config.port);
    applyConfig(config);
    setStatus(status, statusText, 'ok', 'Connected automatically');
  } catch {
    setStatus(status, statusText, 'checking', 'Waiting for MDM');
    schedulePairing(config.port);
  }
}

async function testConnection() {
  let values;
  try {
    values = readForm();
  } catch (error) {
    setStatus(testStatus, testText, 'error', error.message);
    return;
  }
  if (!values.token && !ext.canAutoPair) {
    setStatus(testStatus, testText, 'error', 'Paste the bridge token from MDM first.');
    return;
  }
  stopPairing();
  buttons.test.disabled = true;
  buttons.test.textContent = 'Testing';
  setStatus(testStatus, testText, 'checking', 'Contacting MDM');
  try {
    const result = await ext.testConnection(values);
    const connected = await ext.getConfig();
    applyConfig(connected);
    setStatus(status, statusText, 'ok', 'Connected');
    setStatus(testStatus, testText, 'ok', result.message);
  } catch (error) {
    setStatus(status, statusText, 'error', 'Not connected');
    setStatus(testStatus, testText, 'error', error.message);
    if (!values.token) schedulePairing(values.port);
  } finally {
    buttons.test.disabled = false;
    buttons.test.textContent = 'Test connection';
  }
}

async function saveSettings(event) {
  event.preventDefault();
  let values;
  try {
    values = readForm();
  } catch (error) {
    setStatus(testStatus, testText, 'error', error.message);
    return;
  }
  stopPairing();
  buttons.save.disabled = true;
  buttons.save.textContent = 'Saving';
  try {
    const current = await ext.getConfig();
    let next = { ...current, ...values };
    if (!values.token) {
      if (!ext.canAutoPair) throw new Error('Paste the bridge token from MDM before saving.');
      const paired = await ext.connect(values.port);
      next = { ...paired, autoCapture: values.autoCapture, notifications: values.notifications };
      applyConfig(next);
      setStatus(status, statusText, 'ok', 'Paired automatically');
    }
    await ext.saveConfig(next);
    fields.token.value = next.token;
    setSaveHint(values.token ? 'Saved.' : 'Saved. The token was added automatically.');
    await testConnection();
  } catch (error) {
    setStatus(testStatus, testText, 'error', error.message);
    if (!values.token && ext.canAutoPair) {
      setStatus(status, statusText, 'checking', 'Waiting for MDM');
      schedulePairing(values.port);
    }
  } finally {
    buttons.save.disabled = false;
    buttons.save.textContent = 'Save settings';
  }
}

buttons.reveal.addEventListener('click', () => {
  const revealed = fields.token.type === 'text';
  fields.token.type = revealed ? 'password' : 'text';
  buttons.reveal.textContent = revealed ? 'Show' : 'Hide';
});
buttons.test.addEventListener('click', () => void testConnection());
buttons.reset.addEventListener('click', () => {
  void loadSettings().then(() => {
    setSaveHint('Reloaded the saved settings.');
    testStatus.hidden = true;
  });
});
form.addEventListener('submit', (event) => void saveSettings(event));

void loadSettings();
