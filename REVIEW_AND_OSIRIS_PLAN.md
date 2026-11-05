# Palantir (Aegis Nexus) — Review & Osiris Integration Plan

Scope of review: all of `src/` read at the store/App/Login/Map/Explorer/AI/Pipeline level, the rest scanned by grep. `tsc -b` passes cleanly; `oxlint` reports **4 errors + 10 warnings**. Not run in a browser yet, so UI items below are from code, not screenshots.

## 1. Bugs / glitches (highest first)

| # | Where | Problem | Fix |
|---|-------|---------|-----|
| 1 | `LoginScreen.tsx:65-81` + `store.ts:102,113` | Password is hashed in the form, then hashed **again** in `store.signup/login`. The seeded `admin/admin` user is stored with a single hash, so the documented default login almost certainly fails. | Pass the raw password to the store; hash in one place only. |
| 2 | `PipelineTab.tsx:59` vs `store.ts:358` | `bulkAddEntities(typeId, items, clearance)` is called as `(caseId, items)`. The type lookup fails, nothing is inserted, yet the UI shows "Successfully ingested N entities". The chosen clearance is also ignored. | Fix call signature; return a count/error from the store and show that. |
| 3 | `ExplorerTab.tsx:29,71,88`, `AnalyticsTab.tsx:29` | `useMemo` after an early `return` (rules-of-hooks). Switching case selection can throw "rendered more hooks than previous render". | Move hooks above the guard. |
| 4 | `MapTab.tsx:190-212` | Incident title/description injected into HTML strings (popup + divIcon) unescaped. Stored XSS, including via Pipeline JSON ingest. | Escape, or build DOM nodes / `textContent`. |
| 5 | `OntologyTab.tsx:41` vs `store.ts:343` | Confirm dialog says entities are *not* deleted; `deleteOntologyType` deletes every entity of that type. Silent data loss. | Fix the text or stop deleting; add undo. |
| 6 | `store.ts:3` | IDs are 9-char `Math.random()` strings (collision-prone). | `crypto.randomUUID()`. |
| 7 | `store.ts` `save()` | Whole workspace re-serialised on every click (`selectObject` saves); audit log unbounded; quota error only `console.error`. `App` re-renders everything via `forceUpdate`. | Debounce save, don't persist selection, cap/rotate logs, surface quota errors, use `useSyncExternalStore`. |
| 8 | `Explorer` / `App` | `selectObject` → `onSelect` callbacks are empty `() => {}`; selection has no visible effect in several tabs. | Add a shared detail drawer. |
| 9 | `MapTab.tsx:50-61` | Invalid dates give `NaN` timeline bounds; scrubber silently hides incidents. | Validate dates at entry. |
| 10 | Dead code | `AnalyticsTab` and `OmniSearch` are never mounted. `store.askCopilot` is a stub. | Mount or delete. |

## 2. Security / data-handling (matters for a "classified" tool)

- Auth is client-only; "password hashing" is a 32-bit string hash. Anyone can edit localStorage. Don't call it security; either label it a demo or add a real backend (see §4).
- **Anyone can self-assign TOP_SECRET at signup.** Clearance must come from an admin.
- AI API keys stored in plain text in localStorage, and serialised into the same blob as case data.
- Clearance filtering (`hasClearance`) is not applied consistently — verify every list/graph/map/search path.
- Don't send clearance-marked case data to third-party LLMs without a gate (matters for Osiris OI, below).

## 3. UI / UX

- Nav tabs are silently `disabled` with no explanation when no case is selected → show a tooltip/empty-state CTA ("Select or create a case").
- Native `alert()`/`confirm()` everywhere → toast + modal with undo.
- Explorer filters are clickable `div`s (no keyboard/ARIA); sidebar is icon-only at 11 tabs; no responsive/mobile layout (fixed 240px filter column).
- Heavy inline styles + a 2,000-line `index.css`; inconsistent design tokens (`premium-*` vs `btn-*` classes).
- AI tab is a canned mock report that presents itself as analysis → label "Demo", or wire a real provider. The API-key UI implies it works.
- Naming is inconsistent: "Palantir" (UI, README) vs "Aegis Nexus" (index.html). Using the Palantir name/logo is also a trademark risk if you ship publicly.
- Login: password-strength meter only on signup; no show-password; no lockout.
- Map: external tile servers and Nominatim without a proper User-Agent/rate-limit; Google Fonts is a runtime dependency (offline/air-gapped use fails). No loading/error states for tiles.
- Graph (613 lines, custom pan/zoom/drag): no minimap/search/export; effects with missing deps will cause stale layout.
- Accessibility: contrast of cyan-on-dark, no focus rings audit, no `aria-live` for status messages.

## 4. Engineering hygiene

- README is wrong: says pnpm (repo has `package-lock.json`), says D3 (not installed), says "password hashing" security.
- Fix the 4 lint errors / 10 exhaustive-deps warnings; replace `any` (Pipeline, Explorer, Ontology, Graph).
- No tests. Add Vitest for the store (auth, bulk ingest, path-finding, clearance) and a Playwright smoke test.
- `dist/` is present; add to `.gitignore`/ignore. Project isn't a git repo — `git init` first.
- Add schema versioning + migration for the localStorage blob; JSON export/import of a case.
- Code-split tabs (`React.lazy`) — Leaflet and graph code load up front.

## 5. Osiris integration plan

**What Osiris is** (per its README; not independently verified): MIT-licensed Next.js 16 / React 19 / MapLibre GL OSINT dashboard with ~16 live layers (OpenSky flights, USGS quakes, NASA FIRMS/EONET, NOAA space weather, CCTV, GDELT, RSS news, Telegram public-channel scraping, sanctions, crypto-wallet tracing), a BYO-key LLM assistant ("OI"), an MCP endpoint (`/api/mcp`), a Docker image, and a RECON toolkit (port/vuln scan) that needs a separate scanner backend.

**Key mismatch:** Osiris is server-side (Next API routes proxy third-party feeds; CORS and keys are handled there). Palantir is a browser-only Vite SPA. Porting Osiris wholesale into the SPA is not feasible; run it as a sidecar service and integrate at the data level.

### Architecture
```
Palantir SPA (Vite, Leaflet)  ──/osiris/api/*──►  Osiris container (Next.js, :3000)
        │  (dev: Vite proxy; prod: nginx reverse proxy, same origin)        │
        └── optional: small Palantir API (auth, sync) ◄───── MCP /api/mcp ──┘
```

### Phases
1. **Foundations (do first).** Fix §1 bugs 1–3; `git init`; add `docker-compose.yml` running `ghcr.io/simplifaisoul/osiris:latest` + Palantir behind nginx; Vite `server.proxy` for `/osiris`. Read Osiris `LICENSE`, `SECURITY.md`, `DOCKER.md`, `.env.example` and pin an image tag/commit (it has 358 commits and an active fork ecosystem — don't track `latest`).
2. **Live Feeds layer in the Map tab.** `osirisClient.ts` calling `/api/earthquakes`, `/api/flights`, `/api/fires`, `/api/weather`, `/api/gdelt`, `/api/news`, `/api/satellites`; render as toggleable Leaflet layer groups with viewport-based fetching and per-layer counts. Feed items are **ephemeral** and separate from case data.
3. **"Promote to case."** Click a feed item → create an Incident (lat/lon/time/source URL pre-filled) or Entity (aircraft, vessel, wallet), tagged `source: osiris`, with provenance in properties and an audit-log entry. Reuses existing `addIncident/addEntity`.
4. **Signals from feeds.** Poll chosen layers (e.g., quakes M≥5 inside a case's bounding box, conflict-zone news matching entity names) and create `Signal` records with NEW status in the existing Signals tab; dedupe by source id.
5. **Enrichment actions.** Add Ontology Action Types ("Sanctions check", "Wallet trace", "WHOIS/DNS/IP") that call `/api/osint/*` and write results onto the entity and audit log. Cross-check entity names against Osiris' OpenSanctions route.
6. **Osiris assistant → AI tab.** Replace the mock AI report with Osiris OI (SSE `/api/oi`) or your own provider; MCP `/api/mcp` is the route if you want agents to read cases. **Gate:** never send cases above UNCLASSIFIED (or any user-defined threshold) to external LLMs; show exactly what will be sent.
7. **Full-screen "Global Ops" tab (optional).** Embed the Osiris UI in an iframe for features not worth porting (CCTV/HLS, 3D, Telegram). Same-origin via nginx; note X-Frame-Options/CSP in Osiris' `next.config.ts`.
8. **Real backend (needed for "full" integration).** Server-side auth/RBAC with admin-assigned clearance, server-side audit log and secret storage; otherwise integration data and API keys inherit the localStorage weaknesses.

### Risks / decisions needed
- **RECON toolkit (port scan, vuln scan):** needs a separate scanner backend not in the repo; only use against systems you're authorised to test. Recommend leaving it **out** of the first release.
- **Telegram scraping and camera feeds:** check each source's terms and local law; some data (conflict-zone severity, ports) is hand-curated by Osiris, so show source and "as of" dates.
- **Reliability:** public feeds rate-limit and break; add caching, timeouts, a per-layer error state, and an upstream-health indicator. Self-hosting means you own upgrades.
- **Licensing/attribution:** MIT (per README) — include its notice if you copy code; OpenSanctions is CC-BY 4.0 and needs attribution.
- **Naming:** Osiris markets itself as "A Palantir Alternative"; avoid implying affiliation either way.

### Effort (rough)
Phase 1 ≈ 1–2 days · 2–3 ≈ 3–4 days · 4–5 ≈ 3–4 days · 6 ≈ 2 days · 7 ≈ 1 day · 8 ≈ 1–2 weeks.
