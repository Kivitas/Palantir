// @vitest-environment node
// Node environment: the store persists through cookieStorage, which needs document.cookie and
// Blob/CompressionStream. Both are provided by the fake browser helper and Node's globals.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  drainCookieQueue,
  installFakeBrowser,
  randomText,
  waitFor,
  type FakeBrowser,
} from './helpers/fakeBrowser';
import type { ClearanceLevel } from '../src/types';

type StoreModule = typeof import('../src/store');
type CookieModule = typeof import('../src/utils/cookieStorage');

let browser: FakeBrowser;
let mod: StoreModule;
let cs: CookieModule;
let store: StoreModule['store'];

/** Fresh module graph (empty caches and singleton store), same fake browser. */
async function boot(): Promise<void> {
  vi.resetModules();
  mod = await import('../src/store');
  cs = await import('../src/utils/cookieStorage');
  store = mod.store;
  await mod.initStore();
}

/** Flushes the debounced workspace write and waits until it has reached the cookie jar. */
async function persist(): Promise<void> {
  store.flushNow();
  await drainCookieQueue(cs);
}

/** Simulates a page reload: persist, then fresh modules over the same cookies and sessionStorage. */
async function reload(): Promise<void> {
  await persist();
  await boot();
}

function expectOk(result: { success: boolean; msg: string }): void {
  expect(result).toEqual({ success: true, msg: expect.any(String) });
}

function activeCaseId(): string {
  const c = store.getActiveCase();
  if (!c) throw new Error('no active case');
  return c.id;
}

beforeEach(async () => {
  browser = installFakeBrowser();
  await boot();
});

afterEach(async () => {
  // Clear debounced timers from this test so they cannot write into a later test's jar.
  if (store) {
    store.flushNow();
    await cs.flushCookieWrites();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe('init and the built-in admin account', () => {
  it('creates the admin account as TOP_SECRET on first run', () => {
    expect(store.ready).toBe(true);
    expect(Object.keys(store.data.users)).toEqual(['admin']);
    expect(store.data.users.admin?.clearance).toBe('TOP_SECRET');
  });

  it('logs in as admin/admin', () => {
    expectOk(store.login('admin', 'admin'));
    expect(store.data.current_user).toBe('admin');
    expect(store.getCurrentUserClearance()).toBe('TOP_SECRET');
  });

  it('rejects a wrong password and an unknown user with the same message', () => {
    expect(store.login('admin', 'wrong')).toEqual({ success: false, msg: 'Invalid credentials' });
    expect(store.login('ghost', 'admin')).toEqual({ success: false, msg: 'Invalid credentials' });
  });

  it('is idempotent: repeated init returns the same promise and does not recreate admin', async () => {
    expect(store.init()).toBe(store.init());
    await store.init();
    expect(Object.keys(store.data.users)).toEqual(['admin']);
  });

  it('keeps the admin account across a reload', async () => {
    await reload();
    expectOk(store.login('admin', 'admin'));
  });

  it('upgrades a legacy double-hashed password on login', () => {
    store.signup('alice', 'legacypass');
    const user = store.data.users.alice;
    if (!user) throw new Error('alice missing');
    user.passwordHash = mod.mockHash(mod.mockHash('legacypass'));

    expectOk(store.login('alice', 'legacypass'));
    expect(user.passwordHash).toBe(mod.mockHash('legacypass'));
  });
});

describe('signup', () => {
  it('creates UNCLASSIFIED accounts with a timestamp', () => {
    expectOk(store.signup('alice', 'longpassword'));
    expect(store.data.users.alice).toMatchObject({ username: 'alice', clearance: 'UNCLASSIFIED' });
    expect(typeof store.data.users.alice?.created_at).toBe('string');
  });

  it('requires a password of at least 8 characters', () => {
    const short = store.signup('bob', '1234567');
    expect(short.success).toBe(false);
    expect(short.msg).toContain('8');
    expect(store.data.users.bob).toBeUndefined();

    expectOk(store.signup('bob', '12345678'));
  });

  it('rejects usernames with disallowed characters or lengths', () => {
    for (const name of ['bad name', 'semi;colon', 'slash/name', 'a'.repeat(65)]) {
      expect(store.signup(name, 'longpassword').success).toBe(false);
    }
    expectOk(store.signup('a'.repeat(64), 'longpassword'));
  });

  it('rejects an existing username, including the built-in admin', () => {
    expect(store.signup('admin', 'longpassword')).toEqual({ success: false, msg: 'Username already exists' });
  });

  it('stores a hash, never the plain password', () => {
    store.signup('alice', 'longpassword');
    expect(store.data.users.alice?.passwordHash).toBe(mod.mockHash('longpassword'));
    expect(JSON.stringify(store.data.users)).not.toContain('longpassword');
  });

  it('rejects reserved names that would hit inherited object members', () => {
    for (const name of ['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString']) {
      expect(store.signup(name, 'longpassword')).toEqual({
        success: false,
        msg: 'That username is reserved. Choose another.',
      });
      expect(store.login(name, 'longpassword').success).toBe(false);
    }
    expect(Object.keys(store.data.users)).toEqual(['admin']);
  });

  it('drops reserved names found in stored or imported data', async () => {
    const backup = JSON.parse(store.exportWorkspace());
    backup.workspace.users = {
      ...backup.workspace.users,
      ['__proto__']: { passwordHash: 'x', clearance: 'TOP_SECRET', created_at: '2024-01-01' },
      constructor: { passwordHash: 'x', clearance: 'TOP_SECRET', created_at: '2024-01-01' },
    };
    expect(store.importWorkspace(JSON.stringify(backup)).success).toBe(true);
    expect(Object.keys(store.data.users).sort()).toEqual(['admin']);
    expect(Object.hasOwn(store.data.users, 'constructor')).toBe(false);
    expect(Object.getPrototypeOf(store.data.users)).toBeNull();
  });
});

describe('setUserClearance gating', () => {
  beforeEach(() => {
    store.signup('alice', 'longpassword');
    store.signup('bob', 'longpassword');
  });

  it('refuses changes from a non-TOP_SECRET user and from nobody', () => {
    store.login('alice', 'longpassword');
    expect(store.setUserClearance('bob', 'SECRET')).toEqual({
      success: false,
      msg: 'Only TOP_SECRET users can change clearance levels.',
    });
    store.logout();
    expect(store.setUserClearance('bob', 'SECRET').success).toBe(false);
    expect(store.data.users.bob?.clearance).toBe('UNCLASSIFIED');
  });

  it('lets a TOP_SECRET user change clearance and audits the change', () => {
    store.login('admin', 'admin');
    expectOk(store.setUserClearance('alice', 'SECRET'));
    expect(store.data.users.alice?.clearance).toBe('SECRET');
    expect(store.data.logs[0]).toMatchObject({ action: 'CLEARANCE_CHANGE', username: 'admin' });
    expect(store.data.logs[0]?.details).toContain('UNCLASSIFIED -> SECRET');
  });

  it('rejects unknown levels and unknown target users', () => {
    store.login('admin', 'admin');
    expect(store.setUserClearance('alice', 'COSMIC' as ClearanceLevel)).toEqual({
      success: false,
      msg: 'Unknown clearance level.',
    });
    expect(store.setUserClearance('ghost', 'SECRET')).toEqual({ success: false, msg: 'User not found.' });
  });

  it('cannot demote the last TOP_SECRET user, but can once there are two', () => {
    store.login('admin', 'admin');
    expect(store.setUserClearance('admin', 'SECRET')).toEqual({
      success: false,
      msg: 'Cannot demote the last TOP_SECRET user.',
    });

    expectOk(store.setUserClearance('alice', 'TOP_SECRET'));
    expectOk(store.setUserClearance('admin', 'SECRET'));
    expect(store.data.users.admin?.clearance).toBe('SECRET');
  });
});

describe('bulkAddEntities', () => {
  let caseId: string;

  beforeEach(() => {
    store.login('admin', 'admin');
    store.addCase('Case A', '', 'LOW');
    caseId = activeCaseId();
    store.addOntologyType(caseId, 'Person', 'user', '#ffffff');
  });

  it('returns the number added and creates one entity per item with names and stringified properties', () => {
    const result = store.bulkAddEntities(caseId, 'person', [
      { name: 'Ann', age: 33 },
      { title: 'Ben' },
      { id: 7 },
      { x: 1, nested: { a: 1 }, empty: null },
    ]);
    expect(result).toEqual({ added: 4 });

    const entities = store.getActiveCase()?.entities ?? [];
    expect(entities.map((e) => e.name)).toEqual(['Ann', 'Ben', '7', 'Person_4']);
    expect(entities[0]?.properties).toEqual({ name: 'Ann', age: '33' });
    expect(entities[3]?.properties).toEqual({ x: '1', nested: '{"a":1}', empty: '' });
    expect(entities.every((e) => e.type === 'person')).toBe(true);
  });

  it('reports an error and adds nothing when the case, type or rows are missing', () => {
    expect(store.bulkAddEntities('nope', 'person', [{}])).toEqual({ added: 0, error: 'No such case.' });
    expect(store.bulkAddEntities(caseId, 'ghost', [{}])).toEqual({
      added: 0,
      error: 'Ontology type not found in this case.',
    });
    expect(store.bulkAddEntities(caseId, 'person', [])).toEqual({ added: 0, error: 'No rows to ingest.' });
    expect(store.getActiveCase()?.entities).toHaveLength(0);
  });

  it('defaults to UNCLASSIFIED and coerces an invalid clearance to UNCLASSIFIED', () => {
    store.bulkAddEntities(caseId, 'person', [{ name: 'A' }]);
    store.bulkAddEntities(caseId, 'person', [{ name: 'B' }], 'BOGUS' as ClearanceLevel);
    expect(store.getActiveCase()?.entities.map((e) => e.clearance)).toEqual(['UNCLASSIFIED', 'UNCLASSIFIED']);
  });
});

describe('ontology types', () => {
  it('deleting an ontology type keeps its entities', () => {
    store.login('admin', 'admin');
    store.addCase('Case B', '', 'LOW');
    const caseId = activeCaseId();
    store.addOntologyType(caseId, 'Person', 'user', '#ffffff');
    store.bulkAddEntities(caseId, 'person', [{ name: 'One' }, { name: 'Two' }]);

    store.deleteOntologyType(caseId, 'person');

    const c = store.getActiveCase();
    expect(c?.ontology_types).toHaveLength(0);
    expect(c?.entities.map((e) => [e.name, e.type])).toEqual([
      ['One', 'person'],
      ['Two', 'person'],
    ]);
  });
});

describe('findShortestPath', () => {
  let ids: Record<'a' | 'b' | 'c' | 'd' | 'e', string>;
  let caseId: string;

  beforeEach(() => {
    store.login('admin', 'admin');
    store.addCase('Graph', '', 'LOW');
    caseId = activeCaseId();
    for (const name of ['a', 'b', 'c', 'd', 'e']) store.addEntity(caseId, name, 'Node', 'UNCLASSIFIED', {});
    const byName = Object.fromEntries((store.getActiveCase()?.entities ?? []).map((e) => [e.name, e.id]));
    ids = byName as typeof ids;
    // chain a - b - c - d; e is isolated
    store.addRelationship(caseId, 'LINKS_TO', ids.a, ids.b, 1, '', 'UNCLASSIFIED');
    store.addRelationship(caseId, 'LINKS_TO', ids.b, ids.c, 1, '', 'UNCLASSIFIED');
    store.addRelationship(caseId, 'LINKS_TO', ids.c, ids.d, 1, '', 'UNCLASSIFIED');
  });

  it('returns the chain of node ids along the only route', () => {
    expect(store.findShortestPath(ids.a, ids.d)).toEqual([ids.a, ids.b, ids.c, ids.d]);
  });

  it('prefers a shorter route when one exists', () => {
    store.addRelationship(caseId, 'LINKS_TO', ids.a, ids.d, 1, '', 'UNCLASSIFIED');
    expect(store.findShortestPath(ids.a, ids.d)).toEqual([ids.a, ids.d]);
  });

  it('follows relationships in either direction', () => {
    expect(store.findShortestPath(ids.d, ids.a)).toEqual([ids.d, ids.c, ids.b, ids.a]);
  });

  it('returns an empty array when no route exists', () => {
    expect(store.findShortestPath(ids.a, ids.e)).toEqual([]);
  });

  it('returns just the source when source and target are the same node', () => {
    expect(store.findShortestPath(ids.b, ids.b)).toEqual([ids.b]);
  });

  it('returns an empty array when there is no active case', () => {
    store.selectCase(null);
    expect(store.findShortestPath(ids.a, ids.d)).toEqual([]);
  });
});

describe('case export and import', () => {
  beforeEach(() => {
    store.login('admin', 'admin');
  });

  it('exports in the palantir-case format and imports a copy with a fresh id', () => {
    store.addCase('Alpha', 'desc', 'HIGH');
    const originalId = activeCaseId();
    store.addEntity(originalId, 'Subject', 'Person', 'UNCLASSIFIED', { role: 'lead' });

    const json = store.exportCase(originalId);
    const parsed = JSON.parse(json);
    expect(parsed.format).toBe('palantir-case');
    expect(parsed.case.name).toBe('Alpha');

    expect(store.importCase(json)).toEqual({ success: true, msg: 'Imported case "Alpha".' });
    const cases = store.data.cases;
    expect(cases).toHaveLength(2);
    const copy = cases[1];
    expect(copy?.id).not.toBe(originalId);
    expect(copy?.entities.map((e) => e.name)).toEqual(['Subject']);
  });

  it('imports a bare case object as well as a wrapped export', () => {
    expect(store.importCase(JSON.stringify({ name: 'Bare', entities: [] })).success).toBe(true);
    expect(store.data.cases.at(-1)?.name).toBe('Bare');
  });

  it('rejects input that is not a case', () => {
    expect(store.importCase('nope')).toEqual({ success: false, msg: 'File is not valid JSON.' });
    expect(store.importCase('{"foo":1}')).toEqual({ success: false, msg: 'File does not contain a case.' });
  });

  it('returns an empty string when exporting an unknown case', () => {
    expect(store.exportCase('missing')).toBe('');
  });

  it('exports only the entities, incidents and relationships the viewer may see', () => {
    store.addCase('Classified', '', 'HIGH');
    const caseId = activeCaseId();
    store.addEntity(caseId, 'pub', 'Node', 'UNCLASSIFIED', {});
    store.addEntity(caseId, 'sec', 'Node', 'SECRET', {});
    const ents = store.getActiveCase()?.entities ?? [];
    const pub = ents.find((e) => e.name === 'pub')!;
    const sec = ents.find((e) => e.name === 'sec')!;
    store.addIncident(caseId, 'pubInc', '', '1', '2', '2024-01-01', '00:00', 'LOW', 'UNCLASSIFIED');
    store.addIncident(caseId, 'secInc', '', '1', '2', '2024-01-01', '00:00', 'LOW', 'TOP_SECRET');
    const pubInc = store.getActiveCase()?.incidents.find((i) => i.title === 'pubInc')!;
    store.addRelationship(caseId, 'LINKS_TO', pub.id, pub.id, 1, 'public', 'UNCLASSIFIED');
    store.addRelationship(caseId, 'LINKS_TO', pub.id, sec.id, 1, 'secret', 'SECRET');

    store.signup('alice', 'longpassword');
    store.logout();
    store.login('alice', 'longpassword');
    const viewed = JSON.parse(store.exportCase(caseId)).case;
    expect(viewed.entities.map((e: { name: string }) => e.name)).toEqual(['pub']);
    expect(viewed.incidents.map((i: { title: string }) => i.title)).toEqual(['pubInc']);
    expect(viewed.relationships.map((r: { rationale: string }) => r.rationale)).toEqual(['public']);
    expect(pubInc).toBeDefined();

    store.logout();
    store.login('admin', 'admin');
    const full = JSON.parse(store.exportCase(caseId)).case;
    expect(full.entities).toHaveLength(2);
    expect(full.incidents).toHaveLength(2);
    expect(full.relationships).toHaveLength(2);
  });

  it('does not export a relationship whose endpoint the viewer cannot see', () => {
    store.addCase('Leak', '', 'HIGH');
    const caseId = activeCaseId();
    store.addEntity(caseId, 'pub', 'Node', 'UNCLASSIFIED', {});
    store.addEntity(caseId, 'sec', 'Node', 'SECRET', {});
    const ents = store.getActiveCase()?.entities ?? [];
    const pub = ents.find((e) => e.name === 'pub')!;
    const sec = ents.find((e) => e.name === 'sec')!;
    store.addRelationship(caseId, 'LINKS_TO', pub.id, sec.id, 1, 'secret rationale', 'UNCLASSIFIED');

    store.signup('alice', 'longpassword');
    store.logout();
    store.login('alice', 'longpassword');
    const viewed = JSON.parse(store.exportCase(caseId)).case;
    const visibleIds = new Set(viewed.entities.map((e: { id: string }) => e.id));
    for (const r of viewed.relationships as Array<{ src: string; dst: string }>) {
      expect(visibleIds.has(r.dst)).toBe(true);
    }
  });

  it('gives imported items with a missing or invalid clearance a fail-closed TOP_SECRET level', () => {
    const payload = {
      name: 'Imported',
      entities: [
        { id: 'e1', type: 'Person', name: 'NoClass', properties: {}, created_at: '2024-01-01' },
        { id: 'e2', type: 'Person', name: 'Bogus', clearance: 'COSMIC', properties: {}, created_at: '2024-01-01' },
      ],
      incidents: [{ id: 'i1', title: 'NoClassInc' }],
      relationships: [{ id: 'r1', src: 'e1', dst: 'e2', rationale: 'x', clearance: 'bogus' }],
    };
    store.importCase(JSON.stringify(payload));
    const imported = store.data.cases.at(-1)!;
    expect(imported.entities.map((e) => e.clearance)).toEqual(['TOP_SECRET', 'TOP_SECRET']);
    expect(imported.incidents.map((i) => i.clearance)).toEqual(['TOP_SECRET']);
    expect(imported.relationships.map((r) => r.clearance)).toEqual(['TOP_SECRET']);

    // Hidden from a lower-cleared viewer, but still visible to TOP_SECRET.
    store.signup('alice', 'longpassword');
    store.logout();
    store.login('alice', 'longpassword');
    expect(JSON.parse(store.exportCase(imported.id)).case.entities).toHaveLength(0);
    store.logout();
    store.login('admin', 'admin');
    expect(JSON.parse(store.exportCase(imported.id)).case.entities.map((e: { name: string }) => e.name))
      .toEqual(['NoClass', 'Bogus']);
  });

  it('hides signals that point at objects the viewer cannot see', () => {
    store.addCase('Sig', '', 'LOW');
    const caseId = activeCaseId();
    store.addEntity(caseId, 'secret-obj', 'Node', 'SECRET', {});
    const secretId = store.getActiveCase()!.entities[0]!.id;
    store.addSignal(caseId, { source_id: secretId, title: 'hits secret', description: '', severity: 'LOW', ai_assessment: '' });
    store.addSignal(caseId, { source_id: 'feed:open', title: 'open', description: '', severity: 'LOW', ai_assessment: '' });

    store.signup('alice', 'longpassword');
    store.logout();
    store.login('alice', 'longpassword');
    const viewed = JSON.parse(store.exportCase(caseId)).case;
    expect(viewed.signals.map((s: { title: string }) => s.title)).toEqual(['open']);
  });
});

describe('signal cap', () => {
  it('keeps at most 25 signals per case and evicts the oldest dismissed one first', () => {
    store.login('admin', 'admin');
    store.addCase('Cap', '', 'LOW');
    const caseId = activeCaseId();
    const add = (i: number) =>
      store.addSignal(caseId, { source_id: `feed:${i}`, title: `t${i}`, description: '', severity: 'LOW', ai_assessment: '' });
    for (let i = 0; i < 25; i++) add(i);
    store.updateSignalStatus(caseId, store.getActiveCase()!.signals[5]!.id, 'DISMISSED');
    add(100);

    const signals = store.getActiveCase()!.signals;
    expect(signals).toHaveLength(25);
    expect(signals.some((s) => s.source_id === 'feed:5')).toBe(false);
    expect(signals.some((s) => s.source_id === 'feed:100')).toBe(true);
  });
});

describe('importWorkspace merges the audit trail and keeps the session', () => {
  it('keeps current logs, appends the import entry, and stays logged in as the same user', () => {
    store.signup('alice', 'longpassword');
    store.login('admin', 'admin');
    const backup = store.exportWorkspace();
    store.logAction('LOCAL_ONLY', 'happened after backup');
    const before = store.data.logs.length;

    store.importWorkspace(backup);

    expect(store.data.current_user).toBe('admin');
    expect(store.data.logs[0]).toMatchObject({ action: 'WORKSPACE_IMPORT', username: 'admin' });
    expect(store.data.logs.some((l) => l.action === 'LOCAL_ONLY')).toBe(true);
    expect(store.data.logs.length).toBeGreaterThanOrEqual(before);
  });

  it('does not log in a user from the backup when nobody is logged in', () => {
    store.login('admin', 'admin');
    const backup = store.exportWorkspace();
    store.logout();

    store.importWorkspace(backup);
    expect(store.data.current_user).toBeNull();
  });

  it('logs the session out if the current user is absent from the backup', () => {
    store.signup('carol', 'longpassword');
    store.login('carol', 'longpassword');
    const backup = JSON.parse(store.exportWorkspace());
    delete backup.workspace.users.carol;

    store.importWorkspace(JSON.stringify(backup));
    expect(store.data.current_user).toBeNull();
    expect(store.data.current_user_id).toBeNull();
  });
});

describe('AI defaults', () => {
  it('uses the current default model for each provider', () => {
    expect(store.data.settings.ai.openai.model).toBe('gpt-5');
    expect(store.data.settings.ai.gemini.model).toBe('gemini-2.5-flash');
    expect(store.data.settings.ai.anthropic.model).toBe('claude-sonnet-5-5');
    expect(store.data.settings.ai.mistral.model).toBe('mistral-large-latest');
  });
});

describe('workspace backup', () => {
  it('round-trips cases and users through exportWorkspace and importWorkspace', () => {
    store.login('admin', 'admin');
    store.addCase('W', '', 'LOW');
    store.signup('alice', 'longpassword');
    const backup = store.exportWorkspace();
    expect(JSON.parse(backup)).toMatchObject({ format: 'aegis-workspace-backup', version: 1 });

    store.deleteCase(activeCaseId());
    expect(store.data.cases).toHaveLength(0);

    const result = store.importWorkspace(backup);
    expect(result).toEqual({ success: true, msg: 'Imported 1 cases.' });
    expect(store.data.cases.map((c) => c.name)).toEqual(['W']);
    expect(Object.keys(store.data.users).sort()).toEqual(['admin', 'alice']);
  });

  it('rejects malformed input and leaves the data unchanged', () => {
    store.login('admin', 'admin');
    store.addCase('Keep', '', 'LOW');
    expect(store.importWorkspace('{')).toEqual({ success: false, msg: 'File is not valid JSON.' });
    expect(store.importWorkspace('{"x":1}')).toEqual({
      success: false,
      msg: 'File does not contain a workspace backup.',
    });
    expect(store.data.cases.map((c) => c.name)).toEqual(['Keep']);
  });

  it('keeps AI keys out of the backup, the cookie jar and the cookie-backed workspace', async () => {
    store.set_ai_key('openai', 'sk-test-abc123');
    expect(store.exportWorkspace()).not.toContain('sk-test-abc123');

    await persist();
    for (const value of browser.jar.values()) expect(value).not.toContain('sk-test-abc123');
    expect(browser.sessionStore.get('aegis_ai_keys')).toContain('sk-test-abc123');

    await reload();
    expect(store.data.settings.ai.openai.apiKey).toBe('sk-test-abc123');
    expect(store.data.settings.ai.openai.key_stored).toBe(true);
  });
});

describe('persistence', () => {
  it('cases, users and settings survive a reload', async () => {
    store.login('admin', 'admin');
    store.addCase('Persisted', '', 'MEDIUM');
    store.signup('alice', 'longpassword');
    store.toggleTheme();

    await reload();

    expect(store.data.cases.map((c) => c.name)).toEqual(['Persisted']);
    expect(store.data.settings.theme).toBe('dark');
    expectOk(store.login('alice', 'longpassword'));
  });

  it('keeps an unreadable workspace copy in sessionStorage and starts with defaults', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await persist();
    await cs.setItem('aegis_ws', '{not json');

    await boot();

    expect(browser.sessionStore.get('aegis_ws_corrupt')).toBe('{not json');
    expect(Object.keys(store.data.users)).toEqual(['admin']);
  });

  it('when storage is full, evicts old audit entries and saves the workspace', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.login('admin', 'admin');
    store.addCase('Big', '', 'LOW');
    for (let i = 0; i < 150; i++) store.logAction('BULK', randomText(300, i + 1));
    expect(store.data.logs).toHaveLength(150);

    await persist();
    await waitFor(() => store.data.logs.length === 20);
    await drainCookieQueue(cs);

    expect(store.lastError).toBeNull();
    await reload();
    expect(store.data.logs).toHaveLength(20);
    expect(store.data.cases.map((c) => c.name)).toEqual(['Big']);
  });

  it('reports a quota error when eviction cannot make the workspace fit', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.login('admin', 'admin');
    store.addCase('Huge', randomText(20000, 99), 'LOW');
    await persist();

    expect(store.lastError).toMatch(/Cookie storage is full/);
    // Memory keeps the data so the session still works.
    expect(store.data.cases.map((c) => c.name)).toEqual(['Huge']);
  });
});

describe('changePassword', () => {
  beforeEach(() => {
    store.signup('alice', 'longpassword');
  });

  it('requires a signed-in user', () => {
    expect(store.changePassword('longpassword', 'newpassword1').success).toBe(false);
  });

  it('rejects a wrong current password and leaves the hash unchanged', () => {
    store.login('alice', 'longpassword');
    const before = store.data.users.alice?.passwordHash;
    expect(store.changePassword('wrongpassword', 'newpassword1')).toEqual({
      success: false,
      msg: 'Current password is incorrect.',
    });
    expect(store.data.users.alice?.passwordHash).toBe(before);
  });

  it('enforces the minimum length on the new password', () => {
    store.login('alice', 'longpassword');
    expect(store.changePassword('longpassword', 'short').success).toBe(false);
    expect(store.data.users.alice?.passwordHash).toBe(mod.mockHash('longpassword'));
  });

  it('changes the password, audits it without the password text, and keeps the old one from working', () => {
    store.login('alice', 'longpassword');
    expectOk(store.changePassword('longpassword', 'brandnewpass'));
    store.logout();
    expect(store.login('alice', 'longpassword').success).toBe(false);
    expectOk(store.login('alice', 'brandnewpass'));
    const entry = store.data.logs.find((l) => l.action === 'PASSWORD_CHANGE');
    expect(entry).toMatchObject({ username: 'alice' });
    expect(JSON.stringify(store.data.logs)).not.toContain('brandnewpass');
  });

  it('refuses "admin" as the admin password, in any letter case', () => {
    store.login('admin', 'admin');
    expect(store.changePassword('admin', 'Admin').success).toBe(false);
    expect(store.isDefaultAdminPassword()).toBe(true);
    expectOk(store.changePassword('admin', 'a-real-secret'));
    expect(store.isDefaultAdminPassword()).toBe(false);
  });

  it('refuses padded variants of "admin" for the admin account', () => {
    store.login('admin', 'admin');
    expect(store.changePassword('admin', '  admin  ').success).toBe(false);
    expect(store.data.users.admin?.passwordHash).toBe(mod.mockHash('admin'));
  });
});

describe('deleteUser', () => {
  beforeEach(() => {
    store.signup('alice', 'longpassword');
    store.signup('bob', 'longpassword');
  });

  it('refuses deletes from non-TOP_SECRET users', () => {
    store.login('alice', 'longpassword');
    expect(store.deleteUser('bob')).toEqual({ success: false, msg: 'Only TOP_SECRET users can delete accounts.' });
    expect(store.data.users.bob).toBeDefined();
  });

  it('refuses to delete yourself and unknown users', () => {
    store.login('admin', 'admin');
    expect(store.deleteUser('admin')).toEqual({ success: false, msg: 'You cannot delete your own account.' });
    expect(store.deleteUser('ghost')).toEqual({ success: false, msg: 'User not found.' });
  });

  it('lets a TOP_SECRET user delete another account, audits it, and blocks that login', () => {
    store.login('admin', 'admin');
    expectOk(store.deleteUser('bob'));
    expect(store.data.users.bob).toBeUndefined();
    expect(store.data.logs[0]).toMatchObject({ action: 'USER_DELETE', username: 'admin' });
    store.logout();
    expect(store.login('bob', 'longpassword').success).toBe(false);
  });
});

describe('listUsers and isDefaultAdminPassword', () => {
  it('lists username, clearance and created_at only, never password hashes', () => {
    store.signup('alice', 'longpassword');
    const list = store.listUsers();
    expect(list.map((u) => u.username).sort()).toEqual(['admin', 'alice']);
    for (const u of list) {
      expect(Object.keys(u).sort()).toEqual(['clearance', 'created_at', 'username']);
    }
    expect(JSON.stringify(list)).not.toContain(mod.mockHash('longpassword'));
  });

  it('reports the default admin password until it is changed', () => {
    expect(store.isDefaultAdminPassword()).toBe(true);
    store.login('admin', 'admin');
    expectOk(store.changePassword('admin', 'a-real-secret'));
    expect(store.isDefaultAdminPassword()).toBe(false);
  });
});

describe('eraseAllLocalData', () => {
  it('removes the persisted workspace so a fresh load starts from defaults', async () => {
    store.signup('alice', 'longpassword');
    store.addCase('Op Night', '', 'HIGH');
    await persist();
    expect(Object.keys(store.data.users)).toContain('alice');

    expect(store.getStorageUsage().bytesUsed).toBeGreaterThan(0);
    await expect(store.eraseAllLocalData()).resolves.toMatchObject({ success: true });
    expect(store.getStorageUsage().bytesUsed).toBe(0);
    // Pending debounced writes from before the erase must not come back.
    store.flushNow();
    await drainCookieQueue(cs);

    await boot();
    expect(Object.keys(store.data.users)).toEqual(['admin']);
    expect(store.data.cases).toEqual([]);
  });
});

describe('audit log', () => {
  it('keeps at most 150 entries, newest first', () => {
    store.login('admin', 'admin');
    for (let i = 0; i < 200; i++) store.logAction('TEST', String(i));
    expect(store.data.logs).toHaveLength(150);
    expect(store.data.logs[0]?.details).toBe('199');
    expect(store.data.logs[149]?.details).toBe('50');
  });
});
