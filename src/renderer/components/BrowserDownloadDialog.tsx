import { useEffect, useState } from 'react';
import { useApp } from '../app/store';
import { Button, Field, InlineNote, Modal, TextInput, Toggle } from './Ui';
import { Icon } from './Icons';

export function BrowserDownloadDialog() {
  const { browserDownload, closeBrowserDownload, appInfo, focusDownload, navigate, notify } = useApp();
  const [destination, setDestination] = useState('');
  const [tlsAllowInsecure, setTlsAllowInsecure] = useState(false);
  const [turboMode, setTurboMode] = useState(true);
  const [connections, setConnections] = useState(16);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!browserDownload) return;
    setDestination(browserDownload.destinationDir);
    setTlsAllowInsecure(false);
    setTurboMode(true);
    setConnections(16);
    setSaving(false);
    setError('');
  }, [browserDownload]);

  if (!browserDownload) return null;

  const request = browserDownload.request;
  const title = request.mediaTitle || request.fileName || 'Video download';
  const detail = [request.mediaQuality, request.fileName].filter(Boolean).join(' · ');
  const defaultFolder = appInfo?.downloadsPath ?? '';

  const chooseFolder = async () => {
    const result = await window.mdm.chooseFolder(destination || defaultFolder);
    if (result.ok && result.data) setDestination(result.data);
    else if (!result.ok) notify('error', 'Could not choose folder', result.error);
  };

  const start = async () => {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      const result = await window.mdm.addDownload({
        url: request.url,
        fileName: request.fileName,
        headers: request.headers,
        cookies: request.cookies,
        referrer: request.referrer,
        sourcePageUrl: request.sourcePageUrl,
        mediaFormatId: request.mediaFormatId,
        mediaEngine: request.mediaEngine,
        tlsAllowInsecure,
        turboMode,
        connections,
        destinationDir: destination.trim() || undefined,
        startNow: true
      });
      if (!result.ok) throw new Error(result.error ?? 'The download could not be started.');
      if (result.data?.duplicateOf) {
        notify('info', 'Already in your queue', 'MDM found an active download for this link.');
      }
      const downloadId = result.data?.duplicateOf ?? result.data?.id;
      closeBrowserDownload();
      if (downloadId) focusDownload(downloadId);
      else navigate('downloads');
    } catch (startError) {
      const reason = (startError as Error).message;
      setError(reason);
      notify('error', 'Download failed to start', reason, {
        dedupeKey: `download-start-failed:${reason}`,
        actions: [{ kind: 'open-logs', label: 'View logs' }]
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={closeBrowserDownload}
      title="Confirm download"
      subtitle="Review the file and choose where MDM should save it. Nothing starts until you confirm."
      width={560}
      footer={
        <>
          <Button onClick={closeBrowserDownload}>Cancel</Button>
          <Button variant="primary" icon="download" loading={saving} onClick={() => void start()}>
            Start download
          </Button>
        </>
      }
    >
      <div className="add-form">
        <div className="download-confirm-summary">
          <span className="download-confirm-icon">
            <Icon name="video" size={21} />
          </span>
          <div>
            <strong>{title}</strong>
            <span>{detail || 'Selected video'}</span>
          </div>
        </div>
        <Field label="Save to" hint="Leave blank to use your category folders.">
          <div className="input-row">
            <TextInput
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
              placeholder={defaultFolder || 'Downloads'}
              spellCheck={false}
            />
            <Button icon="folder" onClick={() => void chooseFolder()}>
              Browse
            </Button>
          </div>
        </Field>
        <div className="setting-row">
          <div>
            <strong>Allow invalid TLS certificates</strong>
            <p>Only for servers whose certificate the browser accepts but MDM cannot verify (missing chain, self-signed).</p>
          </div>
          <Toggle checked={tlsAllowInsecure} onChange={setTlsAllowInsecure} label="Allow invalid TLS certificates" />
        </div>
        <div className="setting-row">
          <div>
            <strong>Turbo mode</strong>
            <p>Automatically grow connections until speed stops rising. Default ON.</p>
          </div>
          <Toggle checked={turboMode} onChange={setTurboMode} label="Turbo mode" />
        </div>
        <div className="setting-row">
          <div>
            <strong>Most connections</strong>
            <p>2–64. More connections can use more bandwidth on multi-segment servers.</p>
          </div>
          <div style={{ width: 120 }}>
            <TextInput
              type="number"
              min={2}
              max={64}
              value={String(connections)}
              onChange={(event) => setConnections(Math.max(2, Math.min(64, Number(event.target.value) || 16)))}
            />
          </div>
        </div>
        {error ? <InlineNote tone="danger">{error}</InlineNote> : null}
      </div>
    </Modal>
  );
}
