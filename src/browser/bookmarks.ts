/**
 * Bookmarks for the Browser tab. Per-viewer convenience only, kept in localStorage.
 * Small on purpose: capped in count and field length, and every stored entry is re-validated on load.
 */
import { isHttpUrl } from './client';

export interface Bookmark {
  url: string;
  title: string;
}

export const MAX_BOOKMARKS = 20;
const STORAGE_KEY = 'aegis_browser_bookmarks';
const TITLE_MAX = 100;
const URL_MAX = 2048;

/** Reads bookmarks. Storage blocked or corrupt data yields an empty list. */
export function loadBookmarks(): Bookmark[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: Bookmark[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      const { url, title } = item as Record<string, unknown>;
      if (typeof url !== 'string' || url.length > URL_MAX || !isHttpUrl(url)) continue;
      out.push({ url, title: typeof title === 'string' ? title.slice(0, TITLE_MAX) : url });
      if (out.length >= MAX_BOOKMARKS) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Writes bookmarks. Returns false if the browser refused the write. */
export function saveBookmarks(list: Bookmark[]): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_BOOKMARKS)));
    return true;
  } catch {
    return false;
  }
}

export function makeBookmark(url: string, title: string): Bookmark {
  return { url: url.slice(0, URL_MAX), title: (title || url).slice(0, TITLE_MAX) };
}
