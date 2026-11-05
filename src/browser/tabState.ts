/**
 * Pure state for the Browser tab: tabs, per-tab history and load status.
 * No React, no I/O, so the rules here can be reasoned about and tested on their own.
 */
import type { BrowseResult } from './client';

/** Per-tab history cap. Oldest entries are dropped first. */
export const MAX_HISTORY = 50;
/** Open tabs cap. */
export const MAX_TABS = 8;

/** An empty URL is the built-in start page. It is never fetched. */
export const START_URL = '';

export type LoadStatus = 'ready' | 'loading' | 'error';

export interface BrowserTab {
  id: string;
  /** Visited URLs, oldest first. START_URL marks the start page. */
  history: string[];
  index: number;
  /** Address bar text. Follows the current URL unless the user is typing. */
  draft: string;
  status: LoadStatus;
  result: BrowseResult | null;
  error: string | null;
  /** Identifies the latest navigation. Responses for older navigations are ignored. */
  loadId: number;
}

export type NavHow = { kind: 'push' } | { kind: 'reload' } | { kind: 'move'; delta: number };

export interface BrowserState {
  tabs: BrowserTab[];
  activeId: string;
}

export type BrowserAction =
  | { type: 'add'; tab: BrowserTab }
  | { type: 'close'; id: string; replacement: BrowserTab }
  | { type: 'select'; id: string }
  | { type: 'draft'; id: string; value: string }
  | { type: 'nav'; id: string; loadId: number; url: string; how: NavHow }
  | { type: 'loaded'; id: string; loadId: number; result: BrowseResult }
  | { type: 'failed'; id: string; loadId: number; error: string };

/** A new tab starts on the start page. Navigation to a URL is a separate step. */
export function newTab(id: string): BrowserTab {
  return {
    id,
    history: [START_URL],
    index: 0,
    draft: START_URL,
    status: 'ready',
    result: null,
    error: null,
    loadId: 0,
  };
}

export function currentUrl(tab: BrowserTab): string {
  return tab.history[tab.index] ?? START_URL;
}

export function canGoBack(tab: BrowserTab): boolean {
  return tab.index > 0;
}

export function canGoForward(tab: BrowserTab): boolean {
  return tab.index < tab.history.length - 1;
}

/** Applies a navigation to one tab's history. A push drops any forward entries. */
export function applyNav(tab: BrowserTab, url: string, how: NavHow, loadId: number): BrowserTab {
  let history = tab.history;
  let index = tab.index;
  if (how.kind === 'push') {
    history = [...history.slice(0, index + 1), url].slice(-MAX_HISTORY);
    index = history.length - 1;
  } else if (how.kind === 'move') {
    index = Math.min(Math.max(index + how.delta, 0), history.length - 1);
  }
  const isStart = url === START_URL;
  return {
    ...tab,
    history,
    index,
    draft: url,
    status: isStart ? 'ready' : 'loading',
    result: null,
    error: null,
    loadId,
  };
}

function updateTab(state: BrowserState, id: string, change: (tab: BrowserTab) => BrowserTab): BrowserState {
  let found = false;
  const tabs = state.tabs.map((tab) => {
    if (tab.id !== id) return tab;
    found = true;
    return change(tab);
  });
  return found ? { ...state, tabs } : state;
}

export function browserReducer(state: BrowserState, action: BrowserAction): BrowserState {
  switch (action.type) {
    case 'add':
      if (state.tabs.length >= MAX_TABS) return state;
      return { tabs: [...state.tabs, action.tab], activeId: action.tab.id };

    case 'close': {
      const remaining = state.tabs.filter((t) => t.id !== action.id);
      if (remaining.length === 0) return { tabs: [action.replacement], activeId: action.replacement.id };
      if (state.activeId !== action.id) return { ...state, tabs: remaining };
      const closedAt = state.tabs.findIndex((t) => t.id === action.id);
      const next = remaining[Math.min(closedAt, remaining.length - 1)] ?? remaining[0]!;
      return { tabs: remaining, activeId: next.id };
    }

    case 'select':
      return state.tabs.some((t) => t.id === action.id) ? { ...state, activeId: action.id } : state;

    case 'draft':
      return updateTab(state, action.id, (tab) => ({ ...tab, draft: action.value }));

    case 'nav':
      return updateTab(state, action.id, (tab) => applyNav(tab, action.url, action.how, action.loadId));

    case 'loaded':
      return updateTab(state, action.id, (tab) =>
        tab.loadId === action.loadId ? { ...tab, status: 'ready', result: action.result, error: null } : tab,
      );

    case 'failed':
      return updateTab(state, action.id, (tab) =>
        tab.loadId === action.loadId ? { ...tab, status: 'error', result: null, error: action.error } : tab,
      );
  }
}

/** Short label for a tab strip entry. */
export function tabLabel(tab: BrowserTab): string {
  if (tab.result?.kind === 'page' && tab.result.title) return tab.result.title;
  const url = currentUrl(tab);
  if (url === START_URL) return 'Start page';
  try {
    return new URL(url).hostname;
  } catch {
    return 'Page';
  }
}
