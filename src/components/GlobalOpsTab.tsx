import { useId, useState, type FormEvent } from 'react';
import { ExternalLink, Globe, ShieldAlert, Settings } from 'lucide-react';

/** sessionStorage key holding the user-configured Osiris UI URL. Session-only: cleared when the tab closes. */
const STORAGE_KEY = 'aegis_osiris_ui';
/** Third-party content: scripts run, but the frame is isolated from this app's origin and storage. */
const SANDBOX = 'allow-scripts allow-same-origin allow-popups';

type UrlCheck = { ok: true; url: string } | { ok: false; error: string };

function checkOsirisUrl(raw: string): UrlCheck {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'Enter the https:// address of the Osiris UI.' };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: 'That is not a valid URL.' };
  }
  if (parsed.protocol !== 'https:') return { ok: false, error: 'Only https:// addresses are accepted.' };
  if (parsed.username || parsed.password) return { ok: false, error: 'Remove the username and password from the URL.' };
  return { ok: true, url: parsed.href };
}

function readConfigured(): string | null {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (!stored) return null;
    const check = checkOsirisUrl(stored);
    return check.ok ? check.url : null;
  } catch {
    // Storage blocked: behave as unconfigured.
    return null;
  }
}

function writeConfigured(url: string | null): boolean {
  try {
    if (url) sessionStorage.setItem(STORAGE_KEY, url);
    else sessionStorage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function GlobalOpsTab() {
  const inputId = useId();
  const [configured, setConfigured] = useState<string | null>(readConfigured);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [showSettings, setShowSettings] = useState(false);

  const handleSave = (e: FormEvent) => {
    e.preventDefault();
    const check = checkOsirisUrl(draft);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    if (!writeConfigured(check.url)) {
      setError('This browser blocked session storage, so the address could not be saved.');
      return;
    }
    setConfigured(check.url);
    setDraft('');
    setError('');
    setShowSettings(false);
  };

  const handleClear = () => {
    writeConfigured(null);
    setConfigured(null);
    setError('');
    setShowSettings(false);
  };

  const settingsForm = (
    <form onSubmit={handleSave} className="premium-panel" style={{ padding: 16, display: 'grid', gap: 8, maxWidth: 640 }}>
      <label htmlFor={inputId} className="form-label">Osiris UI address (https only)</label>
      <input
        id={inputId}
        type="url"
        className="premium-input"
        placeholder="https://osiris.example.com"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <small className="text-muted">
        Stored only for this browser session. Feeds and API keys stay on the Osiris server, never in this app.
      </small>
      {error && <p role="alert" style={{ color: 'var(--danger, #f87171)', fontSize: 13, margin: 0 }}>{error}</p>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button type="submit" className="btn btn-primary btn-sm" disabled={!draft.trim()}>Save address</button>
        {configured && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setShowSettings(false); setError(''); }}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );

  if (!configured) {
    return (
      <div style={{ display: 'grid', gap: 16 }}>
        <div className="empty-state">
          <Globe size={48} className="empty-icon" aria-hidden="true" />
          <h3>Global Ops is not configured</h3>
          <p>
            This tab shows the Osiris UI, a separate third-party site, inside this app. To set it up, run or obtain the
            address of your Osiris UI deployment, then enter it below. It must start with https://.
          </p>
          <p className="text-muted">
            Some sites block being shown inside another page using their own security headers. If the frame stays blank
            after you save, use the "Open in new tab" link instead.
          </p>
        </div>
        {settingsForm}
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 12, height: '100%' }}>
      <div role="note" className="demo-notice" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <ShieldAlert size={16} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
        <span>
          The page below is a third-party site, not part of Aegis Nexus. It runs in a sandboxed frame, and this app
          cannot read its content. Do not enter credentials you would not give that site.
        </span>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <a
          href={configured}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-ghost btn-sm"
        >
          <ExternalLink size={14} aria-hidden="true" /> Open in new tab
        </a>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowSettings(s => !s)}>
          <Settings size={14} aria-hidden="true" /> {showSettings ? 'Hide settings' : 'Change address'}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={handleClear}>Remove</button>
      </div>

      {showSettings && settingsForm}

      <iframe
        title="Osiris UI (third-party, sandboxed)"
        src={configured}
        sandbox={SANDBOX}
        referrerPolicy="strict-origin-when-cross-origin"
        loading="lazy"
        style={{ width: '100%', flex: 1, minHeight: '70vh', border: '1px solid var(--border, #333)', borderRadius: 8, background: '#fff' }}
      />
    </div>
  );
}
