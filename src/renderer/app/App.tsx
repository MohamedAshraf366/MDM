import { useApp } from './store';
import { TitleBar } from '../components/TitleBar';
import { Sidebar } from '../components/Sidebar';
import { ToastViewport } from '../components/Toasts';
import { AddDownloadDialog } from '../components/AddDownloadDialog';
import { BrowserDownloadDialog } from '../components/BrowserDownloadDialog';
import { ExtensionSetupDialog } from '../components/ExtensionSetupDialog';
import { DownloadsPage } from '../pages/DownloadsPage';
import { QueuesPage } from '../pages/QueuesPage';
import { SchedulePage } from '../pages/SchedulePage';
import { RulesPage } from '../pages/RulesPage';
import { BrowserPage } from '../pages/BrowserPage';
import { SettingsPage } from '../pages/SettingsPage';
import { LogsPage } from '../pages/LogsPage';
import { BrandMark } from '../components/Icons';
import { Button } from '../components/Ui';

export function App() {
  const { page, loading, fatalError, refresh, snapshot } = useApp();

  if (loading) {
    return (
      <div className="splash">
        <div className="splash-mark">
          <BrandMark size={58} />
        </div>
        <div className="splash-copy">
          <strong>MDM</strong>
          <span>Preparing your downloads…</span>
        </div>
        <span className="splash-line" />
      </div>
    );
  }

  if (fatalError || !snapshot) {
    return (
      <div className="fatal-screen">
        <BrandMark size={52} />
        <h1>MDM could not start</h1>
        <p>{fatalError || 'The application data is unavailable.'}</p>
        <Button variant="primary" icon="refresh" onClick={() => void refresh()}>
          Try again
        </Button>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <TitleBar />
      <div className="workspace">
        <Sidebar />
        <main className="main-shell">
          <div className="page-scroll" key={page}>
            {page === 'downloads' ? <DownloadsPage /> : null}
            {page === 'queues' ? <QueuesPage /> : null}
            {page === 'schedule' ? <SchedulePage /> : null}
            {page === 'rules' ? <RulesPage /> : null}
            {page === 'browser' ? <BrowserPage /> : null}
            {page === 'settings' ? <SettingsPage /> : null}
            {page === 'logs' ? <LogsPage /> : null}
          </div>
        </main>
      </div>
      <AddDownloadDialog />
      <BrowserDownloadDialog />
      <ExtensionSetupDialog />
      <ToastViewport />
    </div>
  );
}
