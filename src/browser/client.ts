/**
 * Browser tab client helpers: response types, the proxy fetch, and address-bar resolution.
 * Everything here is a pure function or a single fetch call. No DOM rendering.
 */

/** Successful text/html response from /browse. The html is sanitised server-side and rebuilt client-side. */
export interface PageResult {
  kind: 'page';
  finalUrl: string;
  title: string;
  html: string;
  status: number;
}

/** Non-HTML response: metadata only. Images are shown through the asset mode. */
export interface MetaResult {
  kind: 'meta';
  type: string;
  size: number | null;
  url: string;
  status: number;
}

export type BrowseResult = PageResult | MetaResult;

export class BrowseError extends Error {}

export const SEARCH_ENDPOINT = 'https://duckduckgo.com/html/?q=';
const MAX_QUERY_LENGTH = 500;
const CLIENT_TIMEOUT_MS = 20_000;

/** Proxy URL for a page or any other target. The target travels in the query string by design. */
export function browseUrl(target: string): string {
  return `/browse?url=${encodeURIComponent(target)}`;
}

/** Proxy URL for an image. Used as an <img src>, so the browser fetches it without page context. */
export function assetUrl(target: string): string {
  return `/browse?asset=1&url=${encodeURIComponent(target)}`;
}

/** True for http(s) URLs only. Used on every URL before it is shown as a link or opened. */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Fetches a page through the proxy. Sends no cookies (credentials: omit) and no referrer.
 * Throws BrowseError with a user-facing message on any failure.
 */
export async function fetchBrowse(target: string, signal: AbortSignal): Promise<BrowseResult> {
  const timeout = AbortSignal.timeout(CLIENT_TIMEOUT_MS);
  const combined = AbortSignal.any([signal, timeout]);
  let response: Response;
  try {
    response = await fetch(browseUrl(target), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: combined,
    });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new BrowseError(timeout.aborted ? 'The request timed out.' : 'The browser proxy could not be reached.');
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new BrowseError(`The browser proxy returned an unexpected response (HTTP ${response.status}).`);
  }

  if (!response.ok) {
    const message = isRecord(body) && typeof body.message === 'string' ? body.message : 'The page could not be loaded.';
    throw new BrowseError(message);
  }
  return parseBrowseBody(body);
}

/** Checks the response shape strictly. Anything unexpected is an error, not a best guess. */
export function parseBrowseBody(body: unknown): BrowseResult {
  if (!isRecord(body)) throw new BrowseError('The browser proxy returned an unexpected response.');
  if (typeof body.html === 'string' && typeof body.finalUrl === 'string') {
    if (!isHttpUrl(body.finalUrl)) throw new BrowseError('The page reported an invalid address.');
    return {
      kind: 'page',
      finalUrl: body.finalUrl,
      title: typeof body.title === 'string' ? body.title : '',
      html: body.html,
      status: typeof body.status === 'number' ? body.status : 200,
    };
  }
  if (typeof body.type === 'string' && typeof body.url === 'string') {
    if (!isHttpUrl(body.url)) throw new BrowseError('The page reported an invalid address.');
    return {
      kind: 'meta',
      type: body.type,
      size: typeof body.size === 'number' ? body.size : null,
      url: body.url,
      status: typeof body.status === 'number' ? body.status : 200,
    };
  }
  throw new BrowseError('The browser proxy returned an unexpected response.');
}

/**
 * Turns address-bar text into a URL. Full http(s) URLs are used as typed. Host-like input gets
 * https://. Everything else becomes a search. The server re-validates whatever this returns.
 */
export function resolveAddress(raw: string): { url: string; isSearch: boolean } | { error: string } {
  const text = raw.trim();
  if (!text) return { error: 'Type an address or a search.' };

  if (/^https?:\/\//i.test(text)) {
    return isHttpUrl(text) ? { url: text, isSearch: false } : { error: 'That address is not valid.' };
  }
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?([/?#]\S*)?$/i.test(text)) {
    const candidate = `https://${text}`;
    if (isHttpUrl(candidate)) return { url: candidate, isSearch: false };
  }
  if (text.length > MAX_QUERY_LENGTH) return { error: 'The search is too long.' };
  return { url: `${SEARCH_ENDPOINT}${encodeURIComponent(text)}`, isSearch: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
