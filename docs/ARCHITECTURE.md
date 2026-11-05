# Architecture

This document describes the current structure of Aegis Nexus: the storage layer, the store, the tabs, the data model, the Osiris feed layer, and the AI send gate. It reflects the code as of 2026-11-05. Known gaps are listed in the [README](../README.md#known-limitations).

## Overview

Aegis Nexus is a client-side single-page app with no data server and no accounts. One store object holds the workspace, and it is saved to browser cookies. Smaller values live in sessionStorage and localStorage. Two optional Cloudflare Pages Functions run beside the app and store nothing: the Osiris gateway (`functions/osiris/`) and the Browser proxy (`functions/browse/`).

```text
index.html -> src/main.tsx -> src/App.tsx
                                |-- shell: sidebar nav, header, DetailDrawer, OmniSearch (Ctrl/Cmd+K)
                                `-- tab components (lazy-loaded), each reading the store
                                        |
                                    src/store.ts (singleton)
                                        |                    \                 \
                              src/utils/cookieStorage.ts      sessionStorage    localStorage
                                        |                     - aegis_ai_keys   (legacy copies, moved once)
                              cookies aegis_ws_0..n, aegis_ws_n  - aegis_osiris_ui
                              cookies aegis_bm (bookmarks)   - aegis_browser_consent
                                                              - aegis_ws_corrupt (unreadable copy)

Same origin, no storage:  /osiris/api/*  -> functions/osiris/[[path]].ts
                          /browse        -> functions/browse/[[path]].ts  (fetches third-party pages)
```

## Persistence layer (`src/utils/cookieStorage.ts`)

Cookies are the only persistent store for the workspace. Browser tab bookmarks also live in cookies, under `aegis_bm`, and count against the same budget. `localStorage` is read only for one-time migrations: an older `palantir_workspace` value, an older `palantir_ai_keys` value, and an older `aegis_browser_bookmarks` list.

**Layout for a key `K`:**

- `K_0 .. K_{n-1}`: payload chunks, at most 3,500 characters each.
- `K_n`: commit cookie with the value `${n}.${payloadLength}.${checksum}`.
- Payload: one marker character (`g` for gzip, `p` for plain UTF-8), then base64url. Gzip is used only when it is smaller.
- Checksum: FNV-1a, 32-bit, over the payload.

**Writes** go in this order: chunks, then the commit cookie, then deletion of stale chunks from an earlier, larger value. The write is refused before any cookie changes if the total would exceed the budget. After writing, each cookie is read back to confirm the browser stored it.

**Reads** check the commit cookie, chunk count, length, and checksum. A mismatch is treated as empty (a torn write) and logged as a warning.

**Budget.** `MAX_COOKIE_BYTES` is 16,000. It counts every cookie on the origin, `name=value` pairs and the `; ` separators included, so foreign cookies use up the same budget.

**Cookie attributes.** `path=/`, `max-age` of one year, `SameSite=Strict`, and `Secure` on https. The cookies are not `HttpOnly`, because they are written from JavaScript.

**Timing.** Writes are debounced by 300 ms in the store and serialized through a queue. They are flushed on `pagehide`, when the page becomes hidden, and on `beforeunload`.

**Backup helpers.** `exportAll` in the same module lists every stored key and produces a generic `palantir-cookie-backup` JSON file. The store calls `exportAll` only to list stored keys before Erase all local data. Workspace backups use the store's own export and import (below).

## Store (`src/store.ts`)

A single exported `store` instance holds the whole workspace. Components read `store.data` and re-render through `subscribe`. `store.save()` schedules a debounced write and notifies listeners.

**Persisted blob** under cookie key `aegis_ws` (`schema_version` 2):

| Field | Notes |
|---|---|
| `cases` | Each case holds ontology types, action types, entities, incidents, relationships, signals, and watch rules. |
| `active_case_id` | Selected case |
| `settings` | Theme, and per-provider `enabled`, `model`, and `key_stored` flags. Keys are not included. |
| `active_path` | Unused by the UI; kept for the shape |
| `logs` | Audit entries, newest first, capped at 150. IDs are regenerated on load. |

Not persisted: `selected_object` (UI selection) and AI API keys.

Schema 1 blobs (from the version with accounts) carried `users` with password hashes, `current_user`, and `current_user_id`. The loader ignores those fields, marks the blob for rewrite, and the next write drops them.

**Load.** `init()` reads the blob, applies it tolerantly (unknown or malformed fields fall back to defaults), and seeds nothing else. An unreadable blob is copied to sessionStorage under `aegis_ws_corrupt` before the next save overwrites it.

**Quota.** On a quota failure, the store drops audit entries down to 20 once and retries. If that still fails, `lastError` is set, and `StoreErrorBanner` in `App.tsx` shows it. In-memory state keeps working.

**Caps:**

| Limit | Value |
|---|---|
| Audit log entries | 150 (trimmed to 20 once on quota failure) |
| Signals per case | 25. Oldest DISMISSED signal is evicted first, then the oldest signal. |
| Watch rules per case | 5 |
| Signal title / description / AI text | 120 / 240 / 240 characters |
| Watch rule keyword | 60 characters |
| Watch rule radius | up to 20,000 km |
| AI case payload | 8,000 characters (`CASE_PAYLOAD_CHAR_LIMIT`) |
| AI analysis prompt | 2,000 characters |

**Operator.** There is one operator, named `operator` in the audit log. `getCurrentUserClearance()` always returns `TOP_SECRET`. There is no sign-in, no session, and no password.

**Backups.**

- `exportWorkspace()` writes the whole workspace as JSON (format `aegis-workspace-backup`), excluding AI keys.
- `importWorkspace(json)` replaces the workspace. It accepts that format or a bare workspace object, merges audit logs (deduplicated, capped at 150), keeps AI keys held in this session, and records a `WORKSPACE_IMPORT` entry.
- `exportCase(id)` writes one case as JSON (format `palantir-case`), filtered by the operator's clearance. `importCase(json)` adds it with a fresh ID.
- `exportCasesCsv(id)` returns two CSV tables, entities and incidents, filtered the same way, and records a `CASE_EXPORT` entry.

Settings > Data calls these. They are tested in `tests/store.test.ts`.

**Erase.** `eraseAllLocalData()` removes the workspace key, the legacy keys, and every other key found by `exportAll`, along with the sessionStorage copies. Settings then reloads the page. It is the only deletion path for all data.

**AI keys.** `set_ai_key` and `clear_ai_keys` write to sessionStorage under `aegis_ai_keys`. Keys are never written to cookies, so they are not sent with requests and do not use the budget. An older `palantir_ai_keys` value in localStorage is moved once.

## Navigation and tabs (`src/App.tsx`)

`App` keeps the active tab in React state. There is no URL routing. Each tab component is lazy-loaded. The header shows `Clearance: TOP_SECRET`, the operator's fixed clearance.

| Key | Label | Component | Needs case | Notes |
|---|---|---|---|---|
| `command` | Command | `CommandCenter` | No | Create, edit, delete cases; metrics; audit tail |
| `explorer` | Explorer | `ExplorerTab` | Yes | Entities and properties; sanctions action |
| `graph` | Graph | `GraphTab` | Yes | Canvas graph, pan, zoom, drag |
| `map` | Map | `MapTab` | Yes | Leaflet incidents, timeline scrubber, Live Feeds panel, promote to case |
| `chronology` | Timeline | `ChronologyTab` | Yes | Time-ordered incidents |
| `ontology` | Ontology | `OntologyTab` | Yes | Entity types and properties |
| `signals` | Signals | `SignalsTab` | Yes | Signal triage; watch rules; auto-run |
| `pipeline` | Pipeline | `PipelineTab` | No | Bulk JSON, JSONL, or CSV ingest into an ontology type |
| `ai` | AI | `AIReviewTab` | Yes | Send gate, payload preview, offline demo report |
| `analytics` | Analytics | `AnalyticsTab` | Yes | Filter and chart steps over one entity type |
| `audit` | Audit | `AuditTrailTab` | No | Filter, JSON download |
| `dossier` | Dossier | `DossierTab` | Yes | Per-entity summary, print |
| `globalops` | Global Ops | `GlobalOpsTab` | No | Sandboxed frame for a user-entered https URL |
| `browser` | Browser | `BrowserTab` | No | Reader view of third-party pages through `/browse`; tabs, bookmarks, save to case |
| `settings` | Settings | `SettingsTab` | No | Storage meter, backup and restore, case export and import, CSV, erase all data |

Tabs that need a case are shown as locked until one is selected. The Ctrl/Cmd+K search (`OmniSearch`) is mounted in the shell.

## Data model (`src/types.ts`)

```text
Case
 ├── ontology_types: OntologyObjectType[]   (name, icon, color, properties)
 ├── action_types:   ActionType[]           (parameters, target type)
 ├── entities:       Entity[]               (type, name, properties, clearance)
 ├── incidents:      Incident[]             (title, lat/lon as strings, date, clock, severity, clearance)
 ├── relationships:  Relationship[]         (type, src -> dst, confidence 0..1, rationale, clearance)
 ├── signals:        Signal[]               (source_id, title, severity, status, ai_assessment)
 └── watch_rules:    WatchRule[]            (layer, enabled, minSeverity?, keyword?, withinIncidentRadiusKm?)
AuditLog            (timestamp, username, action, details)
```

- Entities, incidents, and relationships carry a `clearance` (`UNCLASSIFIED`, `SECRET`, `TOP_SECRET`). `hasClearance(viewer, item)` is applied in the send gate and in the export and view filters. Because the operator is always TOP_SECRET, the view and export filters currently hide nothing. The send gate is the only path where a label excludes data.
- Enrichment writes results into `entity.properties.osint_<kind>` (summary, at most 190 characters).
- Severity levels are `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`.
- Signal statuses are `NEW`, `ACKNOWLEDGED`, `ESCALATED`, `DISMISSED`.

## Osiris and live feeds (`src/osiris/`)

- **`config.ts`**: base path `/osiris`, layer metadata (endpoint, colour, refresh interval), OSINT endpoints.
- **`client.ts`**: `fetchLayer`, `health`, and the four OSINT lookups. Every request has an 8-second timeout. Layer results are cached in memory for 60 seconds, keyed by layer and rounded bounding box. Responses are normalized tolerantly; unknown shapes yield no items rather than errors.
- **`hooks.ts`**: `useFeedLayer` polls one layer while it is enabled, using that layer's refresh interval. `useOsirisHealth` checks `/api/earthquakes` every 60 seconds.
- **Feed items are ephemeral.** They are kept in React state and are not written to the workspace unless promoted.
- **Promote to case** (`MapTab.tsx`) adds an incident to the active case with the item's coordinates, time, a severity mapped from the feed, clearance UNCLASSIFIED, and a description that holds the layer, source URL, feed ID, and upstream severity. There is no separate `source` field, and promotion writes no audit entry.
- **Watch rules** (`signals.ts`). A run fetches each enabled rule's layer once, then evaluates each item against the rules. All set criteria must match: minimum severity, keyword (matched against the item title or a case entity name in the title), or distance to any incident. A rule with no criteria matches everything on its layer. Each item produces at most one signal. Severity is HIGH if the rule sets a minimum, otherwise MEDIUM. Signals are deduplicated by `source_id`, and a `WATCH_RUN` entry is logged only when signals are added. The verdict is rule-based and involves no AI.
- **Enrichment** (`enrich.ts`). Four kinds: sanctions (entity name), wallet (a property with `wallet` or `address` in its key, 20 to 120 alphanumeric characters), WHOIS (a `domain` property), and IP (an `ip` property). Classified entities are refused unless the operator confirms in a dialog (`enrichWithConfirm`). The audit entry for a classified entity holds the ID, not the name. The summary is saved only if the entity is still in the active case.
- **Global Ops** (`GlobalOpsTab.tsx`). The https address is kept in sessionStorage. The frame uses `sandbox="allow-scripts allow-same-origin allow-popups"`.

## Browser tab (`src/browser/`, `functions/browse/`)

The Browser tab shows third-party pages as a reader view. The proxy and its limits are described in [CLOUDFLARE.md](CLOUDFLARE.md#browser-proxy-browse). On the client:

- **`components/BrowserTab.tsx`** holds the UI: tab strip, toolbar, address bar, bookmarks, and the page view. It owns the AbortControllers and the 500 ms per-tab navigation debounce.
- **`browser/client.ts`** calls `/browse` with `credentials: 'omit'` and checks the response shape strictly. `resolveAddress` uses an http(s) URL as typed, adds `https://` to host-like input, and turns anything else into a DuckDuckGo HTML search.
- **`browser/tabState.ts`** is a pure reducer. Up to 8 tabs, and 50 history entries per tab. Responses for superseded navigations are ignored through `loadId`.
- **`browser/readerTree.ts`** turns the sanitised HTML into a plain tree using an allowlist of tags. Links survive only as resolved http(s) URLs. Images survive only when they point at `/browse?asset=1`. Tree size is capped at 20,000 nodes and depth 120.
- **`browser/ReaderView.tsx`** renders that tree as React elements. Links go through `onOpen`, which starts a proxied navigation. The browser never navigates to a page.
- **`browser/bookmarks.ts`** keeps up to 20 bookmarks in the cookie store (`aegis_bm`). Titles are capped at 60 characters and URLs at 200, and duplicates are dropped. Each entry is re-validated on load. Reads return an empty list, and writes are refused, until the cookie store is ready, so existing bookmarks are never overwritten early. A write that would not fit the budget is refused.

Behaviour:

- **Consent.** The first navigation in a session asks the user to allow third-party pages. The answer is stored in sessionStorage as `aegis_browser_consent`. The start page never needs consent.
- **Save to case.** Creates an entity with the type string `Source`, clearance UNCLASSIFIED, and properties `url`, `title`, `retrieved`, `excerpt` (the first 300 characters of visible text), and `classification`. `Source` is not one of the case's ontology types, so the entity shows the raw type name.
- **Not supported.** Scripts, forms, logins, and video do not run or appear. Pages that refuse proxying show an error state.
- **Tests.** No tests cover `src/browser/` or `functions/browse/` yet. `ssrfGuard.ts`, `readerTree.ts`, and `tabState.ts` are pure and could be unit-tested directly.

## Settings tab (`SettingsTab.tsx`)

Settings has these sections, in order:

- **Storage.** Bytes used of the cookie budget, with a warning above 80%.
- **Data (backup, restore, export).** Download the full workspace as JSON. Restore from a workspace file (replaces everything). Download one case as JSON, or its entities or incidents as CSV. Import a case file as a new case.
- **Danger zone.** Erase all local data after typing `ERASE`.
- **Privacy.** Says where each kind of data is stored.

## AI send gate (`src/ai/`)

- **`gate.ts`** is the only path from case data to an external provider. `buildCasePayload` drops every item above the effective ceiling, which is the lower of the operator's clearance (TOP_SECRET) and the maximum the user chose, before any text is built. The case description is left out because it has no clearance marking. The text is capped at 8,000 characters, with a footer reserve, and truncation is noted in the text. Items excluded by clearance are counted in the preview.
- The UI shows `payload.text` verbatim, with counts. `sendThroughGate` refuses unless the acknowledgement box is ticked, and it sends the same string that was previewed. Case data is placed in a `<case_data>` block, and the system prompt tells the model to treat it as untrusted.
- **`providers.ts`** calls the four providers directly from the browser with `credentials: 'omit'`, `referrerPolicy: 'no-referrer'`, and a 60-second timeout. Keys go in headers, never URLs. Error text is truncated and any occurrence of the key is redacted.
- The audit entry for a live analysis records the provider, model, status, ceiling, and counts. It does not record content.
- **Demo mode** builds a fixed template from the case data. No request is made.

## Styling

Global styles and design tokens are in `src/index.css`. The dark theme is the default; light values are applied under a separate class. Components use a mix of CSS classes and inline styles.

## Tests

`tests/` holds four Vitest suites in jsdom: `cookieStorage.test.ts`, `store.test.ts`, `osiris.client.test.ts`, and `html.test.ts`, with `tests/helpers/fakeBrowser.ts` as a fake cookie jar. As of 2026-11-05, `npx vitest run` passes 113 tests. No suite covers the Pages Functions, the browser modules, or the Settings and Browser UI.

## Not built yet

- Server-side storage, server-side secrets, per-record persistence, authentication, and enforced clearance. Without a server, the browser-storage limits above apply, and anyone with the browser profile has the data.
- A DNS-level check in the browser proxy, and a Cloudflare rate-limit rule for `/browse*`. Both are outside this code. See [CLOUDFLARE.md](CLOUDFLARE.md#browser-proxy-browse).
- Osiris's own assistant and MCP endpoint are not wired into the AI tab. The AI tab calls providers directly with the user's key.
