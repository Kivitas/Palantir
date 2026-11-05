# Osiris integration

This document describes how Aegis Nexus uses [Osiris](https://github.com/simplifaisoul/osiris), the routes and environment variables involved, and the risks to manage.

## Status

Implemented in this repository:

- The same-origin gateway, a Cloudflare Pages Function (`functions/osiris/[[path]].ts`), with two modes: proxy to a self-hosted Osiris, or keyless fallbacks.
- Live feed layers on the Map tab, with a health indicator.
- Promote-to-case from a feed item.
- Watch rules on the Signals tab.
- Enrichment lookups (sanctions, wallet, WHOIS, IP) with a classified-data gate.
- The Global Ops tab, which embeds a user-entered https page in a sandboxed frame.

Not verified: the Osiris response shapes, the OSINT query parameters, and the bounding-box format. They have not been checked against a live Osiris instance (see [Limitations](#limitations)).

## About Osiris

Per its README (not checked in this pass): Osiris is an MIT-licensed OSINT dashboard built on Next.js, React, and MapLibre GL. It aggregates public feeds and offers an LLM assistant that uses the user's own key. It ships a Docker image. Aegis Nexus is not affiliated with the Osiris project, and the integration does not imply endorsement in either direction.

## Architecture

Osiris is server-side software that calls third-party feeds and holds their keys. Aegis Nexus is a browser-only app, so it reaches Osiris only through a same-origin route.

```text
Browser (Aegis Nexus)
   |  GET /osiris/api/<route>            (same origin)
   v
Cloudflare Pages Function  functions/osiris/[[path]].ts      (production)
   |-- OSIRIS_URL set:    proxy an allowlisted route to  <OSIRIS_URL>/api/<route>
   `-- OSIRIS_URL unset:  keyless fallbacks for earthquakes (USGS) and weather (NASA EONET);
                          other routes return 501

Vite dev server (npm run dev)   proxies /osiris to OSIRIS_URL when it is set in the shell.
                                This bypasses the Function's allowlist. Development only.

Docker (optional self-host)     nginx proxies /osiris/ to osiris:3000 (prefix stripped).
```

The client uses `OSIRIS_BASE = '/osiris'`. Requests go to `/osiris/api/<endpoint>`.

## Routes

The Function handles GET, HEAD, and OPTIONS. Other methods return 405. A path outside the allowlist returns 404.

| Route | Used by | `OSIRIS_URL` unset | `OSIRIS_URL` set |
|---|---|---|---|
| `earthquakes` | Live Feeds layer, watch rules, Osiris health check | USGS 2.5-day GeoJSON feed | Proxied |
| `weather` | Live Feeds layer | NASA EONET open events, reduced to point features | Proxied |
| `flights`, `fires`, `satellites`, `gdelt`, `news` | Live Feeds layers | 501 `not_configured` | Proxied |
| `osint/sanctions` | Enrichment: sanctions | 501 | Proxied |
| `osint/crypto` | Enrichment: wallet | 501 | Proxied |
| `osint/whois` | Enrichment: WHOIS | 501 | Proxied |
| `osint/ip` | Enrichment: IP | 501 | Proxied |

Responses are cached for 60 seconds at the edge (`s-maxage=60`). Errors are `no-store`.

## Client behavior (`src/osiris/`)

- Each request has an 8-second timeout. The Function has a 10-second upstream timeout and a 16 MB response cap.
- Layer results are cached in memory for 60 seconds.
- Each layer refreshes on its own schedule: flights every 1 minute, earthquakes every 2 minutes, news and GDELT every 5 minutes, fires, weather, and satellites every 10 minutes.
- Feed items are not stored in the workspace unless promoted.
- Every upstream value shown in a map popup is escaped (`escapeHtml`).

## Features

**Live Feeds (Map tab).** A panel with a checkbox, item count, and retry button for each layer. It shows "Osiris online" or "unreachable". That indicator checks `/api/earthquakes`, which the keyless fallback answers, so it reads "online" even when no Osiris is connected.

**Promote to case.** A button in a feed item's popup creates an incident in the active case. The incident gets the item's coordinates, time (or the promotion time when the feed has none), a severity mapped from the feed, clearance UNCLASSIFIED, and a description with the layer, source URL, feed item ID, and upstream severity. The incident has no `source` field, and promotion writes no audit entry.

**Watch rules (Signals tab).** Up to five rules per case. Each names a layer and may add a minimum severity, a keyword, or a maximum distance from any incident. All set criteria must match. A run fetches each layer once and adds a NEW signal for each new match, deduplicated by feed item ID. Runs start from the Run button, or automatically every five minutes while the auto-run checkbox is ticked and the tab is open. The verdict is rule-based.

**Enrichment.** The entity detail view offers all four lookups, and Explorer offers sanctions. The input comes from the entity's name or a property:

| Kind | Input |
|---|---|
| Sanctions | Entity name |
| Wallet | Property whose key contains `wallet` or `address`, 20 to 120 alphanumeric characters |
| WHOIS | Property whose key contains `domain` (host name is extracted) |
| IP | Property named `ip`, `ipv4`, `ipv6`, or similar, in IPv4 or IPv6 form |

A result is saved as a short summary in `entity.properties.osint_<kind>`. Example: `MATCH: 2 hits (checked 2026-11-05)`. The raw response is not stored. Each lookup writes an `ENRICH` audit entry.

**Classified data gate.** Any entity above UNCLASSIFIED is refused unless the user confirms "Send anyway" in a dialog. Declining sends nothing and is audited. The audit entry for a classified entity holds the entity ID, not its name.

**Global Ops.** The user enters an https address, which is kept in sessionStorage for the tab's session. It is shown in a sandboxed frame with `allow-scripts allow-same-origin allow-popups`. The frame is a separate origin and cannot read this app's storage. Many sites refuse to be framed, and the frame then appears blank; the tab offers an "Open in new tab" link. The CSP allows framing any `https:` origin.

## Environment variables

| Name | Read by | Purpose |
|---|---|---|
| `OSIRIS_URL` | Pages Function (dashboard or shell), Vite dev proxy (shell) | Base URL of a self-hosted Osiris. Must be http(s). No query, fragment, or credentials. A path prefix is allowed. Must not be this Pages site. Unset means keyless fallbacks. |
| Keys in `.env` (see `.env.example`: `FIRMS_API_KEY`, `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET`, `N2YO_API_KEY`, `AIS_API_KEY`) | Osiris container only (Docker `env_file`) | Feed keys for the self-hosted Osiris. This app does not read them. The scanner settings are intentionally omitted. |

Rules:

- Never prefix a secret with `VITE_`. Anything prefixed with `VITE_` is compiled into the public bundle.
- Feed and LLM keys belong to the Osiris deployment, never to this app or the browser.
- Keep real values out of git. `.env` and `.env.*` are ignored, and only `.env.example` is committed.

## Risks and decisions

- **Classified data leaving the browser.** Enrichment sends entity names, wallets, domains, or IPs to external services through Osiris. The confirmation dialog is the only gate. Treat it as a policy control, not a technical boundary.
- **Untrusted feed data.** Feed content is escaped before it is rendered. Do not add rendering that interprets it as HTML.
- **Third-party pages.** Global Ops shows a page the app does not control. The sandbox limits it, but the frame can still show anything the page serves, including forms.
- **Reliability.** Public feeds rate-limit and change. The client shows a per-layer error with retry, and the function caps upstream time and size. The EONET weather payload is large and can time out.
- **Attribution.** OpenSanctions data is CC BY 4.0 and needs attribution wherever its results appear. The app does not show it yet.
- **Scanning.** RECON (port and vulnerability scanning) is out of scope and not present. Keep scanning off unless an operator enables it deliberately.
- **Image pinning.** `docker-compose.yml` uses `ghcr.io/simplifaisoul/osiris:latest` and needs a tag or digest before real use.

## Limitations

- Osiris response shapes, OSINT query parameter names, and the bounding-box format are unverified. The normalizers accept several shapes and drop anything else.
- Without `OSIRIS_URL`, only the earthquake and weather layers return data. The Osiris health indicator still shows online (see above).
- The `weather` layer uses NASA EONET events, not Osiris weather data.
- Osiris's license and data-source terms were not checked in this pass.

## Checklist before enabling the integration

- [ ] Osiris image pinned to a tag or digest, and its license notice included
- [ ] `.env.example` contains placeholders only; no real keys in git or the bundle
- [ ] Feed response shapes checked against a live Osiris, and the normalizers tightened
- [ ] Per-layer source terms reviewed and recorded
- [ ] OpenSanctions attribution shown wherever its data appears
- [ ] Scanner and camera features disabled
- [ ] Classified-data gate tested for enrichment with a classified entity
- [ ] Upstream failures reviewed in the UI (per-layer error states)
