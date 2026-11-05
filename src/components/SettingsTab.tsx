import React, { useEffect, useReducer, useState } from 'react';
import { Clock, Database, Download, ShieldAlert, Trash2, Upload } from 'lucide-react';
import { store, getBackupFilename } from '../store';
import { onWriteResult } from '../utils/cookieStorage';
import { downloadFile, lastBackupTime, recordBackupTime } from '../utils/download';
import { useToast } from '../ui/toastContext';
import { useConfirm } from '../ui/confirmContext';

/** Storage use above this share of the cookie budget shows a warning. */
const STORAGE_WARN_RATIO = 0.8;
/** Typed into the danger zone before the erase button arms. */
const ERASE_PHRASE = 'ERASE';

/** Re-renders when the store changes or a cookie write finishes. Returns a function to force a re-render. */
function useRefreshOnChange(): () => void {
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const offStore = store.subscribe(() => refresh());
    const offCookies = onWriteResult(() => refresh());
    return () => {
      offStore();
      offCookies();
    };
  }, []);
  return refresh;
}

function formatKB(bytes: number): string {
  return `${(bytes / 1000).toFixed(1)} KB`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function fileSafe(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 60) || 'case';
}

async function readText(file: File): Promise<string | null> {
  try {
    return await file.text();
  } catch {
    return null;
  }
}

const YourDataSection: React.FC = () => {
  const refresh = useRefreshOnChange();
  const toast = useToast();
  const confirm = useConfirm();
  const cases = store.data.cases;
  const [pickedCaseId, setPickedCaseId] = useState('');
  const selectedId = cases.some((c) => c.id === pickedCaseId) ? pickedCaseId : (cases[0]?.id ?? '');
  const selectedName = store.getCase(selectedId)?.name ?? 'case';
  const { bytesUsed } = store.getStorageUsage();
  const lastBackup = lastBackupTime();
  const showReminder = lastBackup === null && bytesUsed > 0;

  const handleDownloadBackup = () => {
    downloadFile(getBackupFilename(), store.exportWorkspace(), 'application/json');
    recordBackupTime();
    refresh();
    toast.show('Workspace backup downloaded.', 'success');
  };

  const handleRestore = async (file: File) => {
    const text = await readText(file);
    if (text === null) {
      toast.show('Could not read that file.', 'error');
      return;
    }
    const ok = await confirm({
      title: 'Replace the whole workspace?',
      message:
        'Restoring replaces every case and the audit trail with the contents of this backup. ' +
        'Download a backup of your current data first if you need it. Continue?',
      confirmLabel: 'Replace workspace',
      tone: 'danger',
    });
    if (!ok) return;
    const result = store.importWorkspace(text);
    toast.show(result.msg, result.success ? 'success' : 'error');
  };

  const handleDownloadCase = () => {
    const json = store.exportCase(selectedId);
    if (!json) {
      toast.show('Select a case to download.', 'error');
      return;
    }
    downloadFile(`case-${fileSafe(selectedName)}-${today()}.json`, json, 'application/json');
    toast.show(`Downloaded case "${selectedName}".`, 'success');
  };

  const handleDownloadCsv = (table: 'entities' | 'incidents') => {
    const csv = store.exportCasesCsv(selectedId);
    const text = csv[table];
    if (!text) {
      toast.show('Select a case to download.', 'error');
      return;
    }
    downloadFile(`${fileSafe(selectedName)}-${table}-${today()}.csv`, text, 'text/csv');
    toast.show(`Downloaded ${table} CSV for "${selectedName}".`, 'success');
  };

  const handleImportCase = async (file: File) => {
    const text = await readText(file);
    if (text === null) {
      toast.show('Could not read that file.', 'error');
      return;
    }
    const result = store.importCase(text);
    toast.show(result.msg, result.success ? 'success' : 'error');
  };

  const noCases = cases.length === 0;

  return (
    <section className="premium-panel settings-section" aria-labelledby="settings-data-title">
      <h2 id="settings-data-title" className="premium-panel-title">
        <Database size={14} aria-hidden="true" /> Your data
      </h2>
      <p>
        All of your data lives in this browser&apos;s cookies on this site. None of it is stored on a server. If the
        cookies are cleared or erased, the data is lost, so download backups and keep them somewhere safe.
      </p>

      {showReminder && (
        <div role="status" className="alert alert-info settings-reminder">
          <Download size={16} aria-hidden="true" />
          <span>You have not downloaded a backup yet. Download a full backup now.</span>
        </div>
      )}

      <p className="settings-muted" data-testid="last-backup">
        <Clock size={12} aria-hidden="true" />{' '}
        {lastBackup
          ? `Last backup downloaded ${lastBackup.toLocaleString()}.`
          : 'No backup downloaded in this tab yet.'}
      </p>

      <div className="settings-row settings-row-wrap">
        <button type="button" className="premium-button" onClick={handleDownloadBackup}>
          <Download size={14} aria-hidden="true" /> Download full backup (.json)
        </button>
      </div>
      <p className="settings-muted">
        A full backup holds every case, the audit trail and your settings. AI API keys are never included. Keep it private.
      </p>

      <div className="settings-field">
        <label htmlFor="settings-restore-file">Restore from backup</label>
        <input
          id="settings-restore-file"
          type="file"
          accept=".json,application/json"
          className="settings-file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void handleRestore(file);
          }}
        />
        <p className="settings-muted">Restoring replaces the whole workspace.</p>
      </div>

      <div className="settings-field">
        <label htmlFor="settings-case-select">Download one case</label>
        <select
          id="settings-case-select"
          className="premium-input"
          value={selectedId}
          disabled={noCases}
          onChange={(e) => setPickedCaseId(e.target.value)}
        >
          {noCases && <option value="">No cases yet</option>}
          {cases.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <div className="settings-row settings-row-wrap">
          <button type="button" className="premium-button" onClick={handleDownloadCase} disabled={noCases}>
            <Download size={14} aria-hidden="true" /> Download case (.json)
          </button>
          <button type="button" className="premium-button" onClick={() => handleDownloadCsv('entities')} disabled={noCases}>
            <Download size={14} aria-hidden="true" /> Download entities CSV
          </button>
          <button type="button" className="premium-button" onClick={() => handleDownloadCsv('incidents')} disabled={noCases}>
            <Download size={14} aria-hidden="true" /> Download incidents CSV
          </button>
        </div>
        <p className="settings-muted">Downloads include everything in the case, including classified-labelled items. CSV files open in Excel.</p>
      </div>

      <div className="settings-field">
        <label htmlFor="settings-case-import">Import a case file</label>
        <input
          id="settings-case-import"
          type="file"
          accept=".json,application/json"
          className="settings-file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void handleImportCase(file);
          }}
        />
        <p className="settings-muted">
          <Upload size={12} aria-hidden="true" /> Imported cases are added as new cases with fresh IDs.
        </p>
      </div>
    </section>
  );
};

const StorageSection: React.FC = () => {
  useRefreshOnChange();
  const { bytesUsed, budgetBytes, cookies } = store.getStorageUsage();
  const ratio = budgetBytes > 0 ? bytesUsed / budgetBytes : 0;
  const percent = Math.min(100, Math.round(ratio * 100));
  const warn = ratio > STORAGE_WARN_RATIO;
  return (
    <section className="premium-panel settings-section" aria-labelledby="settings-storage-title">
      <h2 id="settings-storage-title" className="premium-panel-title">
        <Database size={14} aria-hidden="true" /> Storage
      </h2>
      <p>
        {formatKB(bytesUsed)} of {formatKB(budgetBytes)} used ({percent}%) across {cookies} cookies on this site.
      </p>
      <div
        className="progress-bar"
        role="progressbar"
        aria-label="Cookie storage used"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent}% of the cookie budget used`}
      >
        <div className={warn ? 'progress-fill settings-meter-warn' : 'progress-fill'} style={{ width: `${percent}%` }} />
      </div>
      {warn && (
        <div role="alert" className="alert alert-warning">
          <ShieldAlert size={16} aria-hidden="true" />
          <span>
            Storage is more than 80% full. Download a backup, then delete old cases or audit entries before adding more data.
          </span>
        </div>
      )}
    </section>
  );
};

const DangerSection: React.FC = () => {
  const toast = useToast();
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const armed = phrase === ERASE_PHRASE && !busy;

  const handleErase = async () => {
    setBusy(true);
    const result = await store.eraseAllLocalData();
    if (result.success) {
      window.location.reload();
      return;
    }
    setBusy(false);
    toast.show(`${result.msg} Reload the page before continuing.`, 'error');
  };

  return (
    <section className="premium-panel settings-section settings-danger" aria-labelledby="settings-danger-title">
      <h2 id="settings-danger-title" className="premium-panel-title">
        <ShieldAlert size={14} aria-hidden="true" /> Danger zone
      </h2>
      <p>
        Erase all local data deletes every case, audit entry and setting stored in this browser, then reloads the
        app. This cannot be undone. Download a full backup first.
      </p>
      <div className="settings-field">
        <label htmlFor="settings-erase-phrase">
          Type {ERASE_PHRASE} to confirm
        </label>
        <input
          id="settings-erase-phrase"
          className="premium-input"
          autoComplete="off"
          value={phrase}
          disabled={busy}
          onChange={(e) => setPhrase(e.target.value)}
        />
      </div>
      <div className="settings-row">
        <button type="button" className="premium-button settings-danger-button" disabled={!armed} onClick={() => void handleErase()}>
          <Trash2 size={14} aria-hidden="true" /> Erase all local data
        </button>
      </div>
    </section>
  );
};

const PrivacySection: React.FC = () => (
  <section className="premium-panel settings-section" aria-labelledby="settings-privacy-title">
    <h2 id="settings-privacy-title" className="premium-panel-title">
      <Database size={14} aria-hidden="true" /> Privacy: where your data lives
    </h2>
    <dl className="settings-privacy">
      <dt>Cookies (this site only, kept up to one year)</dt>
      <dd>
        The workspace: cases, entities, incidents, signals, the audit trail, the theme, and each AI provider's enabled flag and model name. Cookies are sent with every request to this site,
        so the workspace is compressed and capped at about 16 KB.
      </dd>
      <dt>sessionStorage (this tab only, cleared when it closes)</dt>
      <dd>AI provider API keys, the time of the last backup download, and a copy of workspace data that could not be read.</dd>
    </dl>
    <p className="settings-muted">Backup files are not encrypted. Keep them private.</p>
  </section>
);

export const SettingsTab: React.FC = () => (
  <div id="SettingsPanel" className="settings-tab">
    <YourDataSection />
    <StorageSection />
    <DangerSection />
    <PrivacySection />
  </div>
);
