/**
 * Bookmarks for the Browser tab. Per-viewer convenience only, stored in the cookie store under 'aegis_bm'.
 * Small on purpose: capped in count and field length, and every stored entry is re-validated on load.
 *
 * Call initBookmarks() once before relying on the data. Until it resolves, loadBookmarks() returns []
 * and saveBookmarks() refuses, so a write can never overwrite bookmarks that have not been read yet.
 */
import { isHttpUrl } from './client';
import { getItemSync, initCookieStorage, removeItemSync, setItem, setItemSync, usage } from '../utils/cookieStorage';

export interface Bookmark {
  url: string;
  title: string;
}

export const MAX_BOOKMARKS = 20;
const STORAGE_KEY = 'aegis_bm';
/** localStorage key used before bookmarks moved to cookies. Removed once migrated. */
const LEGACY_KEY = 'aegis_browser_bookmarks';
const TITLE_MAX = 60;
const URL_MAX = 200;

let ready = false;
let initPromise: Promise<void> | null = null;

/** Field-length caps applied on every path in and out of storage. */
export function makeBookmark(url: string, title: string): Bookmark {
  const cleanUrl = url.slice(0, URL_MAX);
  return { url: cleanUrl, title: (title || cleanUrl).slice(0, TITLE_MAX) };
}

/** Keeps only valid http(s) entries, drops duplicates, truncates fields and caps the count. */
function sanitize(items: unknown): Bookmark[] {
  if (!Array.isArray(items)) return [];
  const out: Bookmark[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) continue;
    const { url, title } = item as Record<string, unknown>;
    if (typeof url !== 'string' || !isHttpUrl(url)) continue;
    const bookmark = makeBookmark(url, typeof title === 'string' ? title : '');
    if (out.some((b) => b.url === bookmark.url)) continue;
    out.push(bookmark);
    if (out.length >= MAX_BOOKMARKS) break;
  }
  return out;
}

function parseStored(raw: string | null): Bookmark[] {
  if (!raw) return [];
  try {
    return sanitize(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** Rough upper bound of the Cookie header bytes a stored value needs (base64 expansion plus cookie overhead). */
function costOf(value: string): number {
  return Math.ceil((new TextEncoder().encode(value).length * 4) / 3) + 64;
}

/** Reads bookmarks from the cookie cache. Returns [] before initBookmarks has resolved. */
export function loadBookmarks(): Bookmark[] {
  if (!ready) return [];
  return parseStored(getItemSync(STORAGE_KEY));
}

/**
 * Writes bookmarks. Returns false if the store is not initialised or the list will not fit the cookie
 * budget; nothing is written in that case. The write itself is debounced by the cookie store.
 */
export function saveBookmarks(list: Bookmark[]): boolean {
  if (!ready) return false;
  const clean = sanitize(list);
  if (clean.length === 0) {
    removeItemSync(STORAGE_KEY);
    return true;
  }
  const json = JSON.stringify(clean);
  const { bytesUsed, budgetBytes } = usage();
  const current = getItemSync(STORAGE_KEY);
  const freed = current ? costOf(current) : 0;
  if (costOf(json) > budgetBytes - bytesUsed + freed) return false;
  setItemSync(STORAGE_KEY, json);
  return true;
}

/**
 * Moves bookmarks from the legacy localStorage key into the cookie store, merging with any already
 * there. The legacy key is removed only after the cookie write succeeds; otherwise it is kept for a retry.
 */
async function migrateLegacy(): Promise<void> {
  let legacyRaw: string | null;
  try {
    legacyRaw = localStorage.getItem(LEGACY_KEY);
  } catch {
    return;
  }
  if (legacyRaw === null) return;

  const removeLegacy = (): void => {
    try {
      localStorage.removeItem(LEGACY_KEY);
    } catch {
      // Storage became unavailable; nothing more to do.
    }
  };

  const legacy = parseStored(legacyRaw);
  if (legacy.length === 0) {
    removeLegacy();
    return;
  }
  const merged = sanitize([...parseStored(getItemSync(STORAGE_KEY)), ...legacy]);
  const result = await setItem(STORAGE_KEY, JSON.stringify(merged));
  if (result.ok) {
    removeLegacy();
  } else {
    console.warn('[bookmarks] could not move bookmarks to cookies; the old copy was kept', result);
  }
}

/**
 * Loads the cookie store and migrates legacy bookmarks once. Idempotent. Resolves even if the
 * migration fails; resolves without enabling reads and writes only if the cookie store itself fails.
 */
export function initBookmarks(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        await initCookieStorage();
      } catch (err) {
        console.warn('[bookmarks] cookie store unavailable', err);
        return;
      }
      try {
        await migrateLegacy();
      } catch (err) {
        console.warn('[bookmarks] migration from localStorage failed', err);
      }
      ready = true;
    })();
  }
  return initPromise;
}
