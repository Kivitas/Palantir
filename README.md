# Aegis Nexus

Aegis Nexus is a browser-based intelligence analysis workspace for tracking entities, incidents, relationships, and signals across investigation cases. It is a React + TypeScript single-page app built with Vite. It has no server of its own: the app is static, and all data is stored in the user's browser cookies.

> **Demo-grade software.** Sign-in is client-side only, passwords use a non-cryptographic hash, and all data lives in browser cookies. Do not use it to protect real classified, personal, or sensitive data. See [Known limitations](#known-limitations).

> **Not affiliated.** Aegis Nexus is an independent project. It is not affiliated with, endorsed by, or sponsored by Palantir Technologies Inc. The optional Osiris integration is a separate project by its own authors, and this project is not affiliated with or endorsed by them.

## Features

Sidebar tabs. Explorer, Graph, Map, Timeline, Ontology, Signals, AI, Analytics, and Dossier need an active case. Command, Pipeline, Audit, and Global Ops do not.

- **Command**: create, edit, and delete cases; set severity; view metrics and the recent audit trail.
- **Explorer**: browse entities with properties and clearance. A sanctions check is available there.
- **Graph**: canvas relationship view with pan, zoom, and drag.
- **Map**: Leaflet map of incidents with a timeline scrubber and tile-layer switcher. A **Live Feeds** panel overlays seven Osiris feed layers (earthquakes, flights, fires, weather, GDELT, news, satellites). A feed item can be **promoted to the case** as an incident.
- **Timeline**: time-ordered incidents.
- **Ontology**: define entity types and their properties.
- **Signals**: triage signals (NEW, ACKNOWLEDGED, ESCALATED, DISMISSED). Up to five **watch rules** per case check feed layers by minimum severity, keyword, or distance to an incident, and each match becomes a NEW signal. Matching is rule-based; no AI is involved. Runs are started manually or every five minutes with the auto-run checkbox.
- **Pipeline**: bulk-ingest JSON records as entities of an ontology type.
- **AI**: send case data to a provider (Anthropic, OpenAI, Google Gemini, or Mistral) using your own API key. A preview shows exactly what will be sent, and sending requires an acknowledgement. Without a key, an offline template report is generated; no model is called.
- **Analytics**: build filter and chart steps over one entity type's properties.
- **Audit**: searchable log with a JSON download.
- **Dossier**: per-entity summary, printable.
- **Global Ops**: shows an Osiris UI (or any https page you enter) inside a sandboxed frame.

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
| `npm run build` | Type-checks `src/` (`tsc -b`) and writes the production build to `dist/`. |
| `npm run preview` | Serves the production build locally. |
| `npm test` | Runs the Vitest suite (see [Tests](#tests)). |
| `npm run lint` | Runs oxlint. |
| `npm run typecheck:functions` | Type-checks the Pages Function in `functions/`. |
| `npm run pages:dev` | After a build, runs the app and the Pages Function locally with Wrangler (port 8788). |
| `npm run pages:deploy` | Builds, then deploys `dist/` to Cloudflare Pages with Wrangler. |

## Deploy to Cloudflare Pages

Cloudflare Pages is the deployment target. It serves the static build in `dist/` and a Pages Function at `functions/osiris/[[path]].ts` that handles same-origin `/osiris/api/*` requests. Docker is not needed.

1. In **Workers & Pages > Create > Pages > Connect to Git**, select this repository.
2. Build command `npm run build`, build output directory `dist`, Node.js 22 or newer.
3. Optional: set `OSIRIS_URL` (the base URL of a self-hosted Osiris) under Environment variables. Leave it unset to use the keyless fallbacks (USGS earthquakes and NASA EONET weather).

Or deploy from the command line with `npx wrangler login` once, then `npm run pages:deploy`. The full guide, environment variables, headers, and troubleshooting are in [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md).

## Default account and accounts

On first run, when no users exist, the app creates an account with:

- Username: `admin`
- Password: `admin`
- Clearance: `TOP_SECRET`

**Change this before any use beyond a throwaway demo.** The current build has no screen to change a password, delete a user, or create a new TOP_SECRET user, so there is no in-app way to replace it yet. Clearing the site's cookies recreates the default account.

Sign-up creates an UNCLASSIFIED account. The store can raise clearance (only a TOP_SECRET user may do it), but no screen calls that function yet, so clearance is effectively fixed.

## Storage

All workspace data is kept in **browser cookies**, not `localStorage`:

- Cases, users (with password hashes), settings, the signed-in user, and the audit log (up to 150 entries) are stored as one JSON blob split across cookies named `aegis_ws_*`.
- The whole site shares a **16,000-byte budget** for its Cookie header, including any other cookies. When a write would exceed it, the save is refused and a banner says so.
- AI API keys and the Global Ops address are kept in **sessionStorage**, so they are cleared when the tab closes and are never sent with requests.

Tradeoffs:

- Cookies are sent with every request to the site, including static files and `/osiris/api/*` calls. The Pages Function does not forward them upstream.
- The budget is small. A few hundred records will fill it.
- Data is lost if cookies are cleared, and it is per browser and per domain. Nothing syncs across devices.
- Cookies are not encrypted. The gzip step only compresses. Anyone who can read the cookies can read the data and the password hashes.
- The session is kept in the blob, so a user stays signed in until they log out or the cookie expires (about one year).

Backups: the store has `exportWorkspace` / `importWorkspace` (whole workspace, password hashes included, AI keys excluded) and `exportCase` / `importCase`. They are unit-tested, but no screen calls them yet. The only export in the UI is the audit-log download. The quota banner tells users to export a backup, and that button does not exist yet.

## Optional: self-hosted Osiris

Osiris is an optional, separate OSINT dashboard. The app reaches it only through the same-origin `/osiris/api/*` route. In production, the Pages Function proxies allowlisted routes to Osiris when `OSIRIS_URL` is set. Without it, only the keyless earthquake and weather feeds work. Details, routes, and risks are in [docs/OSIRIS.md](docs/OSIRIS.md).

Docker is **optional and only for self-hosting**. `docker-compose.yml`, `Dockerfile`, and `nginx/` run Osiris as a sidecar behind nginx on port 8080:

```bash
docker compose up --build
```

Pin the Osiris image to a tag or digest. The compose file currently uses `latest`.

## Project structure

```text
.
├── index.html                  App shell
├── package.json                Scripts and dependencies
├── vite.config.ts              Vite config (React plugin, dev-only /osiris proxy, test config)
├── wrangler.toml               Cloudflare Pages project config
├── functions/osiris/[[path]].ts  Pages Function: Osiris gateway
├── public/                     Copied as-is: _headers (CSP and security headers), _redirects, _routes.json
├── src/
│   ├── main.tsx                React entry point
│   ├── App.tsx                 Shell, sidebar navigation, tab routing
│   ├── store.ts                Global store: auth, cases, entities, persistence, backups
│   ├── utils/cookieStorage.ts  Cookie-backed key/value storage with a size budget
│   ├── ai/                     Provider calls (providers.ts) and the send gate (gate.ts)
│   ├── osiris/                 Osiris client, feed hooks, enrichment, watch rules
│   ├── components/             One component per tab, plus feeds/ and LoginScreen
│   └── ui/                     Drawer, toasts, confirm dialog
├── tests/                      Vitest suites
├── docs/                       ARCHITECTURE.md, OSIRIS.md, CLOUDFLARE.md
├── Dockerfile, docker-compose.yml, nginx/   Optional self-host only
└── REVIEW_AND_OSIRIS_PLAN.md   Earlier review notes and integration plan (not updated here)
```

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the store, cookie layout, tabs, data model, and the AI send gate.

- **Frontend**: React 19, TypeScript, Vite 8.
- **State**: a single store (`src/store.ts`) persisted to cookies under `aegis_ws`.
- **Maps**: Leaflet with OpenStreetMap, OpenTopoMap, and Esri World Imagery tiles, and Nominatim for place search.
- **Graph**: custom canvas rendering (no graph library).
- **Icons**: lucide-react.

## Tests

`npm test` runs Vitest in jsdom over `tests/*.test.ts`: cookie storage, the store (accounts, cases, backups, audit log, persistence), the Osiris client, and HTML escaping. At the time of writing, 112 tests in 4 files pass.

There are no tests for the Pages Function, the AI send gate's network path, or the UI.

## Known limitations

- **Authentication is client-side only.** Passwords are hashed with a 32-bit, unsalted, non-cryptographic hash (`mockHash`), so they can be brute-forced quickly from the stored cookies. There is no server, session expiry, lockout, or rate limiting.
- **Storage is small and browser-bound.** The whole site shares 16,000 bytes of cookies. Quota failures show a banner, and the audit log is trimmed once to make room. Data is not shared between browsers or users.
- **Backup and restore have no UI.** See [Storage](#storage).
- **Clearance is not enforced by a server.** Clearance filtering is applied in the AI send gate, case export, and several views, but not uniformly across every list, graph, map, and search path.
- **No user management UI.** No screen changes a password, deletes a user, or raises clearance.
- **AI calls go straight from the browser** to the provider with the user's key. The key is visible to anyone who can run the page or read the tab's session storage. Default model names are editable and must be checked against each provider's current list.
- **Osiris response shapes are unverified** against a live instance. Normalizers accept several plausible shapes and silently drop anything they cannot map. OSINT query parameter names and the bounding-box format are unverified too.
- **Without `OSIRIS_URL`**, only the earthquake and weather layers work. Enrichment and the other feeds show errors. The "Osiris online" indicator checks the earthquake route, which the keyless fallback answers, so it shows "online" even without a connected Osiris.
- **The weather layer** uses NASA EONET open events, which is a large payload. It can time out (504 after 10 seconds).
- **Global Ops embeds a third-party page.** The CSP allows framing any `https:` origin, and many sites block framing and will appear blank. The app cannot read the frame's content.
- **OpenSanctions attribution is not shown.** OpenSanctions data is CC BY 4.0 and needs attribution wherever its results appear. Sanctions results currently appear as a summary in entity properties with no attribution.
- **Dependency audit.** `npm audit` reports 4 high-severity findings, all in development tooling: `vite` (a direct dev dependency) and transitive `nanoid`, `postcss`, and `source-map-js`. None of the runtime dependencies (react, react-dom, leaflet, lucide-react) appear in the report. Review these before a production deployment.
- **Network dependencies.** Map tiles, Nominatim search, and Google Fonts need internet access.
- **Accessibility and responsive layout** are incomplete. The layout is designed for desktop widths.
- **No LICENSE file** is in the repository. The README states MIT, so add the license file before publishing.

## Naming

The browser title and UI say "Aegis Nexus". The folder name, `package.json` name (`palantir`), and the cookie key prefix (`aegis_ws`, migrated from `palantir_workspace`) still use the old name and will be renamed separately.

## License

Aegis Nexus is released under the MIT License, as stated above; see the note in Known limitations. Osiris is a separate MIT-licensed project by its own authors. Data sources used by the optional integration have their own terms; see [docs/OSIRIS.md](docs/OSIRIS.md).
