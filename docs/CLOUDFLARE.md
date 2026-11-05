# Deploying Aegis Nexus to Cloudflare Pages

Aegis Nexus is deployed as a **static Vite build** (`dist/`) plus a **Pages Function** that serves the same-origin `/osiris/api/*` routes. There is no server-side storage. User data lives in the browser: the workspace in cookies, and AI keys and the Global Ops address in sessionStorage.

Localhost and Docker are for development and optional self-hosting only. They are not part of the Cloudflare deployment.

## What gets deployed

| Piece | Source | Notes |
|---|---|---|
| Static app | `npm run build` -> `dist/` | `index.html`, hashed assets, and `public/` copied as-is |
| Security headers | `public/_headers` | CSP, nosniff, frame denial, referrer policy, permissions policy, HSTS |
| SPA fallback | `public/_redirects` | `/* /index.html 200` |
| Function routing | `public/_routes.json` | `include: ["/osiris/*"]`. Only these paths run the function. |
| Osiris gateway | `functions/osiris/[[path]].ts` | Allowlisted routes; proxy or keyless fallback |
| Project config | `wrangler.toml` | Name `aegis-nexus`, output `dist`, compatibility date `2026-01-01` |

## Option A: connect the Git repository (recommended)

1. In the Cloudflare dashboard, go to **Workers & Pages > Create > Pages > Connect to Git** and select this repository.
2. Set the build configuration:
   - **Framework preset:** None (or Vite)
   - **Build command:** `npm run build`
   - **Build output directory:** `dist`
   - **Root directory:** (blank, the repository root)
   - **Node.js version:** 22 or newer (set `NODE_VERSION=22` under environment variables if the default is older)
3. Optional: add `OSIRIS_URL` under **Settings > Environment variables** for Production and, if wanted, Preview (see below).
4. Save and deploy. Cloudflare runs `npm ci` (or `npm install`), then the build, then publishes `dist/` together with `functions/` and the `public/_*` files.

Every push to the production branch redeploys. Other branches get preview deployments.

## Option B: deploy from the command line with Wrangler

Requirements: Node.js 22+, a Cloudflare account, and `npx wrangler login` once.

```bash
npm ci
npm run pages:deploy      # runs `npm run build`, then `wrangler pages deploy dist`
```

The first deploy creates the Pages project `aegis-nexus` if it does not exist.

## Environment variables

| Name | Required | Where to set | Purpose |
|---|---|---|---|
| `OSIRIS_URL` | No | Pages dashboard (Settings > Environment variables), or the shell for local runs | Base URL of a self-hosted Osiris, for example `https://osiris.example.com`. Must be http(s). A path prefix is allowed. Query strings, fragments, and credentials are rejected, and it must not point at this Pages site. When unset, the function uses its keyless fallbacks. |
| `NODE_VERSION` | Only if the build image defaults to an old Node | Pages dashboard | Set to `22` |

Rules:

- Do **not** prefix any secret with `VITE_`. Those values are compiled into the public JavaScript bundle.
- Feed and LLM API keys belong to the Osiris deployment, never to this project.
- `OSIRIS_URL` is not a secret, but keep it out of git and set it in the dashboard.

### What works with and without `OSIRIS_URL`

| Route (`/osiris/api/...`) | `OSIRIS_URL` unset | `OSIRIS_URL` set |
|---|---|---|
| `earthquakes` | USGS 2.5-day GeoJSON feed (keyless) | Proxied to Osiris |
| `weather` | NASA EONET open events, reduced to point features (keyless) | Proxied to Osiris |
| `flights`, `fires`, `satellites`, `gdelt`, `news` | 501 `not_configured` | Proxied to Osiris |
| `osint/sanctions`, `osint/crypto`, `osint/whois`, `osint/ip` | 501 `not_configured` | Proxied to Osiris |
| Any other route | 404 `not_found` | 404 `not_found` |
| Methods other than GET, HEAD, OPTIONS | 405 | 405 |

Behavior of the function:

- Successful responses carry `Cache-Control: public, s-maxage=60`. Errors are `no-store`.
- The upstream timeout is 10 seconds. Upstream responses are capped at 16 MB. Upstream redirects are not followed.
- Only the `Accept` header is sent upstream. Cookies, authorization headers, and other client headers are never forwarded.
- CORS is same-origin only. No `Access-Control-Allow-Origin` is sent to other origins.
- Errors return JSON such as `{"error":"not_configured","message":"...","status":501}`, without upstream bodies or stack traces.
- A misconfigured `OSIRIS_URL` returns 500 `misconfigured`. The function never falls back silently in that case.

## Local preview

```bash
npm run build
npm run pages:dev        # wrangler pages dev dist, default port 8788
```

Use this instead of `npm run dev` when you want the Pages Function to run. `npm run dev` (Vite) only proxies `/osiris` if `OSIRIS_URL` is set in the shell, and that proxy bypasses the function's allowlist. Treat it as a development convenience.

Type-check the function separately from the app:

```bash
npm run typecheck:functions
```

## Custom domain and headers

- Add a custom domain under **Pages > aegis-nexus > Custom domains**. TLS is handled by Cloudflare.
- Changing domains starts a new, empty workspace. Cookies and sessionStorage are per origin.
- Verify headers after deploy: `curl -I https://<your-project>.pages.dev/`.

The CSP in `public/_headers` is:

| Directive | Allows | Why |
|---|---|---|
| `default-src`, `script-src`, `worker-src`, `manifest-src` | `'self'` (workers also `blob:`) | The app's own code only. No inline scripts. |
| `style-src` | `'self'`, `'unsafe-inline'`, `fonts.googleapis.com` | Styles and Google Fonts CSS |
| `font-src` | `'self'`, `fonts.gstatic.com`, `data:` | Google Fonts files |
| `img-src` | `'self'`, `data:`, `blob:`, `tile.openstreetmap.org`, `*.tile.opentopomap.org`, `server.arcgisonline.com` | Map tiles and Leaflet images |
| `connect-src` | `'self'`, `nominatim.openstreetmap.org`, `api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com`, `api.mistral.ai` | Place search, and direct browser calls to the four AI providers when the user sends an analysis |
| `frame-src` | `https:` | Global Ops frame, for any https page the user enters |
| `frame-ancestors` | `'none'` | The app cannot be framed (also `X-Frame-Options: DENY`) |
| `object-src`, `base-uri`, `form-action` | `'none'`, `'self'`, `'self'` | Standard hardening |

`upgrade-insecure-requests` is set. Permissions Policy denies camera, microphone, geolocation, payment, and USB. HSTS is set to one year.

Notes on the CSP:

- `frame-src https:` is broader than the Global Ops tab needs. It lets the app embed any https page. Narrow it if Global Ops is not needed.
- `connect-src` lists the AI providers because the browser calls them directly. Removing a provider here makes that provider's requests fail.
- If you add a tile or API host, add it to the matching directive.

## Data handling

- No server-side database, object store, or session store is used.
- The workspace (cases, entities, users and password hashes, settings, and the audit log) is stored in **cookies** named `aegis_ws_*`. The site has a 16,000-byte Cookie header budget, including all of its cookies.
- AI API keys are in **sessionStorage** and are cleared when the tab closes.
- Cookies are sent with every request to the site, including static files and `/osiris/api/*` calls. The function does not forward them upstream.
- Cookies are set `SameSite=Strict`, with `Secure` on https, and last one year. They are not `HttpOnly`, so any script running on the site can read them.
- Data is per browser. Clearing cookies deletes the workspace. Nothing is backed up server-side.
- Authentication is client-side only and is not a security boundary. See the README's Known limitations before using the deployment for anything sensitive.

## Troubleshooting

- **Build fails with `tsc` errors:** `npm run build` runs `tsc -b` on `src/` first. Fix the reported files, or check that the Node version is 22+.
- **`/osiris/...` returns 404 HTML:** `_routes.json` must be in the published output. `public/_routes.json` is copied into `dist/`. Confirm it exists there.
- **`/osiris/api/weather` returns 504:** the NASA EONET feed is large and can be slow. The function gives up after 10 seconds. The Live Feeds panel shows a per-layer "failed" with Retry, and the rest of the app keeps working.
- **`/osiris/...` returns 500 `misconfigured`:** `OSIRIS_URL` is set but is not a valid http(s) base URL, has a query, fragment, or credentials, or points at this Pages site.
- **`/osiris/...` returns 501 `not_configured`:** the route needs a self-hosted Osiris. Set `OSIRIS_URL`.
- **Map tiles or search blocked in the browser console:** a CSP violation. Add the host to `public/_headers`.
- **Storage banner: "Cookie storage is full":** the workspace exceeds the budget. There is no in-app backup button yet, and the app cannot delete audit entries (they are trimmed automatically). Delete old cases in the app to make room.
- **Global Ops frame is blank:** the site refuses to be framed. Use the "Open in new tab" link.
