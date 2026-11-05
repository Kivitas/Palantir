/**
 * Cookie-backed key/value storage with a hard budget on the total Cookie header size.
 *
 * Layout per key `K`:
 *   - `K_0 .. K_{n-1}`: payload chunks (<= CHUNK_SIZE chars each, base64url)
 *   - `K_n`: commit cookie, value `${n}.${payloadLength}.${checksum}`
 *
 * Payload = one marker char ('g' = gzip, 'p' = plain UTF-8) followed by base64url bytes.
 * Writes go chunks first, commit cookie last, stale chunks removed afterwards. A read whose
 * chunks, length or checksum do not match the commit cookie is treated as empty (torn write).
 *
 * Only cookies are used for persistence. localStorage is touched only by migrateFromLocalStorage,
 * which moves values out of it.
 *
 * Keys may contain letters, digits, '_', '.', '-' (max 64 chars). Cookies not owned by the store
 * (any name that is not `${key}_<digits>` or `${key}_n` for a valid key) are left alone but still
 * count toward the header budget.
 */

/** Hard cap on the total Cookie header bytes (name=value pairs, "; " separators included). */
export const MAX_COOKIE_BYTES = 16000;
/** Max characters of payload stored in one cookie value. */
export const CHUNK_SIZE = 3500;

const DEBOUNCE_MS = 300;
const MAX_AGE_SECONDS = 31536000;
const KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const BACKUP_FORMAT = 'palantir-cookie-backup';
const MAX_CHUNKS = 64;

export type WriteFailure =
  | { ok: false; reason: 'quota'; bytesNeeded: number; budgetBytes: number }
  | { ok: false; reason: 'invalid_key' | 'unsupported' | 'error'; message: string };

export type WriteResult = { ok: true } | WriteFailure;

/** A write outcome tagged with the key it applies to. Delivered to onWriteResult listeners. */
export type WriteEvent = WriteResult & { key: string };

export interface CookieUsage {
  /** Total Cookie header bytes across all cookies on this origin. */
  bytesUsed: number;
  budgetBytes: number;
  /** Number of cookies on this origin. */
  cookies: number;
}

export interface MigrationReport {
  migrated: string[];
  /** localStorage value was identical to the cookie value; localStorage copy removed. */
  alreadyPresent: string[];
  /** Cookie holds a different value; localStorage left untouched. */
  conflicts: string[];
  /** Key was not in localStorage. */
  missing: string[];
  failed: Array<{ key: string; result: WriteFailure }>;
}

export interface ImportReport {
  ok: boolean;
  written: string[];
  failed: Array<{ key: string; result: WriteFailure }>;
  error?: string;
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: 1;
  exportedAt: string;
  entries: Record<string, string>;
}

// ---------------------------------------------------------------------------
// In-memory cache, pending debounced writes, listeners
// ---------------------------------------------------------------------------

const cache = new Map<string, string>();
const pending = new Map<string, string | null>();
const listeners = new Set<(event: WriteEvent) => void>();
let ready = false;
let initPromise: Promise<void> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lifecycleAttached = false;
let writeQueue: Promise<unknown> = Promise.resolve();

function emit(key: string, result: WriteResult): void {
  const event = { ...result, key } as WriteEvent;
  for (const cb of listeners) {
    try {
      cb(event);
    } catch (err) {
      console.warn('[cookieStorage] write listener threw', err);
    }
  }
}

function invalidKey(key: string): WriteFailure {
  return { ok: false, reason: 'invalid_key', message: `Invalid storage key "${key}"` };
}

// ---------------------------------------------------------------------------
// Cookie primitives
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function cookieAvailable(): boolean {
  return typeof document !== 'undefined' && typeof document.cookie === 'string';
}

function isSecureContextOrigin(): boolean {
  return typeof location !== 'undefined' && location.protocol === 'https:';
}

function readCookies(): Array<[string, string]> {
  if (!cookieAvailable()) return [];
  const out: Array<[string, string]> = [];
  for (const part of document.cookie.split(';')) {
    const pair = part.trim();
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    out.push([pair.slice(0, eq), pair.slice(eq + 1)]);
  }
  return out;
}

/** Bytes the cookies contribute to a Cookie request header. */
function headerBytes(pairs: ReadonlyArray<readonly [string, string]>): number {
  let total = 0;
  for (const [name, value] of pairs) {
    total += encoder.encode(name).length + 1 + encoder.encode(value).length;
  }
  if (pairs.length > 1) total += 2 * (pairs.length - 1);
  return total;
}

function setCookie(name: string, value: string): void {
  const secure = isSecureContextOrigin() ? '; Secure' : '';
  document.cookie = `${name}=${value}; path=/; max-age=${MAX_AGE_SECONDS}; SameSite=Strict${secure}`;
}

function deleteCookie(name: string): void {
  const secure = isSecureContextOrigin() ? '; Secure' : '';
  document.cookie = `${name}=; path=/; max-age=0; SameSite=Strict${secure}`;
}

/** True if `name` is one of the cookies this store uses for `key`. */
function ownsCookie(name: string, key: string): boolean {
  if (!name.startsWith(`${key}_`)) return false;
  const rest = name.slice(key.length + 1);
  return rest === 'n' || /^\d+$/.test(rest);
}

/** Chunk index for a cookie owned by `key`, or -1 for the commit cookie / non-chunk names. */
function chunkIndexOf(name: string, key: string): number {
  const rest = name.slice(key.length + 1);
  return /^\d+$/.test(rest) ? Number(rest) : -1;
}

/** Keys that have a commit cookie on this origin. */
function listStoredKeys(): string[] {
  const keys = new Set<string>();
  for (const [name] of readCookies()) {
    const m = /^(.+)_n$/.exec(name);
    const key = m?.[1];
    if (key && KEY_RE.test(key)) keys.add(key);
  }
  return [...keys].sort();
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function compressionAvailable(): boolean {
  return (
    typeof CompressionStream !== 'undefined' &&
    typeof DecompressionStream !== 'undefined' &&
    typeof Response !== 'undefined' &&
    typeof Blob !== 'undefined'
  );
}

async function gzip(input: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([input]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(input: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Encodes a value as marker + base64url. Uses gzip when available and when it is smaller. */
async function encodePayload(value: string): Promise<string> {
  const plain = encoder.encode(value);
  let best = `p${toBase64Url(plain)}`;
  if (compressionAvailable()) {
    try {
      const candidate = `g${toBase64Url(await gzip(plain))}`;
      if (candidate.length < best.length) best = candidate;
    } catch {
      // Compression failed; keep the plain payload.
    }
  }
  return best;
}

async function decodePayload(payload: string): Promise<string> {
  const marker = payload.charAt(0);
  const body = payload.slice(1);
  if (marker === 'p') return decoder.decode(fromBase64Url(body));
  if (marker === 'g') {
    if (!compressionAvailable()) throw new Error('gzip payload but DecompressionStream is unavailable');
    return decoder.decode(await gunzip(fromBase64Url(body)));
  }
  throw new Error(`unknown payload marker "${marker}"`);
}

/** FNV-1a 32-bit over UTF-16 code units, as 8 hex chars. Used to detect torn writes. */
function checksum(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Read / write / remove against cookies (source of truth)
// ---------------------------------------------------------------------------

async function readFromCookies(key: string): Promise<string | null> {
  if (!KEY_RE.test(key)) return null;
  const pairs = new Map(readCookies());
  const meta = pairs.get(`${key}_n`);
  if (meta === undefined) return null;

  const m = /^(\d+)\.(\d+)\.([0-9a-f]{8})$/.exec(meta);
  if (!m) return warnNull(key, 'malformed commit cookie');
  const count = Number(m[1]);
  const length = Number(m[2]);
  const sum = m[3] ?? '';
  if (count < 1 || count > MAX_CHUNKS) return warnNull(key, 'chunk count out of range');

  let payload = '';
  for (let i = 0; i < count; i++) {
    const part = pairs.get(`${key}_${i}`);
    if (part === undefined) return warnNull(key, `missing chunk ${i}`);
    payload += part;
  }
  if (payload.length !== length || checksum(payload) !== sum) {
    return warnNull(key, 'checksum/length mismatch (torn write?)');
  }
  try {
    return await decodePayload(payload);
  } catch (err) {
    return warnNull(key, `decode failed: ${String(err)}`);
  }
}

function warnNull(key: string, reason: string): null {
  console.warn(`[cookieStorage] "${key}" unreadable, treating as empty: ${reason}`);
  return null;
}

async function writeToCookies(key: string, value: string): Promise<WriteResult> {
  if (!KEY_RE.test(key)) return invalidKey(key);
  if (!cookieAvailable()) {
    return { ok: false, reason: 'unsupported', message: 'Cookies are not available in this environment' };
  }

  const payload = await encodePayload(value);
  const chunks: string[] = [];
  for (let i = 0; i < payload.length; i += CHUNK_SIZE) chunks.push(payload.slice(i, i + CHUNK_SIZE));
  const meta = `${chunks.length}.${payload.length}.${checksum(payload)}`;

  const next: Array<[string, string]> = chunks.map((chunk, i) => [`${key}_${i}`, chunk]);
  next.push([`${key}_n`, meta]);

  // Budget check against the state that will exist after this write.
  const current = readCookies();
  const others = current.filter(([name]) => !ownsCookie(name, key));
  const bytesNeeded = headerBytes([...others, ...next]);
  if (bytesNeeded > MAX_COOKIE_BYTES) {
    return { ok: false, reason: 'quota', bytesNeeded, budgetBytes: MAX_COOKIE_BYTES };
  }

  // Chunks first, commit cookie last.
  for (const [name, val] of next.slice(0, -1)) setCookie(name, val);
  setCookie(`${key}_n`, meta);

  // Verify the browser accepted every cookie (blocked cookies or oversize values fail silently).
  const after = new Map(readCookies());
  for (const [name, val] of next) {
    if (after.get(name) !== val) {
      return { ok: false, reason: 'error', message: `Browser did not store cookie "${name}"` };
    }
  }

  // Stale chunks from a previous, larger value.
  for (const [name] of current) {
    if (name === `${key}_n` || !ownsCookie(name, key)) continue;
    const idx = chunkIndexOf(name, key);
    if (idx >= chunks.length) deleteCookie(name);
  }
  return { ok: true };
}

function removeFromCookies(key: string): WriteResult {
  if (!KEY_RE.test(key)) return invalidKey(key);
  for (const [name] of readCookies()) {
    if (ownsCookie(name, key)) deleteCookie(name);
  }
  return { ok: true };
}

/** Serializes all cookie mutations so writes to the same key land in call order. */
function enqueue(key: string, value: string | null): Promise<WriteResult> {
  const run: Promise<WriteResult> = writeQueue.then(async (): Promise<WriteResult> => {
    try {
      return value === null ? removeFromCookies(key) : await writeToCookies(key, value);
    } catch (err) {
      return { ok: false, reason: 'error', message: String(err) };
    }
  });
  writeQueue = run;
  return run;
}

// ---------------------------------------------------------------------------
// Async API
// ---------------------------------------------------------------------------

/**
 * Stores a value. Updates the in-memory cache immediately; resolves once the cookies are written
 * or the write was refused (quota). On quota failure nothing is written to cookies, but the cache
 * keeps the value so the app keeps working; the caller should warn the user.
 */
export async function setItem(key: string, value: string): Promise<WriteResult> {
  if (!KEY_RE.test(key)) {
    const r = invalidKey(key);
    emit(key, r);
    return r;
  }
  cache.set(key, value);
  pending.delete(key);
  const result = await enqueue(key, value);
  emit(key, result);
  return result;
}

/** Reads a value from the cache once initialized, otherwise directly from cookies. */
export async function getItem(key: string): Promise<string | null> {
  if (ready) return cache.get(key) ?? null;
  return readFromCookies(key);
}

export async function removeItem(key: string): Promise<WriteResult> {
  if (!KEY_RE.test(key)) {
    const r = invalidKey(key);
    emit(key, r);
    return r;
  }
  cache.delete(key);
  pending.delete(key);
  const result = await enqueue(key, null);
  emit(key, result);
  return result;
}

/** Current Cookie header usage for this origin. Synchronous; reads document.cookie only. */
export function usage(): CookieUsage {
  const pairs = readCookies();
  return { bytesUsed: headerBytes(pairs), budgetBytes: MAX_COOKIE_BYTES, cookies: pairs.length };
}

// ---------------------------------------------------------------------------
// Synchronous cache pattern
// ---------------------------------------------------------------------------

function scheduleFlush(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushCookieWrites();
  }, DEBOUNCE_MS);
}

/** Writes all debounced sync changes now. Resolves when those writes have finished. */
export async function flushCookieWrites(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const batch = [...pending];
  pending.clear();
  await Promise.all(
    batch.map(async ([key, value]) => {
      const result = await enqueue(key, value);
      emit(key, result);
    }),
  );
}

function attachLifecycleFlush(): void {
  if (lifecycleAttached || typeof window === 'undefined' || typeof document === 'undefined') return;
  lifecycleAttached = true;
  window.addEventListener('pagehide', () => {
    void flushCookieWrites();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushCookieWrites();
  });
}

/**
 * Reads and decompresses every stored key into the in-memory cache. Call once at startup and
 * await it before using getItemSync. Safe to call more than once.
 */
export function initCookieStorage(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      try {
        const keys = listStoredKeys();
        await Promise.all(
          keys.map(async (key) => {
            // Values written before init (pending or cached) take precedence over cookies.
            if (cache.has(key) || pending.has(key)) return;
            const value = await readFromCookies(key);
            if (value !== null && !cache.has(key)) cache.set(key, value);
          }),
        );
      } catch (err) {
        console.warn('[cookieStorage] init failed', err);
      }
      ready = true;
      attachLifecycleFlush();
    })();
  }
  return initPromise;
}

/** Synchronous read from the cache. Returns null for every key until initCookieStorage resolves. */
export function getItemSync(key: string): string | null {
  return cache.get(key) ?? null;
}

/**
 * Updates the cache immediately and schedules a cookie write, debounced by 300ms and flushed on
 * pagehide / hidden visibility. Results are reported through onWriteResult.
 */
export function setItemSync(key: string, value: string): void {
  if (!KEY_RE.test(key)) {
    emit(key, invalidKey(key));
    return;
  }
  cache.set(key, value);
  pending.set(key, value);
  scheduleFlush();
}

export function removeItemSync(key: string): void {
  if (!KEY_RE.test(key)) {
    emit(key, invalidKey(key));
    return;
  }
  cache.delete(key);
  pending.set(key, null);
  scheduleFlush();
}

/** Subscribes to write outcomes (sync flushes and async writes). Returns an unsubscribe function. */
export function onWriteResult(cb: (event: WriteEvent) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// ---------------------------------------------------------------------------
// Migration and backup
// ---------------------------------------------------------------------------

/**
 * Moves the given localStorage keys into cookies. A key is removed from localStorage only after
 * its cookie value has been written and read back identically. Keys that already exist in
 * cookies with a different value are left alone in localStorage and reported as conflicts.
 */
export async function migrateFromLocalStorage(keys: string[]): Promise<MigrationReport> {
  const report: MigrationReport = {
    migrated: [],
    alreadyPresent: [],
    conflicts: [],
    missing: [],
    failed: [],
  };

  let ls: Storage | null = null;
  try {
    ls = typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    ls = null;
  }
  if (!ls) return report;

  for (const key of keys) {
    if (!KEY_RE.test(key)) {
      report.failed.push({ key, result: invalidKey(key) });
      continue;
    }

    let raw: string | null;
    try {
      raw = ls.getItem(key);
    } catch {
      report.failed.push({ key, result: { ok: false, reason: 'error', message: 'localStorage unavailable' } });
      continue;
    }
    if (raw === null) {
      report.missing.push(key);
      continue;
    }

    const existing = await getItem(key);
    if (existing === raw) {
      ls.removeItem(key);
      report.alreadyPresent.push(key);
      continue;
    }
    if (existing !== null) {
      report.conflicts.push(key);
      continue;
    }

    const result = await setItem(key, raw);
    if (!result.ok) {
      report.failed.push({ key, result });
      continue;
    }
    if ((await readFromCookies(key)) !== raw) {
      report.failed.push({ key, result: { ok: false, reason: 'error', message: 'Read-back mismatch after write' } });
      continue;
    }
    ls.removeItem(key);
    report.migrated.push(key);
  }
  return report;
}

/**
 * Serializes every stored key/value to a JSON backup string. Includes values held in the cache
 * even if they could not be written due to quota, so the user can keep them.
 */
export async function exportAll(): Promise<string> {
  await flushCookieWrites();
  const entries: Record<string, string> = {};
  if (ready) {
    for (const key of [...cache.keys()].sort()) {
      const value = cache.get(key);
      if (value !== undefined) entries[key] = value;
    }
  } else {
    for (const key of listStoredKeys()) {
      const value = await readFromCookies(key);
      if (value !== null) entries[key] = value;
    }
  }
  const file: BackupFile = {
    format: BACKUP_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    entries,
  };
  return JSON.stringify(file, null, 2);
}

function isBackupFile(value: unknown): value is BackupFile {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<BackupFile>;
  if (v.format !== BACKUP_FORMAT || v.version !== 1) return false;
  if (typeof v.entries !== 'object' || v.entries === null) return false;
  return Object.values(v.entries).every((entry) => typeof entry === 'string');
}

/**
 * Restores a backup produced by exportAll. Merges into existing data: keys present in the backup
 * overwrite current values, other keys are kept. Each key is subject to the same quota check;
 * keys that do not fit are reported in `failed` and the rest are still written.
 */
export async function importAll(json: string): Promise<ImportReport> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, written: [], failed: [], error: 'Backup is not valid JSON' };
  }
  if (!isBackupFile(parsed)) {
    return { ok: false, written: [], failed: [], error: 'Not a recognized cookie backup file' };
  }

  const report: ImportReport = { ok: true, written: [], failed: [] };
  for (const [key, value] of Object.entries(parsed.entries)) {
    const result = await setItem(key, value);
    if (result.ok) report.written.push(key);
    else report.failed.push({ key, result });
  }
  report.ok = report.failed.length === 0;
  return report;
}
