import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

const root = process.cwd();
const packaged = process.argv.includes('--packaged');
const executablePath = packaged ? path.join(root, 'release', 'win-unpacked', 'MDM - Mohamed Download Manager.exe') : undefined;
if (packaged) await fsp.access(executablePath);
const userData = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdm-smoke-'));
const downloads = path.join(userData, 'downloads');
await fsp.mkdir(downloads, { recursive: true });

const fixture = Buffer.alloc(768 * 1024 + 37);
for (let index = 0; index < fixture.length; index++) fixture[index] = (index * 17 + 11) % 251;
const fixtureHash = createHash('sha256').update(fixture).digest('hex');

const server = createServer((request, response) => {
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
  if (!range) {
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': fixture.length,
      ETag: '"smoke-fixture"'
    });
    response.end(fixture);
    return;
  }
  const start = Number(range[1]);
  const end = Math.min(range[2] ? Number(range[2]) : fixture.length - 1, fixture.length - 1);
  const body = fixture.subarray(start, end + 1);
  response.writeHead(206, {
    'Content-Type': 'application/octet-stream',
    'Content-Range': `bytes ${start}-${end}/${fixture.length}`,
    'Content-Length': body.length,
    'Accept-Ranges': 'bytes',
    ETag: '"smoke-fixture"'
  });
  response.end(body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const fixturePort = server.address().port;

const bridgeProbe = net.createServer();
await new Promise((resolve) => bridgeProbe.listen(0, '127.0.0.1', resolve));
const bridgePort = bridgeProbe.address().port;
await new Promise((resolve) => bridgeProbe.close(resolve));

let electronApp = null;
try {
  electronApp = await electron.launch({
    executablePath,
    args: packaged ? [] : ['.'],
    cwd: root,
    env: {
      ...process.env,
      MDM_USER_DATA_DIR: userData,
      MDM_DEV: '',
      VITE_DEV_SERVER_URL: ''
    }
  });
  const window = await electronApp.firstWindow({ timeout: 30_000 });
  const pageErrors = [];
  window.on('pageerror', (error) => pageErrors.push(error.message));
  await window.waitForSelector('.app-shell', { timeout: 30_000 });
  assert.match(await window.title(), /MDM/i);

  await window.getByRole('dialog', { name: 'Add MDM to your browser' }).waitFor({ timeout: 10_000 });
  await window.getByRole('button', { name: 'Got it' }).click();

  const appInfo = await window.evaluate(async () => window.mdm.getAppInfo());
  assert.equal(appInfo.ok, true, 'getAppInfo failed');
  assert.equal(appInfo.data.version, '2.4');
  assert.equal(appInfo.data.ytDlpAvailable, true, 'bundled yt-dlp not resolved');
  assert.equal(appInfo.data.ffmpegAvailable, true, 'bundled ffmpeg not resolved');
  await fsp.access(appInfo.data.extensionPath);

  const update = await window.evaluate(
    async (port) => window.mdm.updateSettings({ patch: { bridgePort: port } }),
    bridgePort
  );
  assert.equal(update.ok, true, 'bridge port update failed');

  let bridgeSnapshot = null;
  let health = null;
  for (let attempt = 0; attempt < 50; attempt++) {
    const snapshot = await window.evaluate(async () => window.mdm.getSnapshot());
    assert.equal(snapshot.ok, true, 'getSnapshot failed');
    bridgeSnapshot = snapshot.data;
    try {
      const response = await fetch(`http://127.0.0.1:${bridgePort}/health`, {
        headers: { Authorization: `Bearer ${bridgeSnapshot.bridge.token}` }
      });
      if (response.ok) {
        health = await response.json();
        break;
      }
    } catch {
      // The bridge may still be rebinding after the settings update.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(health?.ok, 'bridge health check failed');
  assert.equal(health.data.app, 'MDM - Mohamed Download Manager');

  const pairResponse = await fetch(`http://127.0.0.1:${bridgePort}/pair`, {
    headers: { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'cors' }
  });
  const pairPayload = await pairResponse.json();
  assert.equal(pairResponse.status, 200, 'extension pairing failed');
  assert.equal(pairPayload.data?.token, bridgeSnapshot.bridge.token);
  const deniedPair = await fetch(`http://127.0.0.1:${bridgePort}/pair`, {
    headers: { Origin: 'https://example.com' }
  });
  assert.equal(deniedPair.status, 403, 'website pairing was not rejected');

  for (const label of ['Queues', 'Schedule', 'Rules', 'Browser', 'Settings', 'Activity log', 'Downloads']) {
    await window.getByRole('button', { name: label, exact: true }).click();
    await window.waitForSelector('.main-shell .page', { timeout: 10_000 });
  }
  await window.waitForTimeout(500);
  assert.deepEqual(pageErrors, []);

  const confirmResponse = await fetch(`http://127.0.0.1:${bridgePort}/download`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bridgeSnapshot.bridge.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      url: `http://127.0.0.1:${fixturePort}/smoke-fixture.bin`,
      fileName: 'smoke-confirmed.bin',
      mediaTitle: 'Smoke video',
      mediaQuality: '1080p',
      confirmDownload: true
    })
  });
  const confirmPayload = await confirmResponse.json();
  assert.equal(confirmResponse.status, 200, `confirmation request failed: ${confirmPayload.error ?? ''}`);
  assert.equal(confirmPayload.data?.pending, true);
  const confirmDialog = window.getByRole('dialog', { name: 'Confirm download' });
  await confirmDialog.waitFor({ timeout: 10_000 });
  await confirmDialog.getByText('Smoke video').first().waitFor();
  await confirmDialog.getByText('1080p', { exact: false }).first().waitFor();
  await confirmDialog.getByRole('textbox', { name: 'Save to' }).fill(downloads);
  await confirmDialog.getByRole('button', { name: 'Start download' }).click();
  await confirmDialog.waitFor({ state: 'hidden', timeout: 10_000 });

  let confirmedRecord = null;
  for (let attempt = 0; attempt < 150; attempt++) {
    const snapshot = await window.evaluate(async () => window.mdm.getSnapshot());
    confirmedRecord = snapshot.data.downloads.find((item) => item.fileName === 'smoke-confirmed.bin') ?? null;
    if (confirmedRecord?.status === 'completed') break;
    if (confirmedRecord?.status === 'failed') throw new Error(`confirmed download failed: ${confirmedRecord.error}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(confirmedRecord?.status, 'completed', 'confirmed download did not complete');
  assert.equal(confirmedRecord?.fileName, 'smoke-confirmed.bin');
  await window.waitForSelector(`[data-download-id="${confirmedRecord.id}"].is-selected`, {
    timeout: 10_000
  });
  await window.locator('.toast', { hasText: 'Download complete' }).first().waitFor({ timeout: 10_000 });

  const added = await window.evaluate(
    async ({ url, destinationDir, checksum }) =>
      window.mdm.addDownload({
        url,
        destinationDir,
        fileName: 'smoke-fixture.bin',
        checksum,
        checksumAlgorithm: 'sha256',
        connections: 3,
        startNow: true
      }),
    {
      url: `http://127.0.0.1:${fixturePort}/smoke-fixture.bin`,
      destinationDir: downloads,
      checksum: fixtureHash
    }
  );
  assert.equal(added.ok, true, `addDownload failed: ${added.error ?? ''}`);

  let record = null;
  for (let attempt = 0; attempt < 150; attempt++) {
    const snapshot = await window.evaluate(async () => window.mdm.getSnapshot());
    assert.equal(snapshot.ok, true);
    record = snapshot.data.downloads.find((item) => item.id === added.data.id) ?? null;
    if (record?.status === 'completed') break;
    if (record?.status === 'failed') throw new Error(`download failed: ${record.error}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(record?.status, 'completed', 'download did not complete');
  assert.equal(record.checksumStatus, 'verified');
  assert.ok(record.targetPath);
  const contents = await fsp.readFile(record.targetPath);
  assert.equal(contents.length, fixture.length);
  assert.equal(createHash('sha256').update(contents).digest('hex'), fixtureHash);
  assert.deepEqual(pageErrors, []);

  let youtube = null;
  const youtubeUrl = process.env.MDM_SMOKE_YOUTUBE_URL;
  if (youtubeUrl) {
    assert.equal(appInfo.data.ytDlpAvailable, true, 'yt-dlp was not found');
    assert.equal(appInfo.data.ffmpegAvailable, true, 'FFmpeg was not found');
    const probeResponse = await fetch(`http://127.0.0.1:${bridgePort}/probe`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bridgeSnapshot.bridge.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ url: youtubeUrl, cookies: '' })
    });
    const probePayload = await probeResponse.json();
    assert.ok(probePayload.ok, `YouTube probe failed: ${probePayload.error ?? probeResponse.status}`);
    assert.equal(probePayload.data.kind, 'youtube');
    assert.ok(probePayload.data.formats.length > 0, 'YouTube probe returned no formats');
    const selected = probePayload.data.formats[probePayload.data.formats.length - 1];
    assert.ok(selected.formatSelector);

    const youtubeAdded = await window.evaluate(
      async (request) => window.mdm.addDownload(request),
      {
        url: youtubeUrl,
        destinationDir: downloads,
        mediaFormatId: selected.id,
        startNow: true
      }
    );
    assert.equal(youtubeAdded.ok, true, `YouTube addDownload failed: ${youtubeAdded.error ?? ''}`);

    let youtubeRecord = null;
    for (let attempt = 0; attempt < 600; attempt++) {
      const snapshot = await window.evaluate(async () => window.mdm.getSnapshot());
      youtubeRecord = snapshot.data.downloads.find((item) => item.id === youtubeAdded.data.id) ?? null;
      if (youtubeRecord?.status === 'completed') break;
      if (youtubeRecord?.status === 'failed') throw new Error(`YouTube download failed: ${youtubeRecord.error}`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(youtubeRecord?.status, 'completed', 'YouTube download did not complete');
    assert.ok(youtubeRecord.targetPath);
    const youtubeStat = await fsp.stat(youtubeRecord.targetPath);
    assert.ok(youtubeStat.size > 0);
    youtube = {
      kind: probePayload.data.kind,
      title: probePayload.data.title,
      formats: probePayload.data.formats.length,
      selected: selected.label,
      selector: selected.formatSelector,
      download: youtubeRecord.status,
      bytes: youtubeStat.size
    };
  }

  console.log(
    JSON.stringify(
      {
        app: health.data.app,
        version: appInfo.data.version,
        bridgePort,
        pairing: 'verified',
        confirmation: 'verified',
        download: record.status,
        checksum: record.checksumStatus,
        bytes: contents.length,
        youtube
      },
      null,
      2
    )
  );
} finally {
  await electronApp?.close().catch(() => undefined);
  await new Promise((resolve) => server.close(resolve));
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await fsp.rm(userData, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}


