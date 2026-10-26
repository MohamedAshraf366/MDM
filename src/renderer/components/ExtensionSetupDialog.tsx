import { useEffect, useRef, useState } from 'react';
import { useApp } from '../app/store';
import { Button, Modal, Tabs } from './Ui';

type BrowserTab = 'chrome' | 'firefox';

export function ExtensionSetupDialog() {
  const { snapshot, navigate, call, notify } = useApp();
  const [open, setOpen] = useState(false);
  const [dontShow, setDontShow] = useState(false);
  const [tab, setTab] = useState<BrowserTab>('chrome');
  const checkedStartup = useRef(false);

  useEffect(() => {
    if (!snapshot || checkedStartup.current) return;
    checkedStartup.current = true;
    if (snapshot.settings.showExtensionSetupOnStartup) setOpen(true);
  }, [snapshot]);

  const dismiss = () => {
    if (dontShow) {
      void call(
        window.mdm.updateSettings({ patch: { showExtensionSetupOnStartup: false } }),
        'Extension setup reminder disabled'
      );
    }
    setOpen(false);
    setDontShow(false);
  };

  const openFolder = async () => {
    const result = await window.mdm.openResourcesFolder();
    if (!result.ok) notify('error', 'Could not open resources folder', result.error);
  };

  const openBrowserPage = () => {
    setOpen(false);
    navigate('browser');
  };

  return (
    <Modal
      open={open}
      onClose={dismiss}
      title="Add MDM to your browser"
      subtitle="One manual confirmation is required by Chrome, Edge, and Firefox."
      width={660}
      footer={
        <>
          <label className="extension-setup-check">
            <span className="checkbox">
              <input
                type="checkbox"
                checked={dontShow}
                onChange={(event) => setDontShow(event.target.checked)}
              />
              <span />
            </span>
            <span>Don&apos;t show this again</span>
          </label>
          <Button size="sm" icon="puzzle" onClick={openBrowserPage}>
            Full guide
          </Button>
          <Button size="sm" icon="folder" onClick={() => void openFolder()}>
            Open resources folder
          </Button>
          <Button variant="primary" size="sm" onClick={dismiss}>
            Got it
          </Button>
        </>
      }
    >
      <p className="extension-setup-intro">
        Open the app resources folder to find the extension folder. Complete these steps in the browser you chose
        during installation.
      </p>
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
              <p>
                Visit <code>chrome://extensions</code> or <code>edge://extensions</code>.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Turn on Developer mode</strong>
              <p>Use the toggle in the top-right corner of the page.</p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Choose Load unpacked</strong>
              <p>
                Select the extension folder inside the opened resources folder, or paste the path copied during
                installation.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Pin MDM and open it</strong>
              <p>The extension pairs with MDM automatically and fills in its token.</p>
            </div>
          </li>
        </ol>
      ) : (
        <ol className="install-steps">
          <li>
            <span>1</span>
            <div>
              <strong>Open debugging tools</strong>
              <p>
                Visit <code>about:debugging#/runtime/this-firefox</code>.
              </p>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Load a temporary add-on</strong>
              <p>Click Load Temporary Add-on.</p>
            </div>
          </li>
          <li>
            <span>3</span>
            <div>
              <strong>Select the manifest</strong>
              <p>
                Choose <code>firefox\manifest.json</code> inside the extension folder.
              </p>
            </div>
          </li>
          <li>
            <span>4</span>
            <div>
              <strong>Pair and reload</strong>
              <p>It pairs automatically. Reload it after Firefox restarts.</p>
            </div>
          </li>
        </ol>
      )}
    </Modal>
  );
}
