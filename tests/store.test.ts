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

function activeCaseId(): string {
  const c = store.getActiveCase();
  if (!c) throw new Error('no active case');
  return c.id;
}

/** Minimal RFC 4180 parser, used to check that the CSV output round-trips. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += ch;
      }
      i++;
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 2;
      continue;
    } else {
      field += ch;
    }
    i++;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** A schema 1 blob, as written before accounts were removed. */
function legacyBlob(): Record<string, unknown> {
  return {
    schema_version: 1,
    users: {
      admin: { passwordHash: 'abc123', clearance: 'TOP_SECRET', created_at: '2024-01-01T00:00:00.000Z' },
      alice: { passwordHash: 'ff00ee11', clearance: 'SECRET', created_at: '2024-02-01T00:00:00.000Z' },
    },
    current_user: 'alice',
    current_user_id: 'alice',
    cases: [
      {
        id: 'c1',
        name: 'Old Case',
        description: '',
        severity_level: 'HIGH',
        ontology_types: [],
        action_types: [],
        entities: [
          {
            id: 'e1',
            type: 'Person',
            name: 'Subject',
            properties: {},
            clearance: 'SECRET',
            created_at: '2024-01-02T00:00:00.000Z',
          },
        ],
        incidents: [],
        relationships: [],
        signals: [],
        created_at: '2024-01-01T00:00:00.000Z',
      },
    ],
    active_case_id: 'c1',
    settings: { theme: 'dark', ai: {} },
    active_path: [],
    logs: [{ timestamp: '2024-01-03T00:00:00.000Z', username: 'alice', action: 'LOGIN', details: 'old entry' }],
  };
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

describe('init', () => {
  it('starts with an empty workspace and no account state', () => {
    expect(store.ready).toBe(true);
    expect(store.data.cases).toEqual([]);
    expect(Object.keys(store.data)).not.toContain('users');
    expect(Object.keys(store.data)).not.toContain('current_user');
    expect(Object.keys(store.data)).not.toContain('current_user_id');
  });

  it('is idempotent: repeated init returns the same promise and keeps the data', async () => {
    expect(store.init()).toBe(store.init());
    store.addCase('Kept', '', 'LOW');
    await store.init();
    expect(store.data.cases.map((c) => c.name)).toEqual(['Kept']);
  });
});

describe('operator clearance', () => {
  it('is always TOP_SECRET, before and after a reload', async () => {
    expect(store.getCurrentUserClearance()).toBe('TOP_SECRET');
    await reload();
    expect(store.getCurrentUserClearance()).toBe('TOP_SECRET');
  });

  it('audits every action as the constant operator name', () => {
    store.addCase('Audit', '', 'LOW');
    expect(store.data.logs[0]).toMatchObject({ action: 'CREATE_CASE', username: 'operator' });
  });

  it('sees SECRET and TOP_SECRET items in a case export', () => {
    store.addCase('Full', '', 'HIGH');
    const caseId = activeCaseId();
    store.addEntity(caseId, 'low', 'Node', 'UNCLASSIFIED', {});
    store.addEntity(caseId, 'mid', 'Node', 'SECRET', {});
    store.addEntity(caseId, 'top', 'Node', 'TOP_SECRET', {});
    const exported = JSON.parse(store.exportCase(caseId)).case;
    expect(exported.entities.map((e: { name: string }) => e.name)).toEqual(['low', 'mid', 'top']);
  });
});

describe('schema 1 to 2 migration', () => {
  it('loads cases, settings and the active case from a blob that still has users', async () => {
    await cs.setItem('aegis_ws', JSON.stringify(legacyBlob()));
    await drainCookieQueue(cs);
    await boot();

    expect(store.data.cases.map((c) => c.name)).toEqual(['Old Case']);
    expect(store.data.active_case_id).toBe('c1');
    expect(store.data.settings.theme).toBe('dark');
    expect(store.data.cases[0]?.entities[0]?.clearance).toBe('SECRET');
    expect(store.getCurrentUserClearance()).toBe('TOP_SECRET');
    expect(Object.keys(store.data)).not.toContain('users');
    expect(Object.keys(store.data)).not.toContain('current_user');
  });

  it('rewrites the stored blob as schema 2 with no accounts and no password hashes', async () => {
    await cs.setItem('aegis_ws', JSON.stringify(legacyBlob()));
    await drainCookieQueue(cs);
    await boot();
    await persist();

    const stored = JSON.parse((await cs.getItem('aegis_ws')) ?? 'null') as Record<string, unknown>;
    expect(stored.schema_version).toBe(2);
    expect(stored).not.toHaveProperty('users');
    expect(stored).not.toHaveProperty('current_user');
    expect(stored).not.toHaveProperty('current_user_id');
    expect(JSON.stringify(stored)).not.toContain('passwordHash');
    expect(JSON.stringify(stored)).not.toContain('abc123');
    expect(stored.cases).toHaveLength(1);
  });
});

describe('bulkAddEntities', () => {
  let caseId: string;

  beforeEach(() => {
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

  it('does not route through nodes the viewer cannot see', () => {
    store.addRelationship(caseId, 'LINKS_TO', ids.a, ids.d, 1, '', 'TOP_SECRET');
    vi.spyOn(store, 'getCurrentUserClearance').mockReturnValue('SECRET');
    expect(store.findShortestPath(ids.a, ids.d)).toEqual([ids.a, ids.b, ids.c, ids.d]);
  });
});

describe('case export and import', () => {
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

  it('exports only the entities, incidents and relationships a lower-cleared viewer may see', () => {
    store.addCase('Classified', '', 'HIGH');
    const caseId = activeCaseId();
    store.addEntity(caseId, 'pub', 'Node', 'UNCLASSIFIED', {});
    store.addEntity(caseId, 'sec', 'Node', 'SECRET', {});
    const ents = store.getActiveCase()?.entities ?? [];
    const pub = ents.find((e) => e.name === 'pub')!;
    const sec = ents.find((e) => e.name === 'sec')!;
    store.addIncident(caseId, 'pubInc', '', '1', '2', '2024-01-01', '00:00', 'LOW', 'UNCLASSIFIED');
    store.addIncident(caseId, 'secInc', '', '1', '2', '2024-01-01', '00:00', 'LOW', 'TOP_SECRET');
    store.addRelationship(caseId, 'LINKS_TO', pub.id, pub.id, 1, 'public', 'UNCLASSIFIED');
    store.addRelationship(caseId, 'LINKS_TO', pub.id, sec.id, 1, 'secret', 'SECRET');

    const spy = vi.spyOn(store, 'getCurrentUserClearance').mockReturnValue('UNCLASSIFIED');
    const viewed = JSON.parse(store.exportCase(caseId)).case;
    expect(viewed.entities.map((e: { name: string }) => e.name)).toEqual(['pub']);
    expect(viewed.incidents.map((i: { title: string }) => i.title)).toEqual(['pubInc']);
    expect(viewed.relationships.map((r: { rationale: string }) => r.rationale)).toEqual(['public']);

    spy.mockReturnValue('TOP_SECRET');
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

    vi.spyOn(store, 'getCurrentUserClearance').mockReturnValue('UNCLASSIFIED');
    const viewed = JSON.parse(store.exportCase(caseId)).case;
    expect(viewed.relationships).toHaveLength(0);
    expect(JSON.stringify(viewed)).not.toContain('secret rationale');
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

    // Hidden from a lower-cleared viewer, but visible at the operator's TOP_SECRET level.
    const spy = vi.spyOn(store, 'getCurrentUserClearance').mockReturnValue('SECRET');
    expect(JSON.parse(store.exportCase(imported.id)).case.entities).toHaveLength(0);
    spy.mockReturnValue('TOP_SECRET');
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

    vi.spyOn(store, 'getCurrentUserClearance').mockReturnValue('UNCLASSIFIED');
    const viewed = JSON.parse(store.exportCase(caseId)).case;
    expect(viewed.signals.map((s: { title: string }) => s.title)).toEqual(['open']);
  });
});

describe('CSV export of a case', () => {
  let caseId: string;

  beforeEach(() => {
    store.addCase('CSV', '', 'LOW');
    caseId = activeCaseId();
  });

  it('returns header rows and one row per entity and incident, in RFC 4180 form', () => {
    store.addEntity(caseId, 'Plain', 'Person', 'UNCLASSIFIED', { role: 'lead' });
    store.addIncident(caseId, 'Blast', 'Site, north', '51.5', '-0.1', '2024-01-01', '10:30', 'HIGH', 'SECRET');

    const { entities, incidents } = store.exportCasesCsv(caseId);
    expect(entities.endsWith('\r\n')).toBe(true);
    expect(parseCsv(entities)[0]).toEqual(['id', 'type', 'name', 'clearance', 'created_at', 'properties']);
    expect(parseCsv(incidents)[0]).toEqual([
      'id', 'title', 'description', 'lat', 'lon', 'date', 'clock', 'severity', 'clearance', 'created_at',
    ]);
    const entityRow = parseCsv(entities)[1]!;
    expect(entityRow.slice(1, 4)).toEqual(['Person', 'Plain', 'UNCLASSIFIED']);
    expect(JSON.parse(entityRow[5]!)).toEqual({ role: 'lead' });
    const incidentRow = parseCsv(incidents)[1]!;
    expect(incidentRow.slice(1, 3)).toEqual(['Blast', 'Site, north']);
    expect(incidentRow[8]).toBe('SECRET');
  });

  it('quotes commas, double quotes and line breaks, doubling embedded quotes', () => {
    store.addEntity(caseId, 'say "hi", twice\nthen', 'Node', 'UNCLASSIFIED', {});
    const { entities } = store.exportCasesCsv(caseId);
    expect(entities).toContain('"say ""hi"", twice\nthen"');
    expect(parseCsv(entities)[1]?.[2]).toBe('say "hi", twice\nthen');
  });

  it('prefixes cells that start with = + - @ or a tab or CR with a single quote', () => {
    const risky = ['=1+1', '+cmd', '-2+3', '@SUM(A1)', '\tTAB', '\rCR'];
    for (const name of risky) store.addEntity(caseId, name, 'Node', 'UNCLASSIFIED', {});
    store.addEntity(caseId, 'safe-name', 'Node', 'UNCLASSIFIED', {});

    const rows = parseCsv(store.exportCasesCsv(caseId).entities).slice(1);
    expect(rows.map((r) => r[2])).toEqual([...risky.map((n) => `'${n}`), 'safe-name']);
  });

  it('leaves negative and positive numeric coordinates unguarded', () => {
    store.addIncident(caseId, 'South', '', '-33.86', '151.2', '2024-01-01', '10:30', 'LOW', 'UNCLASSIFIED');
    store.addIncident(caseId, 'West', '', '-0.1', '+5', '2024-01-01', '10:30', 'LOW', 'UNCLASSIFIED');
    const rows = parseCsv(store.exportCasesCsv(caseId).incidents).slice(1);
    expect(rows[0]!.slice(3, 5)).toEqual(['-33.86', '151.2']);
    expect(rows[1]!.slice(3, 5)).toEqual(['-0.1', '+5']);
  });

  it('keeps formula-like text guarded even when it starts with a minus sign', () => {
    const risky = ['=SUM(A1)', '-cmd|x', '-1+cmd|x', '--5', '-'];
    for (const title of risky) store.addIncident(caseId, title, '', '', '', '', '', 'LOW', 'UNCLASSIFIED');
    const rows = parseCsv(store.exportCasesCsv(caseId).incidents).slice(1);
    expect(rows.map((r) => r[1])).toEqual(risky.map((t) => `'${t}`));
  });

  it('leaves out items above the viewer clearance', () => {
    store.addEntity(caseId, 'open', 'Node', 'UNCLASSIFIED', {});
    store.addEntity(caseId, 'hidden', 'Node', 'TOP_SECRET', {});
    vi.spyOn(store, 'getCurrentUserClearance').mockReturnValue('SECRET');
    const rows = parseCsv(store.exportCasesCsv(caseId).entities);
    expect(rows.slice(1).map((r) => r[2])).toEqual(['open']);
  });

  it('returns empty strings for an unknown case and audits a successful export', () => {
    expect(store.exportCasesCsv('missing')).toEqual({ entities: '', incidents: '' });
    store.exportCasesCsv(caseId);
    expect(store.data.logs[0]).toMatchObject({ action: 'CASE_EXPORT', username: 'operator' });
  });
});

describe('signal cap', () => {
  it('keeps at most 25 signals per case and evicts the oldest dismissed one first', () => {
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

describe('importWorkspace audit trail', () => {
  it('keeps the existing audit entries and appends the import entry', () => {
    store.addCase('Before', '', 'LOW');
    const backup = store.exportWorkspace();
    store.logAction('LOCAL_ONLY', 'happened after backup');

    store.importWorkspace(backup);

    expect(store.data.logs[0]).toMatchObject({ action: 'WORKSPACE_IMPORT', username: 'operator' });
    expect(store.data.logs.some((l) => l.action === 'LOCAL_ONLY')).toBe(true);
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
  it('contains cases, settings and audit entries but no accounts or password hashes', () => {
    store.addCase('W', '', 'LOW');
    const text = store.exportWorkspace();
    const backup = JSON.parse(text);
    expect(backup).toMatchObject({ format: 'aegis-workspace-backup', version: 1 });
    expect(backup.workspace).toMatchObject({ schema_version: 2 });
    expect(backup.workspace).not.toHaveProperty('users');
    expect(backup.workspace).not.toHaveProperty('current_user');
    expect(text).not.toContain('passwordHash');
  });

  it('round-trips cases through exportWorkspace and importWorkspace', () => {
    store.addCase('W', '', 'LOW');
    const backup = store.exportWorkspace();

    store.deleteCase(activeCaseId());
    expect(store.data.cases).toHaveLength(0);

    const result = store.importWorkspace(backup);
    expect(result).toEqual({ success: true, msg: 'Imported 1 cases.' });
    expect(store.data.cases.map((c) => c.name)).toEqual(['W']);
  });

  it('imports a schema 1 backup, ignores its accounts and never keeps the hashes', () => {
    const backup = { format: 'aegis-workspace-backup', version: 1, workspace: legacyBlob() };
    expect(store.importWorkspace(JSON.stringify(backup))).toEqual({ success: true, msg: 'Imported 1 cases.' });

    expect(store.data.cases.map((c) => c.name)).toEqual(['Old Case']);
    expect(Object.keys(store.data)).not.toContain('users');
    expect(JSON.stringify(store.data)).not.toContain('abc123');
    expect(store.exportWorkspace()).not.toContain('abc123');
    expect(store.exportWorkspace()).not.toContain('passwordHash');
  });

  it('accepts a bare workspace object without the backup wrapper', () => {
    expect(store.importWorkspace(JSON.stringify(legacyBlob()))).toEqual({ success: true, msg: 'Imported 1 cases.' });
  });

  it('rejects malformed input and leaves the data unchanged', () => {
    store.addCase('Keep', '', 'LOW');
    expect(store.importWorkspace('{')).toEqual({ success: false, msg: 'File is not valid JSON.' });
    expect(store.importWorkspace('{"x":1}')).toEqual({
      success: false,
      msg: 'File does not contain a workspace backup.',
    });
    expect(store.importWorkspace('{"users":{"a":{"passwordHash":"x"}}}')).toEqual({
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

describe('getBackupFilename', () => {
  it('formats the local date and time as aegis-nexus-backup-YYYYMMDD-HHMM.json', () => {
    expect(mod.getBackupFilename(new Date(2026, 10, 5, 9, 7))).toBe('aegis-nexus-backup-20261105-0907.json');
    expect(mod.getBackupFilename(new Date(2026, 0, 31, 23, 59))).toBe('aegis-nexus-backup-20260131-2359.json');
  });

  it('defaults to the current time', () => {
    expect(mod.getBackupFilename()).toMatch(/^aegis-nexus-backup-\d{8}-\d{4}\.json$/);
  });
});

describe('persistence', () => {
  it('cases and settings survive a reload', async () => {
    store.addCase('Persisted', '', 'MEDIUM');
    store.toggleTheme();

    await reload();

    expect(store.data.cases.map((c) => c.name)).toEqual(['Persisted']);
    expect(store.data.settings.theme).toBe('dark');
  });

  it('keeps an unreadable workspace copy in sessionStorage and starts with defaults', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await persist();
    await cs.setItem('aegis_ws', '{not json');

    await boot();

    expect(browser.sessionStore.get('aegis_ws_corrupt')).toBe('{not json');
    expect(store.data.cases).toEqual([]);
  });

  it('when storage is full, evicts old audit entries and saves the workspace', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
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
    store.addCase('Huge', randomText(20000, 99), 'LOW');
    await persist();

    expect(store.lastError).toMatch(/Cookie storage is full/);
    // Memory keeps the data so the session still works.
    expect(store.data.cases.map((c) => c.name)).toEqual(['Huge']);
  });
});

describe('eraseAllLocalData', () => {
  it('removes the persisted workspace so a fresh load starts from defaults', async () => {
    store.addCase('Op Night', '', 'HIGH');
    await persist();

    expect(store.getStorageUsage().bytesUsed).toBeGreaterThan(0);
    await expect(store.eraseAllLocalData()).resolves.toMatchObject({ success: true });
    expect(store.getStorageUsage().bytesUsed).toBe(0);
    // Pending debounced writes from before the erase must not come back.
    store.flushNow();
    await drainCookieQueue(cs);

    await boot();
    expect(store.data.cases).toEqual([]);
  });
});

describe('audit log', () => {
  it('keeps at most 150 entries, newest first', () => {
    for (let i = 0; i < 200; i++) store.logAction('TEST', String(i));
    expect(store.data.logs).toHaveLength(150);
    expect(store.data.logs[0]?.details).toBe('199');
    expect(store.data.logs[149]?.details).toBe('50');
  });
});
