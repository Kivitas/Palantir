import {
  Case, Settings, SignalStatus, ClearanceLevel, PropertyType, SeverityLevel, AuditLog,
  AIProvider, AISettings, Entity, Incident, Relationship, Signal, OntologyObjectType, ActionType,
  CLEARANCE_LEVELS, hasClearance, WatchRule
} from './types';
import { FEED_LAYER_IDS, type FeedLayerId } from './osiris/types';
import {
  initCookieStorage, getItemSync, setItemSync, removeItemSync, removeItem, flushCookieWrites, onWriteResult,
  migrateFromLocalStorage, exportAll, usage, MAX_COOKIE_BYTES
} from './utils/cookieStorage';
import type { CookieUsage, WriteEvent } from './utils/cookieStorage';

/**
 * Schema 2: accounts were removed. Schema 1 blobs carried `users` (password hashes), `current_user`
 * and `current_user_id`; they are ignored on load and dropped on the next write.
 */
export const SCHEMA_VERSION = 2;

/**
 * The app is a single-operator local workspace. Every action is audited as this name, and the
 * operator always holds the top clearance level.
 */
export const OPERATOR_NAME = 'operator';
export const OPERATOR_CLEARANCE: ClearanceLevel = 'TOP_SECRET';

/** Cookie key (via cookieStorage) holding the workspace blob. */
const WORKSPACE_KEY = 'aegis_ws';
/** Cookie key the workspace used before cookie storage (moved by migrateFromLocalStorage). */
const LEGACY_WS_KEY = 'palantir_workspace';
/**
 * AI API keys are kept in sessionStorage, never in cookies: cookies are sent with every HTTP
 * request to the origin, which would leak the keys to any server the app talks to. sessionStorage
 * is per tab and cleared when the tab closes, so keys are not persisted across sessions.
 */
const AI_KEYS_SESSION_KEY = 'aegis_ai_keys';
const LEGACY_AI_KEYS_KEY = 'palantir_ai_keys';
const CORRUPT_SESSION_KEY = 'aegis_ws_corrupt';
const LEGACY_CORRUPT_KEY = 'palantir_workspace_corrupt';
const WORKSPACE_BACKUP_FORMAT = 'aegis-workspace-backup';

/** Audit log cap. The whole workspace shares a 16KB cookie budget, so keep this small. */
const MAX_LOGS = 150;
/** Feed-derived signals kept per case (cookie budget). Oldest DISMISSED ones are evicted first. */
const MAX_SIGNALS = 25;
/** Watch rules per case. */
export const MAX_WATCH_RULES = 5;
/** Length caps for feed-derived signal text, to keep the cookie budget in check. */
const SIGNAL_TITLE_MAX = 120;
const SIGNAL_TEXT_MAX = 240;
const RULE_KEYWORD_MAX = 60;
export const MAX_RADIUS_KM = 20000;
/** On a quota failure, audit logs are evicted down to this many before retrying once. */
const LOG_EVICTION_FLOOR = 20;
const PERSIST_DEBOUNCE_MS = 300;
const PROVIDERS: AIProvider[] = ['openai', 'gemini', 'anthropic', 'mistral'];
const SEVERITIES: SeverityLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
const CLEARANCES = Object.keys(CLEARANCE_LEVELS) as ClearanceLevel[];

export interface StoreResult { success: boolean; msg: string }
export interface BulkAddResult { added: number; error?: string }
/** Input for addSignal. Text is truncated to fit the storage budget. */
export interface SignalInput {
  source_id: string;
  title: string;
  description: string;
  severity: SeverityLevel;
  ai_assessment: string;
  clearance?: ClearanceLevel;
}
/** Editable fields of a watch rule. */
export type WatchRuleInput = Omit<WatchRule, 'id' | 'enabled'> & { enabled?: boolean };

export interface WorkspaceState {
  cases: Case[];
  active_case_id: string | null;
  settings: Settings;
  active_path: string[];
  selected_object: { type: string; id: string } | null;
  logs: AuditLog[];
}

type Rec = Record<string, unknown>;

const newId = (): string => {
  // crypto.randomUUID exists only in secure contexts (https / localhost). Over a plain-http
  // LAN address it is undefined, so fall back to getRandomValues, which works everywhere.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
function arr<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
const asClearance = (v: unknown): ClearanceLevel =>
  typeof v === 'string' && (CLEARANCES as string[]).includes(v) ? (v as ClearanceLevel) : 'UNCLASSIFIED';
/**
 * Clearance for imported entities, incidents and relationships. Missing or invalid values fail
 * CLOSED to TOP_SECRET, so an item with unknown sensitivity is never exported to a lower-cleared
 * viewer.
 */
const asItemClearance = (v: unknown): ClearanceLevel =>
  typeof v === 'string' && (CLEARANCES as string[]).includes(v) ? (v as ClearanceLevel) : 'TOP_SECRET';
const asSeverity = (v: unknown): SeverityLevel =>
  typeof v === 'string' && (SEVERITIES as string[]).includes(v) ? (v as SeverityLevel) : 'LOW';

const fail = (msg: string): StoreResult => ({ success: false, msg });

const pickName = (item: Rec): string | undefined => {
  for (const k of ['name', 'title', 'id'] as const) {
    const v = item[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return undefined;
};

const toPropString = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v) ?? String(v);
};

// ---- Browser storage helpers (each access guarded: storage may be blocked or throw) ----

function legacyLocalGet(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function legacyLocalRemove(key: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
  } catch {
    // Storage unavailable: nothing to remove.
  }
}

function sessionGet(key: string): string | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Returns false if the value could not be stored. */
function sessionSet(key: string, value: string): boolean {
  try {
    sessionStorage.setItem(key, value);
    return true;
  } catch (e) {
    console.error(`[store] sessionStorage write failed for "${key}":`, e);
    return false;
  }
}

function sessionRemove(key: string): void {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(key);
  } catch {
    // Storage unavailable: nothing to remove.
  }
}

function describeQuota(bytesNeeded: number): string {
  return `Cookie storage is full (${(bytesNeeded / 1000).toFixed(1)} of ${MAX_COOKIE_BYTES / 1000}KB). Export a backup and delete old data.`;
}

/** Validates a stored or user-supplied watch rule. Returns null if the layer is unknown. */
const sanitizeRule = (raw: unknown): WatchRule | null => {
  if (!isRecord(raw)) return null;
  const layer = raw.layer;
  if (typeof layer !== 'string' || !(FEED_LAYER_IDS as readonly string[]).includes(layer)) return null;
  const rule: WatchRule = {
    id: str(raw.id) || newId(),
    layer: layer as FeedLayerId,
    enabled: raw.enabled !== false,
  };
  if (typeof raw.minSeverity === 'number' && Number.isFinite(raw.minSeverity)) rule.minSeverity = raw.minSeverity;
  const keyword = str(raw.keyword).trim().slice(0, RULE_KEYWORD_MAX);
  if (keyword) rule.keyword = keyword;
  const radius = raw.withinIncidentRadiusKm;
  if (typeof radius === 'number' && radius > 0 && radius <= MAX_RADIUS_KM) rule.withinIncidentRadiusKm = radius;
  return rule;
};

/** Keeps only object records and forces a valid clearance (fail closed) on each. */
function withItemClearance<T extends { clearance: ClearanceLevel }>(items: unknown[]): T[] {
  return items.filter(isRecord).map((i) => ({ ...i, clearance: asItemClearance(i.clearance) }) as unknown as T);
}

function normalizeCase(raw: Rec, forceId?: string): Case {
  return {
    id: forceId ?? (typeof raw.id === 'string' && raw.id ? raw.id : newId()),
    name: str(raw.name, 'Untitled case'),
    description: str(raw.description),
    severity_level: asSeverity(raw.severity_level),
    ontology_types: arr<OntologyObjectType>(raw.ontology_types),
    action_types: arr<ActionType>(raw.action_types),
    entities: withItemClearance<Entity>(arr<unknown>(raw.entities)),
    incidents: withItemClearance<Incident>(arr<unknown>(raw.incidents)),
    relationships: withItemClearance<Relationship>(arr<unknown>(raw.relationships)),
    signals: arr<unknown>(raw.signals).filter(isRecord).slice(0, MAX_SIGNALS) as unknown as Signal[],
    watch_rules: arr<unknown>(raw.watch_rules)
      .map(sanitizeRule)
      .filter((r): r is WatchRule => r !== null)
      .slice(0, MAX_WATCH_RULES),
    created_at: str(raw.created_at, new Date().toISOString()),
  };
}

const defaultAI = (model: string): AISettings => ({ enabled: false, model, key_stored: false });

/** Cells starting with one of these are read as formulas by spreadsheets (CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;
/** A plain number such as -33.86, 151.2 or 1e3. Spreadsheets read it as a value, never as a formula. */
const NUMERIC_CELL = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/**
 * One RFC 4180 cell. Formula-looking text gets a leading single quote so it stays text (purely
 * numeric cells such as negative coordinates are exempt), then the cell is quoted when it holds a
 * comma, a double quote or a line break.
 */
function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(text) && !NUMERIC_CELL.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV with a header row and CRLF line endings (RFC 4180). */
function csvText(headers: string[], rows: unknown[][]): string {
  return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Download name for a workspace backup in local time, e.g. aegis-nexus-backup-20261105-0907.json. */
export function getBackupFilename(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  return `aegis-nexus-backup-${day}-${p(now.getHours())}${p(now.getMinutes())}.json`;
}

/** Resolves when init() has finished. Create-once at module load; main.tsx can await it via initStore(). */
let resolveStoreReady: () => void = () => {};
export const storeReady: Promise<void> = new Promise<void>((resolve) => {
  resolveStoreReady = resolve;
});

class Store {
  private listeners = new Set<() => void>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private initPromise: Promise<void> | null = null;
  /** The workspace was loaded from a legacy key; that key is removed once the new key is written. */
  private loadedFromLegacy = false;
  /** A quota failure already triggered one eviction-and-retry; reset on the next outcome. */
  private retriedAfterEviction = false;

  /** True once init() has loaded stored data. Nothing is written to storage before this. */
  public ready = false;

  /** Last persistence error (e.g. quota exceeded). Null when the last write succeeded. */
  public lastError: string | null = null;

  public data: WorkspaceState = {
    cases: [],
    active_case_id: null,
    settings: {
      theme: 'light',
      ai: {
        openai: defaultAI('gpt-5'),
        gemini: defaultAI('gemini-2.5-flash'),
        anthropic: defaultAI('claude-sonnet-5-5'),
        mistral: defaultAI('mistral-large-latest'),
      }
    },
    active_path: [],
    selected_object: null,
    logs: []
  };

  // ---- Init ---------------------------------------------------------------

  /**
   * Loads stored data from cookies (async: cookies are decompressed on read). Idempotent.
   * Changes made before init stay in memory but are not written. If stored data exists, it
   * replaces them when loaded.
   */
  public init(): Promise<void> {
    if (!this.initPromise) this.initPromise = this.runInit();
    return this.initPromise;
  }

  private async runInit(): Promise<void> {
    try {
      await initCookieStorage();
      legacyLocalRemove(LEGACY_CORRUPT_KEY);

      try {
        const report = await migrateFromLocalStorage([LEGACY_WS_KEY]);
        if (report.failed.length > 0) {
          console.warn('[store] workspace migration incomplete; the old copy was kept', report.failed);
        }
      } catch (e) {
        console.error('[store] workspace migration failed:', e);
      }
      migrateLegacyAIKeys();

      const { fromLegacy, needsRewrite } = this.loadWorkspace();
      this.loadedFromLegacy = fromLegacy;
      this.loadAIKeys();
      this.syncKeyFlags();

      if (typeof window !== 'undefined') {
        window.addEventListener('beforeunload', () => this.flushNow());
      }
      onWriteResult((event) => this.onCookieWrite(event));

      this.ready = true;
      if (fromLegacy || needsRewrite) {
        this.persistKeys();
        this.schedulePersist();
      }
    } catch (e) {
      console.error('[store] init failed; continuing with empty workspace:', e);
      this.ready = true;
    }
    resolveStoreReady();
    this.notify();
  }

  /**
   * Tolerant loader: reads the blob from cookies (or a legacy copy). `needsRewrite` is set when the
   * stored blob is from an older schema, so it is saved again in the current shape at once.
   */
  private loadWorkspace(): { fromLegacy: boolean; needsRewrite: boolean } {
    let raw = getItemSync(WORKSPACE_KEY);
    let fromLegacy = false;
    if (raw === null) {
      raw = getItemSync(LEGACY_WS_KEY) ?? legacyLocalGet(LEGACY_WS_KEY);
      fromLegacy = raw !== null;
    }
    let needsRewrite = false;
    if (raw !== null) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        // Keep a copy of unreadable data before the next save overwrites it.
        console.error('Failed to parse workspace data; a copy was kept in sessionStorage:', e);
        sessionSet(CORRUPT_SESSION_KEY, raw);
      }
      if (isRecord(parsed)) {
        try {
          needsRewrite = this.applyPersisted(parsed) || needsRewrite;
        } catch (e) {
          console.error('Failed to apply workspace data:', e);
        }
      }
    }
    return { fromLegacy, needsRewrite };
  }

  /**
   * Tolerant loader: unknown or malformed fields fall back to defaults. Returns true if the blob
   * should be saved again (older schema, old account data, or AI keys stored in the blob).
   */
  private applyPersisted(p: Rec): boolean {
    const d = this.data;
    let rewrite = typeof p.schema_version !== 'number' || p.schema_version < SCHEMA_VERSION;
    if (typeof p.schema_version === 'number' && p.schema_version > SCHEMA_VERSION) {
      console.warn(`Workspace schema v${p.schema_version} is newer than v${SCHEMA_VERSION}; loading best-effort.`);
    }
    // Schema 1 account data (users, password hashes, current_user) is deliberately not read.
    // Its presence means the blob still needs rewriting, which drops those fields.
    if (Object.hasOwn(p, 'users') || Object.hasOwn(p, 'current_user') || Object.hasOwn(p, 'current_user_id')) {
      rewrite = true;
    }

    d.cases = arr<unknown>(p.cases).filter(isRecord).map((c) => normalizeCase(c));
    d.active_case_id = typeof p.active_case_id === 'string' ? p.active_case_id : null;
    d.active_path = arr<unknown>(p.active_path).filter((x): x is string => typeof x === 'string');
    d.logs = arr<Rec>(p.logs)
      .filter(isRecord)
      .slice(0, MAX_LOGS)
      .map((l): AuditLog => ({
        // Ids are not stored (saves ~40 bytes per entry); fresh ones are generated on load.
        id: newId(),
        timestamp: str(l.timestamp, new Date().toISOString()),
        username: str(l.username, 'SYSTEM'),
        action: str(l.action),
        details: str(l.details),
      }));
    d.selected_object = null;

    if (isRecord(p.settings)) {
      const s = p.settings;
      d.settings.theme = s.theme === 'dark' ? 'dark' : 'light';
      if (isRecord(s.ai)) {
        for (const prov of PROVIDERS) {
          const raw = s.ai[prov];
          if (!isRecord(raw)) continue;
          const cur = d.settings.ai[prov];
          cur.enabled = raw.enabled === true;
          cur.model = str(raw.model, cur.model);
          cur.key_stored = raw.key_stored === true;
          // Keys from builds that stored them inside the blob. They move to sessionStorage.
          if (typeof raw.apiKey === 'string' && raw.apiKey) {
            cur.apiKey = raw.apiKey;
            cur.key_stored = true;
            rewrite = true;
          }
        }
      }
    }
    return rewrite;
  }

  private loadAIKeys() {
    const raw = sessionGet(AI_KEYS_SESSION_KEY);
    if (!raw) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) return;
      for (const p of PROVIDERS) {
        const k = parsed[p];
        if (typeof k === 'string' && k) this.data.settings.ai[p].apiKey = k;
      }
    } catch (e) {
      console.error('Failed to load AI keys:', e);
    }
  }

  /** key_stored must reflect whether a key is actually held in this session. */
  private syncKeyFlags() {
    for (const p of PROVIDERS) {
      const s = this.data.settings.ai[p];
      s.key_stored = typeof s.apiKey === 'string' && s.apiKey.length > 0;
    }
  }

  // ---- Subscription -------------------------------------------------------

  /** Arrow property so the reference is stable for useSyncExternalStore. */
  public subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private notify() {
    [...this.listeners].forEach((l) => l());
  }

  /** Mutations call this: schedule a debounced write, then notify listeners. */
  private changed() {
    this.schedulePersist();
    this.notify();
  }

  /** Kept for callers that mutate `store.data` directly. */
  public save() {
    this.changed();
  }

  // ---- Persistence --------------------------------------------------------

  private schedulePersist() {
    if (this.persistTimer !== null) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.flushNow(), PERSIST_DEBOUNCE_MS);
  }

  /**
   * Writes the workspace now. Called by the debounce timer and on beforeunload. Does nothing
   * before init(): writing then would overwrite the stored data with empty defaults.
   */
  public flushNow() {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.ready) return;
    this.writeWorkspace();
    void flushCookieWrites();
  }

  private writeWorkspace() {
    setItemSync(WORKSPACE_KEY, this.serialize());
  }

  /** Outcome of each workspace cookie write. Handles quota eviction and the error message. */
  private onCookieWrite(event: WriteEvent) {
    if (event.key !== WORKSPACE_KEY) return;

    if (event.ok) {
      this.retriedAfterEviction = false;
      if (this.loadedFromLegacy) {
        this.loadedFromLegacy = false;
        removeItemSync(LEGACY_WS_KEY);
        legacyLocalRemove(LEGACY_WS_KEY);
      }
      this.setError(null);
      return;
    }

    if (event.reason === 'quota') {
      if (!this.retriedAfterEviction && this.evictOldestLogs(LOG_EVICTION_FLOOR)) {
        // Retry exactly once with the trimmed audit log.
        this.retriedAfterEviction = true;
        this.notify();
        this.writeWorkspace();
        void flushCookieWrites();
        return;
      }
      this.retriedAfterEviction = false;
      this.setError(describeQuota(event.bytesNeeded));
      return;
    }

    this.retriedAfterEviction = false;
    this.setError(`Could not save workspace: ${event.message}`);
  }

  /** Drops the oldest audit entries (the list is newest first). Returns false if nothing to drop. */
  private evictOldestLogs(floor: number): boolean {
    const logs = this.data.logs;
    if (logs.length <= floor) return false;
    console.warn(`[store] storage full: evicted ${logs.length - floor} oldest audit entries`);
    logs.splice(floor);
    return true;
  }

  private setError(msg: string | null) {
    if (this.lastError === msg) return;
    this.lastError = msg;
    this.notify();
  }

  /**
   * Main blob. API keys are excluded (sessionStorage only), and so is the transient selection.
   * Audit log ids are omitted; they are regenerated on load.
   */
  private serialize(): string {
    const d = this.data;
    const ai = {} as Settings['ai'];
    for (const p of PROVIDERS) {
      const s = d.settings.ai[p];
      ai[p] = { enabled: s.enabled, model: s.model, key_stored: s.key_stored };
    }
    return JSON.stringify({
      schema_version: SCHEMA_VERSION,
      cases: d.cases,
      active_case_id: d.active_case_id,
      settings: { theme: d.settings.theme, ai },
      active_path: d.active_path,
      logs: d.logs.map((l) => ({ timestamp: l.timestamp, username: l.username, action: l.action, details: l.details })),
    });
  }

  /**
   * AI keys go to sessionStorage only (see AI_KEYS_SESSION_KEY). They are never written to
   * cookies, so they are not sent with HTTP requests and do not count against the cookie budget.
   */
  private persistKeys() {
    if (!this.ready) return;
    const keys: Partial<Record<AIProvider, string>> = {};
    for (const p of PROVIDERS) {
      const k = this.data.settings.ai[p].apiKey;
      if (k) keys[p] = k;
    }
    if (Object.keys(keys).length > 0) {
      if (!sessionSet(AI_KEYS_SESSION_KEY, JSON.stringify(keys))) {
        this.setError('Could not keep AI keys for this session. Re-enter them if needed.');
      }
    } else {
      sessionRemove(AI_KEYS_SESSION_KEY);
    }
  }

  /** Size of the cookie budget in use. For the UI. */
  public getStorageUsage(): CookieUsage {
    return usage();
  }

  /**
   * Deletes every cookie this app stores, plus the legacy localStorage copies and the sessionStorage
   * copies (AI keys, corrupt-data copy). Writes are stopped first, so nothing is written back.
   * The caller should reload the page afterwards.
   */
  public async eraseAllLocalData(): Promise<StoreResult> {
    this.ready = false;
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const keys = new Set<string>([WORKSPACE_KEY, LEGACY_WS_KEY]);
    try {
      const backup = JSON.parse(await exportAll()) as { entries?: Record<string, unknown> };
      for (const k of Object.keys(backup.entries ?? {})) keys.add(k);
    } catch (e) {
      console.warn('[store] could not list stored keys before erase:', e);
    }
    const failed: string[] = [];
    for (const key of keys) {
      const result = await removeItem(key);
      if (!result.ok) failed.push(key);
    }
    legacyLocalRemove(LEGACY_WS_KEY);
    legacyLocalRemove(LEGACY_AI_KEYS_KEY);
    legacyLocalRemove(LEGACY_CORRUPT_KEY);
    sessionRemove(AI_KEYS_SESSION_KEY);
    sessionRemove(CORRUPT_SESSION_KEY);
    if (failed.length > 0) return fail(`Could not erase: ${failed.join(', ')}.`);
    return { success: true, msg: 'All local data erased.' };
  }

  /**
   * Whole workspace as a JSON backup: cases, audit trail and settings. Never contains password
   * hashes (there are no accounts) and never contains AI keys.
   */
  public exportWorkspace(): string {
    const file = {
      format: WORKSPACE_BACKUP_FORMAT,
      version: 1,
      exportedAt: new Date().toISOString(),
      workspace: JSON.parse(this.serialize()) as Rec,
    };
    return JSON.stringify(file, null, 2);
  }

  /**
   * Replaces the workspace with a backup made by exportWorkspace (a bare workspace object is also
   * accepted). AI keys held in this session are kept.
   */
  public importWorkspace(json: string): StoreResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return fail('File is not valid JSON.');
    }
    const body = isRecord(parsed) && parsed.format === WORKSPACE_BACKUP_FORMAT ? parsed.workspace : parsed;
    if (!isRecord(body) || !Array.isArray(body.cases)) {
      return fail('File does not contain a workspace backup.');
    }
    // The existing audit trail is kept as the record of this import. Backups from schema 1 also
    // carry `users` with password hashes; applyPersisted does not read them, so they are dropped.
    const existingLogs = this.data.logs;

    // applyPersisted never clears apiKey, so keys held in this session survive the import.
    this.applyPersisted(body);

    const seen = new Set<string>();
    const merged: AuditLog[] = [];
    for (const l of [...existingLogs, ...this.data.logs]) {
      const key = `${l.timestamp}|${l.username}|${l.action}|${l.details}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(l);
    }
    this.data.logs = merged.slice(0, MAX_LOGS);

    this.syncKeyFlags();
    this.persistKeys();
    this.logAction('WORKSPACE_IMPORT', `Imported workspace backup (${this.data.cases.length} cases)`);
    return { success: true, msg: `Imported ${this.data.cases.length} cases.` };
  }

  // ---- Audit --------------------------------------------------------------

  public logAction(action: string, details: string) {
    const entry: AuditLog = {
      id: newId(),
      timestamp: new Date().toISOString(),
      username: OPERATOR_NAME,
      action,
      details
    };
    this.data.logs.unshift(entry);
    this.data.logs.splice(MAX_LOGS);
    this.changed();
  }

  // ---- Operator clearance ---------------------------------------------------

  /**
   * The operator always holds TOP_SECRET. Clearance markings on objects still decide what is
   * exported, what the AI sends out and what is shown in path finding.
   */
  public getCurrentUserClearance(): ClearanceLevel {
    return OPERATOR_CLEARANCE;
  }

  // ---- Settings -----------------------------------------------------------

  public toggleTheme() {
    this.data.settings.theme = this.data.settings.theme === 'dark' ? 'light' : 'dark';
    this.changed();
  }

  public set_ai_key(provider: AIProvider, key: string) {
    if (!key.trim()) return;
    const s = this.data.settings.ai[provider];
    s.apiKey = key;
    s.key_stored = true;
    s.enabled = true;
    this.persistKeys();
    this.changed();
  }

  public clear_ai_keys() {
    for (const p of PROVIDERS) {
      const s = this.data.settings.ai[p];
      delete s.apiKey;
      s.key_stored = false;
      s.enabled = false;
    }
    this.persistKeys();
    this.changed();
  }

  // ---- Cases --------------------------------------------------------------

  private findCase(caseId: string): Case | undefined {
    return this.data.cases.find(c => c.id === caseId);
  }

  public getActiveCase(): Case | null {
    return this.findCase(this.data.active_case_id ?? '') ?? null;
  }

  public getCase(id: string): Case | undefined {
    return this.findCase(id);
  }

  public selectCase(id: string | null) {
    this.data.active_case_id = id;
    this.data.selected_object = null;
    this.changed();
  }

  public addCase(name: string, description: string, severity: SeverityLevel) {
    const newCase: Case = {
      id: newId(),
      name,
      description,
      severity_level: severity,
      ontology_types: [],
      action_types: [],
      entities: [],
      incidents: [],
      relationships: [],
      signals: [],
      created_at: new Date().toISOString()
    };
    this.data.cases.push(newCase);
    this.data.active_case_id = newCase.id;
    this.logAction('CREATE_CASE', `Created case: ${name}`);
  }

  public deleteCase(id: string) {
    this.data.cases = this.data.cases.filter(c => c.id !== id);
    if (this.data.active_case_id === id) {
      this.data.active_case_id = null;
    }
    this.logAction('DELETE_CASE', `Deleted case: ${id}`);
  }

  /** Export a case as JSON, containing only the items the current user may see. Returns '' if not found. */
  public exportCase(id: string): string {
    const c = this.findCase(id);
    if (!c) return '';
    const viewer = this.getCurrentUserClearance();
    const visible = (x: { clearance: ClearanceLevel }) => hasClearance(viewer, x.clearance);
    const entities = c.entities.filter(visible);
    const incidents = c.incidents.filter(visible);
    const visibleObjectIds = new Set([...entities, ...incidents].map((o) => o.id));
    const hiddenObjectIds = new Set(
      [...c.entities, ...c.incidents].filter((o) => !visible(o)).map((o) => o.id),
    );
    // A relationship is exported only if its own clearance allows it AND both endpoints are visible,
    // otherwise it would reveal a hidden object's id and rationale.
    const relationships = c.relationships.filter(
      (r) => visible(r) && visibleObjectIds.has(r.src) && visibleObjectIds.has(r.dst),
    );
    // Signals are dropped when the viewer cannot see their own clearance or the case object they
    // point at (source_id). Signals without a clearance are treated as UNCLASSIFIED.
    const signals = c.signals.filter(
      (s) => hasClearance(viewer, s.clearance ?? 'UNCLASSIFIED') && !hiddenObjectIds.has(s.source_id),
    );
    const payload = {
      format: 'palantir-case',
      schema_version: SCHEMA_VERSION,
      exported_at: new Date().toISOString(),
      case: {
        ...c,
        entities,
        incidents,
        relationships,
        signals,
      }
    };
    this.logAction('CASE_EXPORT', `Exported case: ${c.name}`);
    return JSON.stringify(payload, null, 2);
  }

  /**
   * The case's entities and incidents as two CSV tables, limited to what the viewer may see.
   * Both are empty strings if the case does not exist.
   */
  public exportCasesCsv(caseId: string): { entities: string; incidents: string } {
    const c = this.findCase(caseId);
    if (!c) return { entities: '', incidents: '' };
    const viewer = this.getCurrentUserClearance();
    const visible = (x: { clearance: ClearanceLevel }) => hasClearance(viewer, x.clearance);
    const entityRows = c.entities
      .filter(visible)
      .map((e) => [e.id, e.type, e.name, e.clearance, e.created_at, JSON.stringify(e.properties)]);
    const incidentRows = c.incidents
      .filter(visible)
      .map((i) => [i.id, i.title, i.description, i.lat, i.lon, i.date, i.clock, i.severity, i.clearance, i.created_at]);
    this.logAction('CASE_EXPORT', `Exported CSV of case: ${c.name}`);
    return {
      entities: csvText(['id', 'type', 'name', 'clearance', 'created_at', 'properties'], entityRows),
      incidents: csvText(
        ['id', 'title', 'description', 'lat', 'lon', 'date', 'clock', 'severity', 'clearance', 'created_at'],
        incidentRows,
      ),
    };
  }

  /** Import a case JSON produced by exportCase. Always assigns a fresh id to avoid collisions. */
  public importCase(json: string): StoreResult {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return fail('File is not valid JSON.');
    }
    const raw = isRecord(parsed) && isRecord(parsed.case) ? parsed.case : parsed;
    if (!isRecord(raw) || typeof raw.name !== 'string') {
      return fail('File does not contain a case.');
    }
    const c = normalizeCase(raw, newId());
    this.data.cases.push(c);
    this.logAction('CASE_IMPORT', `Imported case: ${c.name}`);
    return { success: true, msg: `Imported case "${c.name}".` };
  }

  // ---- Objects ------------------------------------------------------------

  public selectObject(type: string, id: string | null) {
    // Selection is UI state: notify listeners, do not persist.
    this.data.selected_object = id ? { type, id } : null;
    this.notify();
  }

  public deleteObject(caseId: string, type: string, id: string) {
    const ac = this.findCase(caseId);
    if (!ac) return;
    if (type === 'entity') {
      ac.entities = ac.entities.filter(e => e.id !== id);
    } else if (type === 'incident') {
      ac.incidents = ac.incidents.filter(i => i.id !== id);
    } else if (type === 'relationship') {
      ac.relationships = ac.relationships.filter(r => r.id !== id);
    }
    // Clean orphaned links
    if (type === 'entity' || type === 'incident') {
      ac.relationships = ac.relationships.filter(r => r.src !== id && r.dst !== id);
    }
    this.logAction('DELETE_OBJECT', `Deleted ${type} ${id} from case ${caseId}`);
  }

  public addEntity(caseId: string, name: string, type: string, clearance: ClearanceLevel, properties: Record<string, string>) {
    const ac = this.findCase(caseId);
    if (!ac) return;
    ac.entities.push({
      id: newId(),
      type,
      name,
      properties,
      clearance,
      created_at: new Date().toISOString()
    });
    this.changed();
  }

  public addIncident(caseId: string, title: string, description: string, lat: string, lon: string, date: string, clock: string, severity: SeverityLevel, clearance: ClearanceLevel) {
    const ac = this.findCase(caseId);
    if (!ac) return;
    ac.incidents.push({
      id: newId(),
      title,
      description,
      lat,
      lon,
      date,
      clock,
      severity,
      clearance,
      created_at: new Date().toISOString()
    });
    this.changed();
  }

  public addRelationship(caseId: string, type: string, src: string, dst: string, confidence: number, rationale: string, clearance: ClearanceLevel) {
    const ac = this.findCase(caseId);
    if (!ac) return;
    ac.relationships.push({
      id: newId(),
      type,
      src,
      dst,
      confidence,
      rationale,
      clearance,
      created_at: new Date().toISOString()
    });
    this.changed();
  }

  public updateIncidentPosition(caseId: string, id: string, x: number, y: number) {
    const c = this.findCase(caseId);
    if (!c) return;
    const i = c.incidents.find(inc => inc.id === id);
    if (i) {
      i.flow_x = x;
      i.flow_y = y;
      this.changed();
    }
  }

  public findShortestPath(sourceId: string, targetId: string): string[] {
    const ac = this.getActiveCase();
    if (!ac) return [];

    // Only the viewer's own graph: hidden nodes and the links touching them are not used, so a
    // path can never reveal an object the viewer cannot see.
    const viewer = this.getCurrentUserClearance();
    const visible = (x: { clearance: ClearanceLevel }) => hasClearance(viewer, x.clearance);
    const graph: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
    const nodes: Array<Entity | Incident> = [...ac.entities, ...ac.incidents].filter(visible);
    nodes.forEach(n => { graph[n.id] = []; });
    if (!(sourceId in graph) || !(targetId in graph)) return [];
    ac.relationships.filter(visible).forEach(r => {
      const out = graph[r.src];
      const back = graph[r.dst];
      if (out && back) {
        out.push(r.dst);
        back.push(r.src);
      }
    });

    const queue: { id: string, path: string[] }[] = [{ id: sourceId, path: [sourceId] }];
    const visited = new Set<string>([sourceId]);

    while (queue.length > 0) {
      const { id, path } = queue.shift()!;
      if (id === targetId) return path;

      for (const n of graph[id] || []) {
        if (!visited.has(n)) {
          visited.add(n);
          queue.push({ id: n, path: [...path, n] });
        }
      }
    }
    return [];
  }

  // ---- Ontology -----------------------------------------------------------

  public addOntologyType(caseId: string, name: string, icon: string, color: string) {
    const ac = this.findCase(caseId);
    if (!ac) return;
    const id = name.trim().replace(/\s+/g, '_').toLowerCase();
    if (!ac.ontology_types) ac.ontology_types = [];
    ac.ontology_types.push({
      id, name, icon, color, properties: [], created_at: new Date().toISOString()
    });
    this.changed();
  }

  /**
   * Removes the type definition only. Entities keep their type string (they just lose schema context),
   * matching the confirmation text in the UI.
   */
  public deleteOntologyType(caseId: string, typeId: string) {
    const ac = this.findCase(caseId);
    if (!ac) return;
    ac.ontology_types = (ac.ontology_types ?? []).filter(t => t.id !== typeId);
    this.changed();
  }

  public addOntologyProperty(caseId: string, typeId: string, name: string, type: PropertyType) {
    const ac = this.findCase(caseId);
    const t = ac?.ontology_types?.find(t => t.id === typeId);
    if (t) {
      t.properties.push({ id: newId(), name, type });
      this.changed();
    }
  }

  /**
   * Inserts one entity per item. Name comes from item.name / title / id, else a numbered fallback.
   * Non-string property values are stringified.
   */
  public bulkAddEntities(caseId: string, typeId: string, items: Rec[], clearance: ClearanceLevel = 'UNCLASSIFIED'): BulkAddResult {
    const ac = this.findCase(caseId);
    if (!ac) return { added: 0, error: 'No such case.' };
    const t = (ac.ontology_types ?? []).find(x => x.id === typeId);
    if (!t) return { added: 0, error: 'Ontology type not found in this case.' };
    if (items.length === 0) return { added: 0, error: 'No rows to ingest.' };

    const created_at = new Date().toISOString();
    const level = asClearance(clearance);
    items.forEach((item, idx) => {
      ac.entities.push({
        id: newId(),
        type: typeId,
        name: pickName(item) ?? `${t.name}_${idx + 1}`,
        properties: Object.fromEntries(Object.entries(item).map(([k, v]) => [k, toPropString(v)])),
        clearance: level,
        created_at
      });
    });
    this.changed();
    return { added: items.length };
  }

  public addActionType(caseId: string, target_ontology_id: string, name: string, description: string) {
    const ac = this.findCase(caseId);
    if (!ac) return;
    if (!ac.action_types) ac.action_types = [];
    ac.action_types.push({
      id: newId(),
      name,
      description,
      target_ontology_id,
      parameters: [],
      created_at: new Date().toISOString()
    });
    this.changed();
  }

  public executeAction(caseId: string, actionId: string, entityId: string) {
    const ac = this.findCase(caseId);
    if (!ac) return;
    const action = ac.action_types?.find(a => a.id === actionId);
    const entity = ac.entities.find(e => e.id === entityId);
    if (action && entity) {
      this.logAction('ACTION_EXECUTED', `Action '${action.name}' executed on ${entity.type} ${entity.name} (${entity.id})`);
    }
  }

  // ---- Signals ------------------------------------------------------------

  public updateSignalStatus(caseId: string, id: string, status: SignalStatus) {
    const sig = this.findCase(caseId)?.signals?.find(s => s.id === id);
    if (sig) {
      sig.status = status;
      this.changed();
    }
  }

  /**
   * Adds a feed-derived signal (status NEW). Returns false if the case is missing or a signal
   * with the same source_id already exists. At the cap, the oldest DISMISSED signal is evicted
   * first; if none is dismissed, the oldest signal is evicted. Not audit-logged per signal
   * (that would flood the 150-entry log); runWatchRules logs one summary per run.
   */
  public addSignal(caseId: string, input: SignalInput): boolean {
    const ac = this.findCase(caseId);
    if (!ac) return false;
    if (ac.signals.some(s => s.source_id === input.source_id)) return false;
    if (ac.signals.length >= MAX_SIGNALS) {
      const dismissed = ac.signals.findIndex(s => s.status === 'DISMISSED');
      ac.signals.splice(dismissed >= 0 ? dismissed : 0, 1);
    }
    ac.signals.push({
      id: newId(),
      source_id: input.source_id.slice(0, 80),
      title: input.title.slice(0, SIGNAL_TITLE_MAX),
      description: input.description.slice(0, SIGNAL_TEXT_MAX),
      severity: asSeverity(input.severity),
      status: 'NEW',
      ai_assessment: input.ai_assessment.slice(0, SIGNAL_TEXT_MAX),
      clearance: asClearance(input.clearance),
      created_at: new Date().toISOString(),
    });
    this.changed();
    return true;
  }

  // ---- Watch rules --------------------------------------------------------

  public addWatchRule(caseId: string, input: WatchRuleInput): StoreResult {
    const ac = this.findCase(caseId);
    if (!ac) return fail('No such case.');
    const rules = ac.watch_rules ?? [];
    if (rules.length >= MAX_WATCH_RULES) return fail(`A case can have at most ${MAX_WATCH_RULES} watch rules.`);
    const rule = sanitizeRule({ ...input, id: newId(), enabled: input.enabled ?? true });
    if (!rule) return fail('Unknown feed layer.');
    ac.watch_rules = [...rules, rule];
    this.logAction('WATCH_RULE_ADD', `Added ${rule.layer} watch rule to case "${ac.name}"`);
    return { success: true, msg: '' };
  }

  public removeWatchRule(caseId: string, ruleId: string): StoreResult {
    const ac = this.findCase(caseId);
    if (!ac?.watch_rules?.some(r => r.id === ruleId)) return fail('Watch rule not found.');
    ac.watch_rules = ac.watch_rules.filter(r => r.id !== ruleId);
    this.logAction('WATCH_RULE_REMOVE', `Removed watch rule from case "${ac.name}"`);
    return { success: true, msg: '' };
  }

  public toggleWatchRule(caseId: string, ruleId: string): StoreResult {
    const ac = this.findCase(caseId);
    const rule = ac?.watch_rules?.find(r => r.id === ruleId);
    if (!ac || !rule) return fail('Watch rule not found.');
    rule.enabled = !rule.enabled;
    this.logAction('WATCH_RULE_TOGGLE', `${rule.enabled ? 'Enabled' : 'Disabled'} ${rule.layer} watch rule in case "${ac.name}"`);
    return { success: true, msg: '' };
  }
}

/**
 * One-time move of AI keys out of localStorage into sessionStorage. Existing session keys win.
 * localStorage is cleared only after the keys are safely in sessionStorage.
 */
function migrateLegacyAIKeys(): void {
  const legacy = legacyLocalGet(LEGACY_AI_KEYS_KEY);
  if (legacy === null) return;
  let incoming: Rec = {};
  try {
    const parsed: unknown = JSON.parse(legacy);
    if (isRecord(parsed)) incoming = parsed;
  } catch {
    console.warn('[store] discarding unreadable legacy AI keys');
  }
  let current: Rec = {};
  try {
    const parsed: unknown = JSON.parse(sessionGet(AI_KEYS_SESSION_KEY) ?? 'null');
    if (isRecord(parsed)) current = parsed;
  } catch {
    current = {};
  }
  const merged = { ...incoming, ...current };
  if (Object.keys(merged).length === 0 || sessionSet(AI_KEYS_SESSION_KEY, JSON.stringify(merged))) {
    legacyLocalRemove(LEGACY_AI_KEYS_KEY);
  }
}

export const store = new Store();

/** Loads stored data. Await once at startup (main.tsx) before rendering. Safe to call repeatedly. */
export function initStore(): Promise<void> {
  return store.init();
}
