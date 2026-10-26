import { useEffect, useState } from 'react';
import type { ChecksumAlgorithm, DownloadRecord } from '../../shared/types';
import { parseByteSize } from '../../shared/format';
import { useApp } from '../app/store';
import { Button, Field, Modal, Select, TextArea, TextInput, Toggle } from './Ui';

export function EditDownloadDialog({
  record,
  open,
  onClose
}: {
  record: DownloadRecord | null;
  open: boolean;
  onClose: () => void;
}) {
  const { call, notify } = useApp();
  const [fileName, setFileName] = useState('');
  const [destination, setDestination] = useState('');
  const [speedLimit, setSpeedLimit] = useState('');
  const [checksum, setChecksum] = useState('');
  const [algorithm, setAlgorithm] = useState<ChecksumAlgorithm | ''>('');
  const [autoOpen, setAutoOpen] = useState(false);
  const [referrer, setReferrer] = useState('');
  const [headers, setHeaders] = useState('');
  const [cookies, setCookies] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !record) return;
    setFileName(record.fileName);
    setDestination(record.destinationDir);
    setSpeedLimit(record.speedLimitBps ? String(Math.round(record.speedLimitBps / 1024)) : '');
    setChecksum(record.checksum);
    setAlgorithm(record.checksumAlgorithm);
    setAutoOpen(record.autoOpen);
    setReferrer(record.referrer);
    setHeaders(Object.entries(record.headers).map(([key, value]) => `${key}: ${value}`).join('\n'));
    setCookies(record.cookies);
    setAdvanced(false);
  }, [open, record]);

  if (!record) return null;

  const chooseFolder = async () => {
    const result = await window.mdm.chooseFolder(destination);
    if (result.ok && result.data) setDestination(result.data);
    else if (!result.ok) notify('error', 'Could not choose folder', result.error);
  };

  const save = async () => {
    setSaving(true);
    try {
      const speed = speedLimit.trim() ? Math.max(0, (parseByteSize(`${speedLimit} KB`) ?? 0)) : 0;
      const parsedHeaders: Record<string, string> = {};
      for (const line of headers.split('\n')) {
        if (!line.trim()) continue;
        const separator = line.indexOf(':');
        if (separator < 1) throw new Error(`Invalid header line: ${line}`);
        parsedHeaders[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
      }
      const result = await call(
        window.mdm.updateDownload(record.id, {
          fileName: fileName.trim() || record.fileName,
          destinationDir: destination.trim() || record.destinationDir,
          speedLimitBps: speed,
          checksum: checksum.trim(),
          checksumAlgorithm: algorithm,
          autoOpen,
          referrer,
          headers: parsedHeaders,
          cookies
        })
      );
      if (result) {
        notify('success', 'Download updated');
        onClose();
      }
    } catch (error) {
      notify('error', 'Could not update download', (error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit download"
      subtitle="Changes to the URL, name, or folder reset progress for this item."
      width={640}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()} loading={saving} icon="check">
            Save changes
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="File name" className="span-2">
          <TextInput value={fileName} onChange={(event) => setFileName(event.target.value)} />
        </Field>
        <Field label="Save to" className="span-2" hint="A category folder is applied automatically unless you choose a folder.">
          <div className="input-row">
            <TextInput value={destination} onChange={(event) => setDestination(event.target.value)} />
            <Button icon="folder" onClick={() => void chooseFolder()}>
              Browse
            </Button>
          </div>
        </Field>
        <Field label="Speed limit" hint="KB/s. Leave blank for unlimited.">
          <TextInput
            type="number"
            min={0}
            placeholder="Unlimited"
            value={speedLimit}
            onChange={(event) => setSpeedLimit(event.target.value)}
          />
        </Field>
        <Field label="Checksum algorithm">
          <Select value={algorithm} onChange={(event) => setAlgorithm(event.target.value as ChecksumAlgorithm | '')}>
            <option value="">None</option>
            <option value="sha256">SHA-256</option>
            <option value="sha1">SHA-1</option>
            <option value="md5">MD5</option>
          </Select>
        </Field>
        <Field label="Expected checksum">
          <TextInput
            value={checksum}
            onChange={(event) => setChecksum(event.target.value)}
            placeholder="Hex digest"
            disabled={!algorithm}
          />
        </Field>
        <div className="setting-row span-2">
          <div>
            <strong>Open when complete</strong>
            <p>Only opens files that are not executable.</p>
          </div>
          <Toggle checked={autoOpen} onChange={setAutoOpen} label="Open when complete" />
        </div>
        <div className="span-2 advanced-toggle">
          <button type="button" className="text-button" onClick={() => setAdvanced((value) => !value)}>
            {advanced ? 'Hide request options' : 'Show request options'}
          </button>
        </div>
        {advanced ? (
          <>
            <Field label="Referrer">
              <TextInput value={referrer} onChange={(event) => setReferrer(event.target.value)} placeholder="https://…" />
            </Field>
            <Field label="Cookies">
              <TextInput value={cookies} onChange={(event) => setCookies(event.target.value)} placeholder="name=value; …" />
            </Field>
            <Field label="HTTP headers" className="span-2" hint="One Name: value pair per line. Sensitive headers are stored encrypted.">
              <TextArea
                rows={4}
                value={headers}
                onChange={(event) => setHeaders(event.target.value)}
                placeholder="Authorization: Bearer …"
              />
            </Field>
          </>
        ) : null}
      </div>
    </Modal>
  );
}
