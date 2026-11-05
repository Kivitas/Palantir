import { vi } from 'vitest';

/**
 * A minimal stand-in for the browser pieces the app touches: `document.cookie` (a name -> value
 * jar that honours max-age=0 deletions) and `sessionStorage`. Installed as globals so the real
 * modules under test run unmodified.
 */

export interface FakeBrowserOptions {
  /** Return true to make the fake browser silently drop a cookie, like a blocked cookie. */
  reject?: (name: string, value: string) => boolean;
}

export interface FakeBrowser {
  /** Raw cookie jar: name -> value. */
  jar: Map<string, string>;
  /** Backing map for the fake sessionStorage. */
  sessionStore: Map<string, string>;
}

export function installFakeBrowser(opts: FakeBrowserOptions = {}): FakeBrowser {
  const jar = new Map<string, string>();
  const sessionStore = new Map<string, string>();

  const doc = {
    get cookie(): string {
      return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    set cookie(raw: string) {
      const parts = raw.split(';').map((s) => s.trim());
      const pair = parts[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq <= 0) return;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const maxAge = parts.find((p) => p.toLowerCase().startsWith('max-age='));
      if (maxAge !== undefined && Number(maxAge.split('=')[1]) <= 0) {
        jar.delete(name);
      } else if (opts.reject?.(name, value)) {
        // Blocked cookie: the browser ignores it without an error.
      } else {
        jar.set(name, value);
      }
    },
  };

  const storage = {
    getItem: (k: string) => sessionStore.get(k) ?? null,
    setItem: (k: string, v: string) => {
      sessionStore.set(k, String(v));
    },
    removeItem: (k: string) => {
      sessionStore.delete(k);
    },
    clear: () => sessionStore.clear(),
    key: (i: number) => [...sessionStore.keys()][i] ?? null,
    get length() {
      return sessionStore.size;
    },
  };

  vi.stubGlobal('document', doc);
  vi.stubGlobal('sessionStorage', storage);
  return { jar, sessionStore };
}

/** Resolves once the write queue of cookieStorage has drained (queued writes run in order). */
export async function drainCookieQueue(cs: { removeItem(key: string): Promise<unknown> }): Promise<void> {
  // removeItem of a key that owns no cookies is a no-op, but it is queued behind earlier writes.
  await cs.removeItem('__drain__');
}

/** Polls until `predicate` is true or the timeout passes. */
export async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Deterministic pseudo-random base64-alphabet text. Incompressible enough to defeat gzip. */
export function randomText(length: number, seed = 1): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let s = seed >>> 0;
  let out = '';
  for (let i = 0; i < length; i++) {
    // mulberry32
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    out += alphabet[Math.floor(r * alphabet.length)];
  }
  return out;
}
