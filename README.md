# Aegis Nexus

Aegis Nexus is a browser-based intelligence analysis workspace for tracking entities, incidents, relationships, and signals across investigation cases. It is a React + TypeScript single-page app built with Vite. It has no data server: the app is static, and all data is stored in the browser's cookies. Two optional Cloudflare Pages Functions (an Osiris gateway and a browser proxy) store nothing.

It is a single-operator tool. There are no accounts, logins, or passwords.

> **No authentication.** Anyone with access to your browser profile can read your workspace. Anyone who opens the deployed URL gets the app, but sees only the data stored in their own browser's cookies. The deployed site is public static. Do not put sensitive data in this app. See [Access and clearance](#access-and-clearance) and [Known limitations](#known-limitations).

> **Not affiliated.** Aegis Nexus is an independent project. It is not affiliated with, endorsed by, or sponsored by Palantir Technologies Inc. The optional Osiris integration is a separate project by its own authors, and this project is not affiliated with or endorsed by them.

## Features

Sidebar tabs. Explorer, Graph, Map, Timeline, Ontology, Signals, AI, Analytics, and Dossier need an active case. Command, Pipeline, Audit, Global Ops, Browser, and Settings do not.

- **Command**: create, edit, and delete cases; set severity; view metrics and the recent audit trail.
- **Explorer**: browse entities with properties and clearance. A sanctions check is available there.
- **Graph**: canvas relationship view with pan, zoom, and drag.
- **Map**: Leaflet map of incidents with a timeline scrubber and tile-layer switcher. A **Live Feeds** panel overlays seven Osiris feed layers (earthquakes, flights, fires, weather, GDELT, news, satellites). A feed item can be **promoted to the case** as an incident.
- **Timeline**: time-ordered incidents.
- **Ontology**: define entity types and their properties.
- **Signals**: triage signals (NEW, ACKNOWLEDGED, ESCALATED, DISMISSED). Up to five **watch rules** per case check feed layers by minimum severity, keyword, or distance to an incident, and each match becomes a NEW signal. Matching is rule-based; no AI is involved. Runs are started manually or every five minutes with the auto-run checkbox.
- **Pipeline**: bulk-ingest JSON, JSONL, or CSV records as entities of an ontology type.
- **AI**: send case data to a provider (Anthropic, OpenAI, Google Gemini, or Mistral) using your own API key. Only items at or below the **Maximum clearance to send** are included. A preview shows exactly what will be sent, and sending requires an acknowledgement. Without a key, an offline template report is generated; no model is called.
- **Analytics**: build filter and chart steps over one entity type's properties.
- **Audit**: searchable log with a JSON download.
- **Dossier**: per-entity summary, printable.
- **Global Ops**: shows an Osiris UI (or any https page you enter) inside a sandboxed frame.
- **Browser**: reader view of third-party pages, fetched through the `/browse` proxy. Scripts are removed and no app cookies are sent. A page can be saved to the case as a Source.
- **Settings**: cookie storage meter; full workspace backup and restore (JSON); per-case JSON export and import; entities and incidents CSV download for a case; erase all local data.

**Enrichment.** Sanctions, wallet, WHOIS, and IP lookups run through Osiris from the entity detail view (sanctions also from Explorer). Classified entities need an explicit confirmation first. Results are stored as a short summary in the entity's properties and recorded in the audit log.

## Quick start

Requirements: Node.js 22 or newer and npm. The repository uses `package-lock.json`.

```bash
npm install
npm run dev      # http://localhost:5173
```

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server. Proxies `/osiris` only when `OSIRIS_URL` is set in the shell. |
| `npm run build` | Type-checks (`tsc -b`) and writes the production build to `dist/`. |
| `npm run preview` | Serves the production build locally. |
| `npm test` | Runs the Vitest suite (see [Tests](#tests)). |
| `npm run lint` | Runs oxlint. |
| `npm run typecheck:functions` | Type-checks the Pages Functions in `functions/`. |
| `npm run pages:dev` | After a build, runs the app and the Pages Functions locally with Wrangler (port 8788). |
| `npm run pages:deploy` | Builds, then deploys `dist/` to Cloudflare Pages with Wrangler. |

## Deploy to Cloudflare Pages

Cloudflare Pages is the deployment target. It serves the static build in `dist/` and two Pages Functions: `functions/osiris/[[path]].ts` (same-origin `/osiris/api/*`) and `functions/browse/[[path]].ts` (the Browser tab's `/browse` proxy). Docker is not needed.

1. In **Workers & Pages > Create > Pages > Connect to Git**, select this repository.
2. Set the build command to `npm run build` and the build output directory to `dist`. Use Node.js 22 or newer (set `NODE_VERSION=22` under environment variables if the default is older).
3. Optional: add `OSIRIS_URL` (the base URL of a self-hosted Osiris) under **Settings > Environment variables**. Leave it unset to use the keyless fallbacks (USGS earthquakes and NASA EONET weather).

Then save and deploy. Every push to the production branch redeploys.

Command-line alternative: `npx wrangler login` once, then `npm run pages:deploy`.

Before opening the deployment to anyone else, read [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md). It covers the environment variables, the security headers in `public/_headers`, the Browser proxy's open gaps, and troubleshooting.

## Access and clearance

There are no accounts, logins, or passwords. Every audit entry is recorded as `operator`, and the operator always holds the top clearance level (TOP_SECRET).

- **No authentication.** Access is whatever the browser allows. Anyone with access to your browser profile can read the workspace cookies and the data in them.
- **The deployed site is public static.** Its files and the two Pages Functions (`/osiris`, `/browse`) are reachable by anyone with the URL. Each visitor gets an empty workspace in their own browser.
- **Do not put sensitive data here.** Nothing in this app is protected by a server, encryption, or sign-in.
- **Clearance labels** (UNCLASSIFIED, SECRET, TOP_SECRET) on entities, incidents, relationships, and signals have two real effects:
  - **AI sends.** Items above the chosen **Maximum clearance to send** are never included in the prompt, and the preview shows the count excluded.
  - **Enrichment.** Classified entities are not sent to Osiris until the operator confirms.
- **Export filters.** Case exports and CSV downloads filter by the operator's clearance. Because the operator is always TOP_SECRET, these filters currently exclude nothing.
- **Views.** Because the operator is always TOP_SECRET, labels do not hide anything in the UI.

Clearance labels are a handling marker and a send gate. They are not an access control.

## Storage

All workspace data is kept in **browser cookies**, not `localStorage`:

- Cases (with their entities, incidents, relationships, signals, watch rules, ontology types), settings, and the audit log (up to 150 entries) are stored as one JSON blob, compressed and split across cookies named `aegis_ws_*`.
- The whole site shares a **16,000-byte budget** for its Cookie header, including any other cookies. When a write would exceed it, the save is refused and a banner says so. The audit log is trimmed once to make room.
- AI API keys, the Global Ops address, and the Browser consent answer are kept in **sessionStorage**, so they are cleared when the tab closes. AI keys are never written to cookies, so they are not sent with requests.

Tradeoffs:

- Cookies are sent with every request to the site, including static files and `/osiris/api/*` and `/browse` calls. The Pages Functions do not forward them upstream.
- The budget is small. A few hundred records will fill it.
- Cookies are not encrypted, and any script running on the site can read them. Anyone who can read the cookies can read the data.
- Data is lost if cookies are cleared, and it is per browser and per domain. Nothing syncs across devices.
- Cookies last up to one year.

Backups: **Settings > Backup and restore** downloads the whole workspace as JSON (every case, the audit trail, and settings; AI keys excluded). Restoring from that file replaces the whole workspace. You can also download one case as JSON, import a case file as a new case, and download a case's entities or incidents as CSV. Backup files are plain text. Keep them private. The Browser tab's bookmarks are stored in their own cookie (`aegis_bm`), inside the same budget.

## Optional: self-hosted Osiris

Osiris is an optional, separate OSINT dashboard. The app reaches it only through the same-origin `/osiris/api/*` route. In production, the Pages Function proxies allowlisted routes to Osiris when `OSIRIS_URL` is set. Without it, only the keyless earthquake and weather feeds work. Details, routes, and risks are in [docs/OSIRIS.md](docs/OSIRIS.md).

Docker is **optional and only for self-hosting**. `docker-compose.yml`, `Dockerfile`, and `nginx/` run Osiris as a sidecar behind nginx on port 8080:

```bash
docker compose up --build
```

Set `OSIRIS_IMAGE_TAG` to a reviewed Osiris release tag or digest (in `.env` or the shell). Compose refuses to start while it is unset, so the image is never `latest` by default.

## Project structure

```text
.
├── index.html                    App shell
├── package.json                  Scripts and dependencies
├── vite.config.ts                Vite config (React plugin, dev-only /osiris proxy, test config)
├── wrangler.toml                 Cloudflare Pages project config (name, output dir)
├── functions/osiris/[[path]].ts  Pages Function: Osiris gateway
├── functions/browse/[[path]].ts  Pages Function: sanitising browser proxy (Browser tab)
├── public/                       Copied as-is: _headers (CSP and security headers), _redirects, _routes.json
├── src/
│   ├── main.tsx                  React entry point
│   ├── App.tsx                   Shell, sidebar navigation, tab routing
│   ├── store.ts                  Global store: cases, entities, persistence, backups, erase
│   ├── types.ts                  Data model and clearance helpers
│   ├── utils/cookieStorage.ts    Cookie-backed key/value storage with a size budget
│   ├── ai/                       Provider calls (providers.ts) and the send gate (gate.ts)
│   ├── osiris/                   Osiris client, feed hooks, enrichment, watch rules
│   ├── browser/                  Browser tab: proxy client, SSRF guard, reader tree, tab state
│   ├── components/               One component per tab, plus feeds/
│   └── ui/                       Drawer, toasts, confirm dialog
├── tests/                        Vitest suites
├── docs/                         ARCHITECTURE.md, OSIRIS.md, CLOUDFLARE.md
├── Dockerfile, docker-compose.yml, nginx/   Optional self-host only
└── REVIEW_AND_OSIRIS_PLAN.md     Status: what shipped and what remains
```

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the store, cookie layout, tabs, data model, and the AI send gate.

- **Frontend**: React 19, TypeScript, Vite 8.
- **State**: a single store (`src/store.ts`) persisted to cookies under `aegis_ws`.
- **Maps**: Leaflet with OpenStreetMap, OpenTopoMap, and Esri World Imagery tiles, and Nominatim for place search.
- **Graph**: custom canvas rendering (no graph library).
- **Icons**: lucide-react.

## Tests

`npm test` runs Vitest in jsdom over `tests/*.test.ts`: cookie storage, the store (cases, backups, audit log, persistence, erase), the Osiris client, and HTML escaping. As of 2026-11-05, `npx vitest run` passes 113 tests in 4 files.

There are no tests for the Pages Functions, the browser proxy's SSRF guard, the AI send gate's network path, or the UI.

## Known limitations

- **No authentication.** Anyone with access to the browser profile can read the workspace. The deployed site is public static, and each visitor sees only their own browser's data. Do not store sensitive data here. See [Access and clearance](#access-and-clearance).
- **Clearance labels are not access control.** They gate AI sends and enrichment. The export filters use the operator's clearance (always TOP_SECRET), so they exclude nothing today. No server enforces anything.
- **Storage is small and browser-bound.** The whole site shares 16,000 bytes of cookies. Quota failures show a banner, and the audit log is trimmed once to make room. Data is not shared between browsers or users.
- **Cookies are readable by scripts on the site.** They are not `HttpOnly`, because the app writes them from JavaScript.
- **Backups are plain JSON.** A workspace backup contains every case, the audit trail, and settings. It excludes AI keys. Keep it private. See [Storage](#storage).
- **Browser proxy checks addresses, not DNS.** `/browse` blocks private and internal addresses in the URL text and on every redirect, but it does not resolve names. A public name that points at a private address is not caught by the app. Rate limits are per isolate. See [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md#browser-proxy-browse).
- **AI calls go straight from the browser** to the provider with the user's key. The key is visible to anyone who can run the page or read the tab's session storage. Default model names are editable and must be checked against each provider's current list.
- **Osiris response shapes are unverified** against a live instance. Normalizers accept several plausible shapes and silently drop anything they cannot map. OSINT query parameter names and the bounding-box format are unverified too.
- **Without `OSIRIS_URL`**, only the earthquake and weather layers work. Enrichment and the other feeds show errors. The "Osiris online" indicator checks the earthquake route, which the keyless fallback answers, so it shows "online" even without a connected Osiris.
- **The weather layer** uses NASA EONET open events, which is a large payload. It can time out (504 after 10 seconds).
- **Global Ops embeds a third-party page.** The CSP allows framing any `https:` origin, and many sites block framing and will appear blank. The app cannot read the frame's content.
- **OpenSanctions attribution is partial.** Attribution appears in the entity detail drawer's Enrich section. The Explorer sanctions button does not show it yet, and its results are stored in entity properties without it.
- **Dependency audit.** `npm audit` reported 0 vulnerabilities against the committed `package-lock.json` on 2026-11-05. Re-run it before any production deployment.
- **Network dependencies.** Map tiles, Nominatim search, and Google Fonts need internet access.
- **Accessibility and responsive layout** are incomplete. The layout is designed for desktop widths.

## Naming

The browser title and UI say "Aegis Nexus". The folder name, `package.json` name (`palantir`), and the cookie key prefix (`aegis_ws`, migrated from `palantir_workspace`) still use the old name and will be renamed separately.

## Credits & data sources

Aegis Nexus uses the following. Each source keeps its own terms.

- **Osiris** ([github.com/simplifaisoul/osiris](https://github.com/simplifaisoul/osiris)): optional self-hosted feed and OSINT gateway. MIT, per its README. Not bundled here.
- **OpenSanctions** ([opensanctions.org](https://www.opensanctions.org)): sanctions data. CC BY 4.0.
- **USGS** earthquake feed and **NASA EONET** events: keyless fallback feeds for the Live Feeds panel.
- **OpenStreetMap contributors**: map tiles and Nominatim place search. Data under ODbL.
- **OpenTopoMap** and **Esri** World Imagery: optional map base layers.
- **DuckDuckGo**: search results page used by the Browser tab's search.
- **Leaflet** (BSD-2-Clause) and **lucide-react** (ISC): libraries.

## License

Copyright (C) 2026 Kivitas. Aegis Nexus is free software, released under the GNU Affero General Public License v3.0 (AGPL-3.0-only). See [LICENSE](LICENSE). If you run a modified version as a network service, section 13 requires you to offer its users the corresponding source code. Osiris is a separate MIT-licensed project by its own authors. Data sources used by the optional integration have their own terms; see [docs/OSIRIS.md](docs/OSIRIS.md).
