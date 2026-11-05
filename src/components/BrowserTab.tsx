import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, ExternalLink, House, Plus, RotateCw, Save, ShieldAlert, Star, X } from 'lucide-react';
import { store } from '../store';
import { useConfirm } from '../ui/confirmContext';
import { useToast } from '../ui/toastContext';
import {
  assetUrl, BrowseError, fetchBrowse, isHttpUrl, resolveAddress, type BrowseResult, type PageResult,
} from '../browser/client';
import { buildReaderTree, treeText, type ReaderNode } from '../browser/readerTree';
import { ReaderView } from '../browser/ReaderView';
import {
  browserReducer, canGoBack, canGoForward, currentUrl, MAX_TABS, newTab, START_URL, tabLabel,
  type BrowserState, type NavHow,
} from '../browser/tabState';
import { initBookmarks, loadBookmarks, makeBookmark, MAX_BOOKMARKS, saveBookmarks, type Bookmark } from '../browser/bookmarks';
import '../browser/browser.css';

/** Repeated navigations to the same tab within this window are ignored (client-side debounce). */
const NAV_DEBOUNCE_MS = 500;
const CONSENT_KEY = 'aegis_browser_consent';
const EXCERPT_CHARS = 300;

let tabSeq = 0;
const nextTabId = () => `browser-tab-${++tabSeq}`;

function initialState(): BrowserState {
  const tab = newTab(nextTabId());
  return { tabs: [tab], activeId: tab.id };
}

function readConsent(): boolean {
  try {
    return sessionStorage.getItem(CONSENT_KEY) === '1';
  } catch {
    return false;
  }
}

function writeConsent(): void {
  try {
    sessionStorage.setItem(CONSENT_KEY, '1');
  } catch {
    // Storage blocked: consent is kept for this mount only, and the user is asked again later.
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

export function BrowserTab() {
  const confirm = useConfirm();
  const toast = useToast();
  const [state, dispatch] = useReducer(browserReducer, undefined, initialState);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(loadBookmarks);
  const [addressError, setAddressError] = useState('');
  const [bookmarkNote, setBookmarkNote] = useState('');

  // Bookmarks read as [] until the cookie store is initialised; reload once it is.
  useEffect(() => {
    let alive = true;
    void initBookmarks().then(() => {
      if (alive) setBookmarks(loadBookmarks());
    });
    return () => {
      alive = false;
    };
  }, []);

  const controllers = useRef(new Map<string, AbortController>());
  const loadSeq = useRef(0);
  const lastNavAt = useRef(new Map<string, number>());
  const consentRef = useRef<boolean | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const active = state.tabs.find((t) => t.id === state.activeId) ?? state.tabs[0]!;
  const activeUrl = currentUrl(active);
  const activeCase = store.getActiveCase();

  // Abort any in-flight proxy request when the tab unmounts.
  useEffect(() => {
    const map = controllers.current;
    return () => {
      map.forEach((c) => c.abort());
      map.clear();
    };
  }, []);

  /** First external request per session needs the user's explicit OK. */
  const ensureConsent = useCallback(async (): Promise<boolean> => {
    if (consentRef.current === null) consentRef.current = readConsent();
    if (consentRef.current) return true;
    const ok = await confirm({
      title: 'Open a third-party page?',
      message:
        'Pages come from third-party websites, fetched through this app\'s Cloudflare proxy. Scripts, forms and '
        + 'video are removed, so logins and interactive features will not work. The sites see the proxy\'s address, '
        + 'not yours, and the proxy host can see the addresses you open. Your app cookies are never sent to these sites.',
      confirmLabel: 'Allow for this session',
      cancelLabel: 'Not now',
    });
    if (ok) {
      consentRef.current = true;
      writeConsent();
    }
    return ok;
  }, [confirm]);

  /** Single entry point for every navigation: debounce, consent, history update, then the fetch. */
  const go = useCallback(
    async (tabId: string, url: string, how: NavHow) => {
      const now = Date.now();
      const last = lastNavAt.current.get(tabId) ?? 0;
      if (now - last < NAV_DEBOUNCE_MS) return;
      lastNavAt.current.set(tabId, now);

      if (url !== START_URL && !(await ensureConsent())) return;

      const loadId = ++loadSeq.current;
      controllers.current.get(tabId)?.abort();
      controllers.current.delete(tabId);
      dispatch({ type: 'nav', id: tabId, loadId, url, how });
      if (url === START_URL) return;

      const controller = new AbortController();
      controllers.current.set(tabId, controller);
      try {
        const result: BrowseResult = await fetchBrowse(url, controller.signal);
        if (!controller.signal.aborted) dispatch({ type: 'loaded', id: tabId, loadId, result });
      } catch (err) {
        if (controller.signal.aborted) return;
        const message = err instanceof BrowseError ? err.message : 'The page could not be loaded.';
        dispatch({ type: 'failed', id: tabId, loadId, error: message });
      } finally {
        if (controllers.current.get(tabId) === controller) controllers.current.delete(tabId);
      }
    },
    [ensureConsent],
  );

  const activeTabId = active.id;
  const onAddressSubmit = (e: FormEvent) => {
    e.preventDefault();
    const resolved = resolveAddress(active.draft);
    if ('error' in resolved) {
      setAddressError(resolved.error);
      return;
    }
    setAddressError('');
    void go(activeTabId, resolved.url, { kind: 'push' });
  };

  const goBack = () => {
    const tab = stateRef.current.tabs.find((t) => t.id === activeTabId);
    if (!tab || !canGoBack(tab)) return;
    const target = tab.history[tab.index - 1] ?? START_URL;
    void go(activeTabId, target, { kind: 'move', delta: -1 });
  };

  const goForward = () => {
    const tab = stateRef.current.tabs.find((t) => t.id === activeTabId);
    if (!tab || !canGoForward(tab)) return;
    const target = tab.history[tab.index + 1] ?? START_URL;
    void go(activeTabId, target, { kind: 'move', delta: 1 });
  };

  const reload = () => {
    if (activeUrl === START_URL) return;
    void go(activeTabId, activeUrl, { kind: 'reload' });
  };

  const goHome = () => {
    void go(activeTabId, START_URL, { kind: 'push' });
  };

  const addTab = () => {
    if (state.tabs.length >= MAX_TABS) {
      toast.show(`You can open up to ${MAX_TABS} tabs.`, 'info');
      return;
    }
    dispatch({ type: 'add', tab: newTab(nextTabId()) });
  };

  const closeTab = (id: string) => {
    controllers.current.get(id)?.abort();
    controllers.current.delete(id);
    lastNavAt.current.delete(id);
    dispatch({ type: 'close', id, replacement: newTab(nextTabId()) });
  };

  /** Opens a link from the page. Ctrl/Cmd-click or middle-click opens it in a new tab. */
  const openFromPage = (url: string, inNewTab: boolean) => {
    if (inNewTab) {
      if (state.tabs.length >= MAX_TABS) {
        toast.show(`You can open up to ${MAX_TABS} tabs.`, 'info');
        return;
      }
      const tab = newTab(nextTabId());
      dispatch({ type: 'add', tab });
      void go(tab.id, url, { kind: 'push' });
      return;
    }
    void go(activeTabId, url, { kind: 'push' });
  };

  const isBookmarked = bookmarks.some((b) => b.url === activeUrl);
  const toggleBookmark = () => {
    if (activeUrl === START_URL) return;
    if (isBookmarked) {
      const next = bookmarks.filter((b) => b.url !== activeUrl);
      setBookmarks(next);
      saveBookmarks(next);
      setBookmarkNote('');
      return;
    }
    if (bookmarks.length >= MAX_BOOKMARKS) {
      setBookmarkNote(`Bookmarks are limited to ${MAX_BOOKMARKS}. Remove one first.`);
      return;
    }
    const title = active.result?.kind === 'page' ? active.result.title : '';
    const next = [...bookmarks, makeBookmark(activeUrl, title)];
    setBookmarks(next);
    const saved = saveBookmarks(next);
    setBookmarkNote(saved ? '' : 'This browser blocked saving bookmarks.');
  };

  const removeBookmark = (url: string) => {
    const next = bookmarks.filter((b) => b.url !== url);
    setBookmarks(next);
    saveBookmarks(next);
  };

  const saveToCase = (page: PageResult, excerpt: string) => {
    const c = store.getActiveCase();
    if (!c) {
      toast.show('Select a case first. Choose one on the Command Center.', 'info');
      return;
    }
    const title = (page.title || hostOf(page.finalUrl)).slice(0, 200);
    store.addEntity(c.id, title, 'Source', 'UNCLASSIFIED', {
      url: page.finalUrl,
      title: page.title,
      retrieved: new Date().toISOString(),
      excerpt,
      classification: 'UNCLASSIFIED',
    });
    toast.show(`Saved "${title}" to ${c.name} as a Source.`, 'success');
  };

  const renderBody = () => {
    if (activeUrl === START_URL) {
      return <StartPage bookmarks={bookmarks} onOpen={(url) => void go(activeTabId, url, { kind: 'push' })} onRemove={removeBookmark} />;
    }
    if (active.status === 'loading') {
      return (
        <div className="browser-state" role="status">
          <h3>Loading</h3>
          <p>{hostOf(activeUrl)}</p>
        </div>
      );
    }
    if (active.status === 'error') {
      return (
        <div className="browser-state" role="alert">
          <h3>This page did not load</h3>
          <p>{active.error}</p>
          <button type="button" className="btn btn-ghost btn-sm" onClick={reload}>
            <RotateCw size={14} aria-hidden="true" /> Try again
          </button>
        </div>
      );
    }
    const result = active.result;
    if (!result) return null;
    if (result.kind === 'meta') {
      const isImage = result.type.startsWith('image/');
      return (
        <div className="browser-paper" style={{ display: 'grid', gap: 12, justifyItems: 'center' }}>
          {isImage && isHttpUrl(result.url) ? (
            <img src={assetUrl(result.url)} alt="" style={{ maxWidth: '100%' }} referrerPolicy="no-referrer" />
          ) : (
            <p>This address is not an HTML page, so it was not rendered.</p>
          )}
          <p style={{ fontSize: 13, color: '#4b5563' }}>
            Type: {result.type || 'unknown'}
            {result.size !== null ? `, ${result.size.toLocaleString()} bytes` : ''}
          </p>
          <a href={result.url} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-sm">
            <ExternalLink size={14} aria-hidden="true" /> Open original in a new tab
          </a>
        </div>
      );
    }
    return (
      <PageView
        page={result}
        caseName={activeCase?.name ?? null}
        onOpen={openFromPage}
        onSave={saveToCase}
      />
    );
  };

  return (
    <div className="browser-tab">
      <div role="note" className="demo-notice" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <ShieldAlert size={16} aria-hidden="true" style={{ flexShrink: 0, marginTop: 2 }} />
        <span>
          Reader view. Pages come from third-party websites through this app's proxy. Scripts are removed, so logins,
          forms and video will not work. Sites cannot read this app's cookies or data.
        </span>
      </div>

      <div role="tablist" aria-label="Browser tabs" className="browser-tab-strip">
        {state.tabs.map((tab) => {
          const selected = tab.id === active.id;
          const label = tabLabel(tab);
          return (
            <div key={tab.id} className="browser-tab-item">
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                className="browser-tab-select"
                title={label}
                onClick={() => dispatch({ type: 'select', id: tab.id })}
              >
                {label}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                aria-label={`Close ${label}`}
                onClick={() => closeTab(tab.id)}
              >
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-label="New tab"
          title="New tab"
          onClick={addTab}
          disabled={state.tabs.length >= MAX_TABS}
        >
          <Plus size={14} aria-hidden="true" />
        </button>
      </div>

      <div className="browser-toolbar">
        <button type="button" className="btn btn-ghost btn-sm" aria-label="Back" title="Back" onClick={goBack} disabled={!canGoBack(active)}>
          <ArrowLeft size={14} aria-hidden="true" />
        </button>
        <button type="button" className="btn btn-ghost btn-sm" aria-label="Forward" title="Forward" onClick={goForward} disabled={!canGoForward(active)}>
          <ArrowRight size={14} aria-hidden="true" />
        </button>
        <button type="button" className="btn btn-ghost btn-sm" aria-label="Reload" title="Reload" onClick={reload} disabled={activeUrl === START_URL}>
          <RotateCw size={14} aria-hidden="true" />
        </button>
        <button type="button" className="btn btn-ghost btn-sm" aria-label="Home" title="Start page" onClick={goHome}>
          <House size={14} aria-hidden="true" />
        </button>
        <form className="browser-address" onSubmit={onAddressSubmit} role="search">
          <label htmlFor="browser-address-input" style={visuallyHidden}>
            Address or search
          </label>
          <input
            id="browser-address-input"
            type="text"
            className="premium-input"
            placeholder="Enter an address or search"
            value={active.draft}
            onChange={(e) => {
              setAddressError('');
              dispatch({ type: 'draft', id: active.id, value: e.target.value });
            }}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-invalid={addressError ? true : undefined}
            aria-describedby={addressError ? 'browser-address-error' : undefined}
          />
          <button type="submit" className="btn btn-primary btn-sm">Go</button>
        </form>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-label={isBookmarked ? 'Remove bookmark' : 'Add bookmark'}
          aria-pressed={isBookmarked}
          title={isBookmarked ? 'Remove bookmark' : 'Add bookmark'}
          onClick={toggleBookmark}
          disabled={activeUrl === START_URL}
        >
          <Star size={14} aria-hidden="true" fill={isBookmarked ? 'currentColor' : 'none'} />
        </button>
      </div>
      {addressError && <p id="browser-address-error" role="alert" style={{ color: 'var(--danger, #f87171)', fontSize: 13, margin: 0 }}>{addressError}</p>}
      {bookmarkNote && <p role="status" style={{ fontSize: 13, margin: 0 }}>{bookmarkNote}</p>}

      <div role="tabpanel" aria-label={tabLabel(active)}>
        {renderBody()}
      </div>
    </div>
  );
}

const visuallyHidden = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const;

interface StartPageProps {
  bookmarks: Bookmark[];
  onOpen: (url: string) => void;
  onRemove: (url: string) => void;
}

function StartPage({ bookmarks, onOpen, onRemove }: StartPageProps) {
  return (
    <div className="browser-state" style={{ display: 'grid', gap: 12, justifyItems: 'center' }}>
      <h3>Browser</h3>
      <p>Type an address, or a search, above. Searches use DuckDuckGo through the proxy.</p>
      {bookmarks.length === 0 ? (
        <p className="text-muted">No bookmarks yet. Open a page and press the star to save it here.</p>
      ) : (
        <div className="browser-bookmarks" aria-label="Bookmarks">
          {bookmarks.map((b) => (
            <span key={b.url} className="browser-chip">
              <button type="button" className="browser-chip-open" title={b.url} onClick={() => onOpen(b.url)}>
                {b.title || hostOf(b.url)}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" aria-label={`Remove bookmark ${b.title || b.url}`} onClick={() => onRemove(b.url)}>
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

interface PageViewProps {
  page: PageResult;
  caseName: string | null;
  onOpen: (url: string, newTab: boolean) => void;
  onSave: (page: PageResult, excerpt: string) => void;
}

function PageView({ page, caseName, onOpen, onSave }: PageViewProps) {
  const tree: ReaderNode[] = useMemo(() => buildReaderTree(page.html), [page.html]);
  const excerpt = useMemo(() => treeText(tree, EXCERPT_CHARS), [tree]);
  const status = page.status;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div className="browser-page-meta">
        <strong>{page.title || hostOf(page.finalUrl)}</strong>
        <span className="browser-url">{page.finalUrl}</span>
        {status >= 400 && <span className="badge badge-primary">HTTP {status}</span>}
        <a href={page.finalUrl} target="_blank" rel="noopener noreferrer" className="btn btn-ghost btn-sm">
          <ExternalLink size={14} aria-hidden="true" /> Open original in a new tab
        </a>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => onSave(page, excerpt)}
          disabled={!caseName}
          title={caseName ? `Save to ${caseName}` : 'Select a case first'}
        >
          <Save size={14} aria-hidden="true" /> Save to case
        </button>
      </div>
      <div className="browser-paper">
        <ReaderView nodes={tree} onOpen={onOpen} />
      </div>
    </div>
  );
}
