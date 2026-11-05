// @vitest-environment node
// Node environment: cookieStorage needs a document/Blob/CompressionStream surface that jsdom does
// not fully provide (Blob.stream). The cookie jar is a fake document.cookie from the helper.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeBrowser, randomText, type FakeBrowser } from './helpers/fakeBrowser';

type CookieModule = typeof import('../src/utils/cookieStorage');

let browser: FakeBrowser;
let cs: CookieModule;

/** Fresh module instance: empty in-memory cache, same cookies (a page reload). */
async function freshModule(): Promise<CookieModule> {
  vi.resetModules();
  return import('../src/utils/cookieStorage');
}

async function reload(): Promise<CookieModule> {
  cs = await freshModule();
  await cs.initCookieStorage();
  return cs;
}

beforeEach(async () => {
  browser = installFakeBrowser();
  cs = await freshModule();
});

afterEach(async () => {
  // Clear any debounced flush timer so it cannot fire into a later test's cookie jar.
  await cs.flushCookieWrites();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('round trip', () => {
  it('restores a plain value after a reload', async () => {
    const value = 'hello wörld 🚀';
    expect((await cs.setItem('note', value)).ok).toBe(true);
    await reload();
    expect(cs.getItemSync('note')).toBe(value);
  });

  it('reads cookies directly with getItem before initialisation', async () => {
    await cs.setItem('early', 'value');
    const fresh = await freshModule();
    await expect(fresh.getItem('early')).resolves.toBe('value');
  });

  it('round-trips multi-byte and control characters', async () => {
    const value = 'line1\nline2\t"quoted" \u0000 日本語 😀';
    await cs.setItem('mixed', value);
    await reload();
    expect(cs.getItemSync('mixed')).toBe(value);
  });
});

describe('chunking', () => {
  it('splits a large payload into CHUNK_SIZE cookies plus a commit cookie', async () => {
    const value = randomText(12000, 7);
    expect((await cs.setItem('big', value)).ok).toBe(true);

    const chunkNames = [...browser.jar.keys()].filter((n) => /^big_\d+$/.test(n));
    const chunks = chunkNames.map((n) => browser.jar.get(n) ?? '');
    const commit = browser.jar.get('big_n');

    expect(commit).toMatch(/^\d+\.\d+\.[0-9a-f]{8}$/);
    const [count, length] = (commit ?? '').split('.');
    expect(Number(count)).toBe(chunks.length);
    expect(Number(length)).toBe(chunks.reduce((n, c) => n + c.length, 0));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(cs.CHUNK_SIZE);
    expect(chunks.length).toBeGreaterThan(1);

    await reload();
    expect(cs.getItemSync('big')).toBe(value);
  });

  it('removes stale chunk cookies when a value shrinks', async () => {
    await cs.setItem('shrink', randomText(12000, 3));
    const before = [...browser.jar.keys()].filter((n) => /^shrink_\d+$/.test(n)).length;
    expect(before).toBeGreaterThan(1);

    await cs.setItem('shrink', 'tiny');
    const remaining = [...browser.jar.keys()].filter((n) => /^shrink_\d+$/.test(n));
    expect(remaining).toEqual(['shrink_0']);

    await reload();
    expect(cs.getItemSync('shrink')).toBe('tiny');
  });

  it('treats a missing chunk as an empty value', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await cs.setItem('gap', randomText(12000, 5));
    browser.jar.delete('gap_1');
    await reload();
    expect(cs.getItemSync('gap')).toBeNull();
  });

  it('treats a tampered chunk as a torn write', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await cs.setItem('torn', randomText(12000, 9));
    const c0 = browser.jar.get('torn_0') ?? '';
    browser.jar.set('torn_0', (c0[0] === 'A' ? 'B' : 'A') + c0.slice(1));
    await reload();
    expect(cs.getItemSync('torn')).toBeNull();
  });

  it('treats a malformed commit cookie as empty', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    browser.jar.set('junk_n', 'not-a-commit');
    browser.jar.set('junk_0', 'pabc');
    await reload();
    expect(cs.getItemSync('junk')).toBeNull();
  });
});

describe('compression', () => {
  it('uses the gzip marker for repetitive data and round-trips it', async () => {
    const value = 'abc '.repeat(4000);
    await cs.setItem('rep', value);

    const payload = browser.jar.get('rep_0') ?? '';
    expect(payload.charAt(0)).toBe('g');
    expect(browser.jar.has('rep_1')).toBe(false); // gzip keeps it in one cookie

    await reload();
    expect(cs.getItemSync('rep')).toBe(value);
  });
});

describe('quota and browser refusal', () => {
  it('refuses a write that would exceed the 16000-byte Cookie header budget', async () => {
    browser.jar.set('blob', 'a'.repeat(15900));
    const result = await cs.setItem('k', randomText(2000, 3));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('quota');
    expect(result).toMatchObject({ budgetBytes: cs.MAX_COOKIE_BYTES });
    if (result.reason === 'quota') expect(result.bytesNeeded).toBeGreaterThan(cs.MAX_COOKIE_BYTES);

    expect([...browser.jar.keys()].some((n) => n.startsWith('k_'))).toBe(false);
    // The cache still keeps the value so the app keeps working in this page.
    expect(cs.getItemSync('k')).not.toBeNull();
    expect(cs.usage().bytesUsed).toBeLessThanOrEqual(cs.MAX_COOKIE_BYTES);
  });

  it('keeps the previously stored value when an overwrite is refused', async () => {
    browser.jar.set('blob', 'a'.repeat(15000));
    expect((await cs.setItem('k', 'v1')).ok).toBe(true);

    const refused = await cs.setItem('k', randomText(2000, 4));
    expect(refused.ok).toBe(false);

    await reload();
    expect(cs.getItemSync('k')).toBe('v1');
  });

  it('reports a browser that silently drops cookies as an error', async () => {
    browser = installFakeBrowser({ reject: () => true });
    cs = await freshModule();

    const result = await cs.setItem('blocked', 'value');
    expect(result).toMatchObject({ ok: false, reason: 'error' });
    expect(browser.jar.size).toBe(0);
  });
});

describe('keys', () => {
  it('rejects keys with disallowed characters, empty keys and keys over 64 chars', async () => {
    for (const key of ['bad key!', '', 'a'.repeat(65), 'semi;colon']) {
      const r = await cs.setItem(key, 'x');
      expect(r).toMatchObject({ ok: false, reason: 'invalid_key' });
    }
    expect(browser.jar.size).toBe(0);
  });

  it('accepts a key at the 64-character limit', async () => {
    const key = 'a'.repeat(64);
    expect((await cs.setItem(key, 'x')).ok).toBe(true);
  });
});

describe('write queue and sync cache', () => {
  it('setItemSync updates the cache immediately and writes cookies on flush', async () => {
    cs.setItemSync('s', 'value');
    expect(cs.getItemSync('s')).toBe('value');
    expect(browser.jar.size).toBe(0);

    await cs.flushCookieWrites();
    expect(browser.jar.has('s_n')).toBe(true);
    await reload();
    expect(cs.getItemSync('s')).toBe('value');
  });

  it('removeItem deletes only the cookies owned by that key', async () => {
    await cs.setItem('k', 'v');
    await cs.setItem('kk', 'z');
    browser.jar.set('keep', '1');

    await cs.removeItem('k');
    expect([...browser.jar.keys()].sort()).toEqual(['keep', 'kk_0', 'kk_n'].sort());
    expect(cs.getItemSync('k')).toBeNull();
  });

  it('reports each write outcome with its key to onWriteResult listeners', async () => {
    const events: Array<{ key: string; ok: boolean }> = [];
    const unsubscribe = cs.onWriteResult((e) => events.push({ key: e.key, ok: e.ok }));

    await cs.setItem('evt', 'v');
    expect(events).toContainEqual({ key: 'evt', ok: true });

    unsubscribe();
    await cs.setItem('evt2', 'v');
    expect(events.some((e) => e.key === 'evt2')).toBe(false);
  });
});

describe('usage', () => {
  it('counts Cookie header bytes including "; " separators', () => {
    browser.jar.set('a', 'bc'); // 1 + 1 + 2 = 4
    browser.jar.set('de', 'f'); // 2 + 1 + 1 = 4, plus 2 for the separator
    expect(cs.usage()).toEqual({ bytesUsed: 10, budgetBytes: 16000, cookies: 2 });
  });
});

describe('export and import', () => {
  it('round-trips every stored key through a backup file', async () => {
    await cs.initCookieStorage();
    await cs.setItem('a', 'alpha');
    await cs.setItem('b', randomText(5000, 11));
    const backup = await cs.exportAll();

    browser = installFakeBrowser();
    cs = await freshModule();
    await cs.initCookieStorage();

    const report = await cs.importAll(backup);
    expect(report.ok).toBe(true);
    expect(report.written.sort()).toEqual(['a', 'b']);
    expect(cs.getItemSync('a')).toBe('alpha');
    await reload();
    expect(cs.getItemSync('b')).toBe(randomText(5000, 11));
  });

  it('rejects malformed backup files', async () => {
    expect(await cs.importAll('{')).toMatchObject({ ok: false, error: 'Backup is not valid JSON' });
    expect(await cs.importAll('{"format":"other","version":1,"entries":{}}')).toMatchObject({
      ok: false,
      error: 'Not a recognized cookie backup file',
    });
  });
});
