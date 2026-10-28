import { useEffect, useState } from 'react';
import { useApp } from '../app/store';
import { copyText } from '../lib/clipboard';
import {
  Button,
  Card,
  ConfirmDialog,
  InlineNote,
  PageHeader,
  Tabs,
  TextInput,
  Toggle
} from '../components/Ui';
import { Icon } from '../components/Icons';

type TestState = { state: 'idle' | 'testing' | 'ok' | 'error'; message: string };

export function BrowserPage() {
  const { snapshot, navigate, call, notify } = useApp();
  const settings = snapshot?.settings;
  const [port, setPort] = useState(String(settings?.bridgePort ?? 41731));
  const [revealed, setRevealed] = useState(false);
  const [testing, setTesting] = useState<TestState>({ state: 'idle', message: '' });
  const [savingPort, setSavingPort] = useState(false);
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [tab, setTab] = useState<'chrome' | 'firefox'>('chrome');
  const enabled = settings?.browserIntegrationEnabled ?? false;
  const token = settings?.bridgeToken ?? '';
  const bridgeUrl = `http://127.0.0.1:${settings?.bridgePort ?? 41731}`;

  useEffect(() => {
    setPort(String(settings?.bridgePort ?? 41731));
  }, [settings?.bridgePort]);

  useEffect(() => {
    if (!enabled) {
      setTesting({ state: 'idle', message: 'Enable browser integration to connect the extension.' });
      return;
    }
    const timer = window.setTimeout(() => void runTest(), 350);
    return () => window.clearTimeout(timer);
  }, [enabled, settings?.bridgePort, settings?.bridgeToken]);

  const runTest = async () => {
    setTesting({ state: 'testing', message: 'Checking the local bridge…' });
    try {
      const result = await window.mdm.testBridge();
      if (result.ok && result.data?.ok) {
        setTesting({ state: 'ok', message: result.data.message });
      } else {
        setTesting({ state: 'error', message: result.data?.message ?? result.error ?? 'The bridge did not respond.' });
      }
    } catch (error) {
      setTesting({ state: 'error', message: (error as Error).message });
    }
  };

  const toggleIntegration = async (value: boolean) => {
    await call(
      window.mdm.updateSettings({ patch: { browserIntegrationEnabled: value } }),
      value ? 'Browser integration enabled' : 'Browser integration disabled'
    );
  };

  const applyPort = async () => {
    const parsed = Number(port);
    if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
      notify('error', 'Invalid port', 'Choose a port between 1024 and 65535.');
      return;
    }
    if (parsed === settings?.bridgePort) return;
    setSavingPort(true);
    const result = await call(
      window.mdm.updateSettings({ patch: { bridgePort: parsed } }),
      `Bridge moved to port ${parsed}`
    );
    setSavingPort(false);
    if (!result) setPort(String(settings?.bridgePort ?? 41731));
  };

  const copy = async (value: string, label: string) => {
    try {
      await copyText(value);
      notify('success', `${label} copied`);
    } catch (error) {
      notify('error', 'Could not copy', (error as Error).message);
    }
  };

  return (
    <div className="page">
      <PageHeader
        eyebrow="Connections"
        title="Browser integration"
        description="Send downloads from your browser to MDM without exposing a public server."
        actions={
          <Button variant="primary" icon="puzzle" onClick={() => void window.mdm.openExtensionFolder().then((result) => {
            if (!result.ok) notify('error', 'Could not open extension folder', result.error);
          })}>
            Open extension folder
          </Button>
        }
      />

      <section className="browser-hero">
        <div className="browser-hero-glow" />
        <div className="browser-hero-copy">
          <span className="browser-hero-icon">
            <Icon name="puzzle" size={30} />
          </span>
          <div>
            <span className="page-eyebrow">Local bridge</span>
            <h2>Your browser, one hop away.</h2>
            <p>
              MDM listens on a loopback-only port. Chrome and Edge pair automatically with a private token; Firefox
              users paste the token shown below. Other devices on your network cannot reach the bridge.
            </p>
          </div>
        </div>
        <div className="browser-hero-status">
          <span className={`bridge-state bridge-state-${testing.state}`}>
            <span className="bridge-state-dot" />
            {testing.state === 'ok'
              ? 'Connected'
              : testing.state === 'error'
                ? 'Not responding'
                : testing.state === 'testing'
                  ? 'Checking…'
                  : enabled
                    ? 'Ready to test'
                    : 'Bridge off'}
          </span>
          <code>{bridgeUrl}</code>
          <Button size="sm" icon="activity" loading={testing.state === 'testing'} onClick={() => void runTest()} disabled={!enabled}>
            Test connection
          </Button>
        </div>
      </section>

      {testing.state === 'error' ? <InlineNote tone="danger">{testing.message}</InlineNote> : null}
      {testing.state === 'ok' ? <InlineNote tone="success">{testing.message}</InlineNote> : null}

      <div className="browser-grid">
        <Card title="Bridge settings" subtitle="Changes apply immediately.">
          <div className="setting-row">
            <div>
              <strong>Enable browser integration</strong>
              <p>Start the local bridge and accept downloads sent by the extension.</p>
            </div>
            <Toggle checked={enabled} onChange={(value) => void toggleIntegration(value)} label="Enable browser integration" />
          </div>
          <div className="setting-row">
            <div>
              <strong>Listening address</strong>
              <p>Loopback IPv4 only. The port must be available on this computer.</p>
            </div>
            <div className="input-row setting-input">
              <TextInput value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" aria-label="Bridge port" />
              <Button loading={savingPort} disabled={!enabled} onClick={() => void applyPort()}>
                Apply
              </Button>
            </div>
          </div>
          <div className="setting-row">
            <div>
              <strong>Extension token</strong>
              <p>Used for automatic pairing in Chrome/Edge and manual pairing in Firefox. Treat it like a local password.</p>
            </div>
            <div className="token-row">
              <code className={`token-value ${revealed ? '' : 'is-masked'}`.trim()}>
                {revealed ? token : maskToken(token)}
              </code>
              <Button size="sm" icon={revealed ? 'shield' : 'key'} onClick={() => setRevealed((value) => !value)}>
                {revealed ? 'Hide' : 'Reveal'}
              </Button>
              <Button size="sm" icon="copy" onClick={() => void copy(token, 'Bridge token')}>
                Copy
              </Button>
            </div>
          </div>
          <div className="setting-row is-last">
            <div>
              <strong>Rotate token</strong>
              <p>Chrome and Edge pair automatically. Firefox uses a random extension origin, so paste the token above.</p>
            </div>
            <Button variant="danger" size="sm" icon="refresh" onClick={() => setRegenerateOpen(true)}>
              Regenerate
            </Button>
          </div>
          <InlineNote tone="info">
            The token is generated locally and stored with Windows DPAPI protection. It is shared only with the
            pinned Chrome/Edge extension during pairing (or copied by you for Firefox) and never sent to websites.
          </InlineNote>
        </Card>

        <Card title="Security model">
          <ul className="security-list">
            <li>
              <span className="security-icon"><Icon name="server" size={16} /></span>
              <div>
                <strong>Loopback only</strong>
                <p>Binds to 127.0.0.1, never to a LAN interface.</p>
              </div>
            </li>
            <li>
              <span className="security-icon"><Icon name="key" size={16} /></span>
              <div>
                <strong>Bearer token</strong>
                <p>Timing-safe comparison on every request, with rate limiting.</p>
              </div>
            </li>
            <li>
              <span className="security-icon"><Icon name="shield" size={16} /></span>
              <div>
                <strong>Bounded requests</strong>
                <p>JSON only, 64 KB maximum body, validated URLs and headers.</p>
              </div>
            </li>
            <li>
              <span className="security-icon"><Icon name="puzzle" size={16} /></span>
              <div>
                <strong>Pinned extension</strong>
                <p>Chrome and Edge pairing accepts only this extension's ID. Firefox uses the manual token.</p>
              </div>
            </li>
          </ul>
          <div className="bridge-endpoints">
            <span>GET /pair</span>
            <span>POST /download</span>
            <span>POST /probe</span>
            <span>GET /health</span>
            <span>GET /queues</span>
          </div>
        </Card>
      </div>

      <Card
        title="Install the extension"
        subtitle="The extension is unpacked, so it receives updates with MDM."
        actions={
          <Button size="sm" icon="folder" onClick={() => void window.mdm.openExtensionFolder().then((result) => {
            if (!result.ok) notify('error', 'Could not open extension folder', result.error);
          })}>
            Show folder
          </Button>
        }
      >
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'chrome', label: 'Chrome and Edge' },
            { value: 'firefox', label: 'Firefox' }
          ]}
        />
        {tab === 'chrome' ? (
          <ol className="install-steps">
            <li>
              <span>1</span>
              <div>
                <strong>Open the extensions page</strong>
                <p>Visit <code>chrome://extensions</code> or <code>edge://extensions</code>.</p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>Turn on developer mode</strong>
                <p>The toggle is in the top-right corner of the extensions page.</p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>Choose “Load unpacked”</strong>
                <p>Select the extension folder opened by MDM, then pin the extension.</p>
              </div>
            </li>
            <li>
              <span>4</span>
              <div>
                <strong>Open the extension</strong>
                <p>It pairs with MDM automatically while the app is running. If pairing fails, paste the token above into its settings.</p>
              </div>
            </li>
          </ol>
        ) : (
          <ol className="install-steps">
            <li>
              <span>1</span>
              <div>
                <strong>Open debugging tools</strong>
                <p>Visit <code>about:debugging#/runtime/this-firefox</code>.</p>
              </div>
            </li>
            <li>
              <span>2</span>
              <div>
                <strong>Load a temporary add-on</strong>
                <p>Choose “Load Temporary Add-on” and select <code>manifest.json</code> in the Firefox extension folder.</p>
              </div>
            </li>
            <li>
              <span>3</span>
              <div>
                <strong>Open the add-on</strong>
                <p>Copy the token above into the add-on's settings. Firefox uses a per-profile extension origin, so MDM cannot verify it automatically.</p>
              </div>
            </li>
            <li>
              <span>4</span>
              <div>
                <strong>Reload after updates</strong>
                <p>Firefox removes temporary add-ons when it restarts. Load it again from the same folder.</p>
              </div>
            </li>
          </ol>
        )}
        <div className="browser-tip">
          <Icon name="info" size={16} />
          Right-click a link or video and choose “Download with MDM”, or use the “Download video with MDM” control on
          video pages to pick a quality. Video downloads open a confirmation window in MDM so you can choose the
          folder before starting.
        </div>
      </Card>

      <div className="browser-lower">
        <Card title="Site rules" subtitle="Decide how each site is handled.">
          <p className="aside-copy">
            Create rules to auto-capture, review, or ignore browser downloads from specific hosts. Site rules work
            together with category routing.
          </p>
          <Button size="sm" icon="rules" onClick={() => navigate('rules')}>
            Manage site rules
          </Button>
        </Card>
        <Card title="Troubleshooting">
          <details className="troubleshoot">
            <summary>The extension says it cannot reach MDM</summary>
            <p>Confirm the bridge is enabled, the port matches, and the token was copied without spaces.</p>
          </details>
          <details className="troubleshoot">
            <summary>Bridge status shows a port conflict</summary>
            <p>Change the bridge port above and update the port in the extension options.</p>
          </details>
          <details className="troubleshoot">
            <summary>Downloads open in the browser instead</summary>
            <p>Disable the browser’s built-in download prompt for that file type, or use the context-menu command.</p>
          </details>
        </Card>
      </div>

      <ConfirmDialog
        open={regenerateOpen}
        title="Regenerate the bridge token?"
        message="The extension will stop connecting until you paste the new token into its options."
        confirmLabel="Regenerate token"
        danger
        onCancel={() => setRegenerateOpen(false)}
        onConfirm={() => {
          setRegenerateOpen(false);
          void call(window.mdm.regenerateBridgeToken(), 'Bridge token regenerated');
        }}
      />
    </div>
  );
}

function maskToken(token: string): string {
  if (!token) return 'Not generated';
  return `${'•'.repeat(Math.min(20, Math.max(6, token.length - 6)))}${token.slice(-6)}`;
}
