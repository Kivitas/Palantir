import React, { useEffect, useReducer, useState } from 'react';
import { Database, Download, KeyRound, ShieldAlert, Trash2, Upload, Users } from 'lucide-react';
import { store } from '../store';
import { CLEARANCE_LEVELS, type ClearanceLevel } from '../types';
import { onWriteResult } from '../utils/cookieStorage';
import { useToast } from '../ui/toastContext';
import { useConfirm } from '../ui/confirmContext';

/** Storage use above this share of the cookie budget shows a warning. */
const STORAGE_WARN_RATIO = 0.8;
/** Typed into the danger zone before the erase button arms. */
const ERASE_PHRASE = 'ERASE';
/** Mirrors the store's minimum password length (the store enforces it; this is for the hint). */
const MIN_PASSWORD_LENGTH = 8;
const CLEARANCES = Object.keys(CLEARANCE_LEVELS) as ClearanceLevel[];

/** Re-renders when the store changes or a cookie write finishes (usage figures change then). */
function useRefreshOnChange(): void {
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const offStore = store.subscribe(() => refresh());
    const offCookies = onWriteResult(() => refresh());
    return () => {
      offStore();
      offCookies();
    };
  }, []);
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

function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function readText(file: File): Promise<string | null> {
  try {
    return await file.text();
  } catch {
    return null;
  }
}

const DefaultPasswordBanner: React.FC = () => {
  useRefreshOnChange();
  if (store.data.current_user !== 'admin' || !store.isDefaultAdminPassword()) return null;
  return (
    <div role="alert" className="alert alert-danger settings-banner">
      <ShieldAlert size={18} aria-hidden="true" />
      <div>
        <strong>The admin account still uses the default password.</strong>
        <span>Anyone who knows the default can sign in as admin. Change it in the Account section below.</span>
      </div>
    </div>
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
            Storage is more than 80% full. Export a backup, then delete old cases or audit entries before adding more data.
          </span>
        </div>
      )}
    </section>
  );
};

const BackupSection: React.FC = () => {
  useRefreshOnChange();
  const toast = useToast();
  const confirm = useConfirm();
  const cases = store.data.cases;
  const [pickedCaseId, setPickedCaseId] = useState('');
  const selectedId = cases.some((c) => c.id === pickedCaseId) ? pickedCaseId : (cases[0]?.id ?? '');

  const handleDownloadBackup = () => {
    downloadText(`palantir-workspace-${today()}.json`, store.exportWorkspace());
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
        'Restoring replaces every case, the audit trail and ALL user accounts, including their password hashes, ' +
        'with the contents of this backup. Export your current data first if you need it. Continue?',
      confirmLabel: 'Replace workspace',
      tone: 'danger',
    });
    if (!ok) return;
    const result = store.importWorkspace(text);
    toast.show(result.msg, result.success ? 'success' : 'error');
  };

  const handleExportCase = () => {
    const json = store.exportCase(selectedId);
    if (!json) {
      toast.show('Select a case to export.', 'error');
      return;
    }
    const name = store.getCase(selectedId)?.name ?? 'case';
    downloadText(`case-${fileSafe(name)}-${today()}.json`, json);
    toast.show(`Exported case "${name}".`, 'success');
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

  return (
    <section className="premium-panel settings-section" aria-labelledby="settings-backup-title">
      <h2 id="settings-backup-title" className="premium-panel-title">
        <Download size={14} aria-hidden="true" /> Backup and restore
      </h2>

      <div className="settings-row">
        <button type="button" className="premium-button" onClick={handleDownloadBackup}>
          <Download size={14} aria-hidden="true" /> Download workspace backup
        </button>
      </div>
      <p className="settings-muted">
        A workspace backup holds every case, the audit trail and all user accounts with their password hashes. Keep it private.
        AI API keys are never included.
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
        <p className="settings-muted">Restoring replaces the whole workspace, including users and password hashes.</p>
      </div>

      <div className="settings-field">
        <label htmlFor="settings-case-select">Export a single case</label>
        <div className="settings-row">
          <select
            id="settings-case-select"
            className="premium-input"
            value={selectedId}
            disabled={cases.length === 0}
            onChange={(e) => setPickedCaseId(e.target.value)}
          >
            {cases.length === 0 && <option value="">No cases yet</option>}
            {cases.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button type="button" className="premium-button" onClick={handleExportCase} disabled={cases.length === 0}>
            <Download size={14} aria-hidden="true" /> Export case
          </button>
        </div>
        <p className="settings-muted">An export only includes items your clearance allows you to see.</p>
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

const AccountSection: React.FC = () => {
  useRefreshOnChange();
  const toast = useToast();
  const signedIn = store.data.current_user !== null;
  const [oldPass, setOldPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (newPass !== confirmPass) {
      setError('The new passwords do not match.');
      return;
    }
    const result = store.changePassword(oldPass, newPass);
    if (!result.success) {
      setError(result.msg);
      toast.show(result.msg, 'error');
      return;
    }
    setError(null);
    setOldPass('');
    setNewPass('');
    setConfirmPass('');
    toast.show('Password changed.', 'success');
  };

  return (
    <section className="premium-panel settings-section" aria-labelledby="settings-account-title">
      <h2 id="settings-account-title" className="premium-panel-title">
        <KeyRound size={14} aria-hidden="true" /> Account
      </h2>
      {!signedIn ? (
        <p className="settings-muted">Sign in to change your password.</p>
      ) : (
        <form className="settings-form" onSubmit={handleSubmit} aria-label="Change password">
          <div className="settings-field">
            <label htmlFor="settings-old-password">Current password</label>
            <input
              id="settings-old-password"
              type="password"
              className="premium-input"
              autoComplete="current-password"
              required
              value={oldPass}
              onChange={(e) => setOldPass(e.target.value)}
            />
          </div>
          <div className="settings-field">
            <label htmlFor="settings-new-password">New password</label>
            <input
              id="settings-new-password"
              type="password"
              className="premium-input"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              aria-describedby="settings-new-password-hint"
              aria-invalid={error ? true : undefined}
              value={newPass}
              onChange={(e) => setNewPass(e.target.value)}
            />
            <span id="settings-new-password-hint" className="settings-muted">
              At least {MIN_PASSWORD_LENGTH} characters.
            </span>
          </div>
          <div className="settings-field">
            <label htmlFor="settings-confirm-password">Confirm new password</label>
            <input
              id="settings-confirm-password"
              type="password"
              className="premium-input"
              autoComplete="new-password"
              required
              value={confirmPass}
              onChange={(e) => setConfirmPass(e.target.value)}
            />
          </div>
          <div className="settings-row">
            <button type="submit" className="premium-button primary">
              Change password
            </button>
          </div>
          {error && (
            <p role="alert" className="settings-error">
              {error}
            </p>
          )}
        </form>
      )}
    </section>
  );
};

const UsersSection: React.FC = () => {
  useRefreshOnChange();
  const toast = useToast();
  const confirm = useConfirm();
  const me = store.data.current_user;
  const isTopSecret = store.getCurrentUserClearance() === 'TOP_SECRET';
  const users = store.listUsers();

  const handleClearance = (username: string, level: ClearanceLevel) => {
    const result = store.setUserClearance(username, level);
    toast.show(result.success ? `${username} is now ${level}.` : result.msg, result.success ? 'success' : 'error');
  };

  const handleDelete = async (username: string) => {
    const ok = await confirm({
      title: 'Delete account?',
      message: `Delete the account "${username}"? They will no longer be able to sign in. Their cases and audit entries are kept.`,
      confirmLabel: 'Delete account',
      tone: 'danger',
    });
    if (!ok) return;
    const result = store.deleteUser(username);
    toast.show(result.success ? `Deleted ${username}.` : result.msg, result.success ? 'success' : 'error');
  };

  return (
    <section className="premium-panel settings-section" aria-labelledby="settings-users-title">
      <h2 id="settings-users-title" className="premium-panel-title">
        <Users size={14} aria-hidden="true" /> Users
      </h2>
      {!isTopSecret ? (
        <p className="settings-muted">Only TOP_SECRET users can manage accounts and clearance levels.</p>
      ) : (
        <div className="settings-table-wrap">
          <table className="premium-table" aria-label="User accounts">
            <thead>
              <tr>
                <th scope="col">User</th>
                <th scope="col">Clearance</th>
                <th scope="col">Created</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.username}>
                  <td style={{ fontWeight: 600 }}>
                    {u.username}
                    {u.username === me && <span className="settings-muted"> (you)</span>}
                  </td>
                  <td>
                    <select
                      className="premium-input"
                      aria-label={`Clearance for ${u.username}`}
                      value={u.clearance}
                      onChange={(e) => handleClearance(u.username, e.target.value as ClearanceLevel)}
                    >
                      {CLEARANCES.map((level) => (
                        <option key={level} value={level}>
                          {level}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>{new Date(u.created_at).toLocaleDateString()}</td>
                  <td>
                    <button
                      type="button"
                      className="premium-button"
                      aria-label={`Delete user ${u.username}`}
                      disabled={u.username === me}
                      onClick={() => void handleDelete(u.username)}
                    >
                      <Trash2 size={14} aria-hidden="true" /> Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
        Erase all local data deletes every case, user account, audit entry and setting stored in this browser, then
        reloads the app and signs you out. This cannot be undone. Export a workspace backup first.
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
        The workspace: cases, entities, incidents, signals, the audit trail, user accounts with password hashes, the
        theme, and each AI provider's enabled flag and model name. Cookies are sent with every request to this site,
        so the workspace is compressed and capped at about 16 KB.
      </dd>
      <dt>sessionStorage (this tab only, cleared when it closes)</dt>
      <dd>AI provider API keys, and a copy of workspace data that could not be read.</dd>
    </dl>
    <p className="settings-muted">
      Password hashing in this app is demo-grade and is not real authentication. Keep backup files private.
    </p>
  </section>
);

export const SettingsTab: React.FC = () => (
  <div id="SettingsPanel" className="settings-tab">
    <DefaultPasswordBanner />
    <StorageSection />
    <BackupSection />
    <AccountSection />
    <UsersSection />
    <DangerSection />
    <PrivacySection />
  </div>
);
