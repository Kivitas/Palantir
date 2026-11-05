# Deploying Aegis Nexus to Cloudflare Pages

Aegis Nexus is deployed as a **static Vite build** (`dist/`) plus two **Pages Functions**: a same-origin gateway for `/osiris/api/*`, and a sanitising proxy for the Browser tab at `/browse`. There is no server-side storage and no authentication. User data lives in the browser: the workspace in cookies, and AI keys and the Global Ops address in sessionStorage.

What this means for the public deployment:

- The site is public static. Anyone with the URL can load the app and the two Functions.
- Each visitor gets an empty workspace in their own browser. They cannot see another visitor's data, and you cannot see theirs. Anyone with access to a browser profile can read that profile's data.
- Do not put sensitive data in this app. Nothing is encrypted, and nothing is protected by a server.

Localhost and Docker are for development and optional self-hosting only. They are not part of the Cloudflare deployment.

## What gets deployed

| Piece | Source | Notes |
|---|---|---|
| Static app | `npm run build` -> `dist/` | `index.html`, hashed assets, and `public/` copied as-is |
| Security headers | `public/_headers` | CSP, nosniff, frame denial, referrer policy, permissions policy, HSTS |
| SPA fallback | `public/_redirects` | `/* /index.html 200` |
| Function routing | `public/_routes.json` | `include: ["/osiris/*", "/browse*"]`. Only these paths run a function. |
| Osiris gateway | `functions/osiris/[[path]].ts` | Allowlisted routes; proxy or keyless fallback |
| Browser proxy | `functions/browse/[[path]].ts` | Fetches third-party pages for the Browser tab. See [Browser proxy](#browser-proxy-browse) |
| Project config | `wrangler.toml` | Name `aegis-nexus`, output `dist`, compatibility date `2026-01-01` |

## Deploy in 3 steps (Git, recommended)

1. **Connect the repository.** In the Cloudflare dashboard, go to **Workers & Pages > Create > Pages > Connect to Git** and select this repository. Root directory: blank (the repository root).
2. **Set the build.** Build command `npm run build`. Build output directory `dist`. Use Node.js 22 or newer: set `NODE_VERSION=22` under environment variables if the build image's default is older. Framework preset can be None.
3. **Optional: set `OSIRIS_URL`** under **Settings > Environment variables** (see [Environment variables](#environment-variables)). Leave it unset to use the keyless fallbacks.

Then save and deploy. Every push to the production branch redeploys, and other branches get preview deployments.

The repository's `wrangler.toml` sets the project name (`aegis-nexus`), `pages_build_output_dir = "dist"`, and the compatibility date. `public/_headers`, `public/_redirects`, and `public/_routes.json` are copied into `dist/` by the build. The functions are in `functions/` at the repository root.

## Option B: deploy from the command line with Wrangler

Requirements: Node.js 22+, a Cloudflare account, and `npx wrangler login` once.

```bash
npm ci
npm run pages:deploy      # runs `npm run build`, then `wrangler pages deploy dist`
```

Run these from the repository root. `pages:deploy` is the script in `package.json`, and `wrangler.toml` names the project `aegis-nexus`.

Verification status: for the 2026-11-05 docs update, `npx vitest run` passed (113 tests). The build and the deploy were not run for that update. The Git build, Functions routing, and header delivery have not been confirmed against a live deployment from this repository.

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

## Browser proxy (`/browse`)

`functions/browse/[[path]].ts` serves the Browser tab. The tab shows the page as a reader view, so the proxy's job is to fetch a page and return sanitised HTML. Nothing from the target is run on the app's origin. The address checks live in `src/browser/ssrfGuard.ts`, which the function imports.

Routes:

| Request | Response |
|---|---|
| `GET /browse?url=<http(s) URL>` | `text/html`: JSON `{ finalUrl, title, html, status }` with sanitised HTML. Any other type: metadata only, `{ type, size, url, status }`, and the body is not read. |
| `GET /browse?asset=1&url=<URL>` | PNG, JPEG, GIF, WebP, or AVIF image bytes. Anything else gets 415. |
| Other methods | 405 |

Address checks, applied to the first URL and to every redirect hop:

- Only `http:` and `https:`. No user:password in the address. Ports 80 and 443 only. At most 2,048 characters. No whitespace, control characters, or backslashes.
- IPv6 literals are refused. So are single-label hosts, numeric or hex last labels (non-canonical IP forms), `localhost`, `metadata`, `metadata.google.internal`, and names ending in `.localhost`, `.local`, `.internal`, `.localdomain`, `.lan`, `.home.arpa`, `.intranet`, `.corp`, or `.private`.
- IPv4 addresses in 0/8, 10/8, 127/8, 100.64/10, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, and everything from 224.0.0.0 up are refused. Decimal, hex, and octal IPv4 forms are normalised first, so they are checked as their dotted form.

Fetching:

- Redirects are followed by hand, at most 5 hops, and each `Location` is checked again.
- 10 second total timeout. HTML is capped at 2 MB and images at 3 MB. The `Content-Length` header and the streamed body are both checked.
- The only headers sent upstream are a fixed `User-Agent: AegisNexusBrowser/1.0` and `Accept`. No cookies, no `Authorization`, no referrer.
- Rate limit: 30 page requests and 240 image requests per minute, per `CF-Connecting-IP`. The counter lives in memory in each isolate, so it is best-effort. A limited request gets 429 with `Retry-After: 60`.

Sanitising (HTMLRewriter):

- Removed with their content: `script`, `style`, `iframe`, `object`, `embed`, `form`, `input`, `button`, `select`, `textarea`, `svg`, `math`, `video`, `audio`, `canvas`, `noscript`, `template`, `link`, `meta`, `base`, and a few others.
- Only `title`, `alt`, `lang`, `dir`, `colspan`, `rowspan`, and `datetime` attributes survive. Links are rewritten to `data-aegis-href`. Up to 60 images per page are rewritten to the `asset=1` route, and the rest are removed.
- Responses carry their own CSP (`default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox`), `no-store`, `nosniff`, and `Cross-Origin-Resource-Policy: same-origin`.
- The browser then rebuilds the page as React elements from an allowlist (`src/browser/readerTree.ts`, `ReaderView.tsx`). No HTML markup is inserted, and no script runs.

Errors are JSON `{ error, message, status }` with fixed messages. Upstream bodies and stack traces are never returned. Codes: `missing_url` and `blocked_url` (400, with a `reason` such as `private_ipv4` or `userinfo`), `blocked_redirect` (400), `not_an_image` (415), `rate_limited` (429), `bad_redirect`, `upstream_error`, `upstream_unavailable`, and `too_large` (502), `upstream_timeout` (504), `too_many_redirects` (508).

The browser sends the request with `credentials: 'omit'` and `referrerPolicy: 'no-referrer'`. The site can see the proxy's address, not the user's.

Open gaps. These are not closed in this repository:

- **DNS.** The address check reads the URL text only. A public-looking name that resolves to a private or internal address is not refused by the code. The same applies to DNS rebinding, where a name resolves publicly at check time and privately at fetch time. Only the Workers runtime's egress would stop that, and this repo does not test it. Before offering the proxy beyond a trusted audience, test from the deployed site with a name that resolves to a private address.
- **Rate limiting.** The per-isolate counter is not a real limit. Add a Cloudflare WAF rate-limiting rule for the path `/browse*` in the Cloudflare dashboard. That rule is not in the repository.
- **Terms of service.** Proxying third-party pages may breach a site's terms, and automated fetching may be restricted. Check the terms of each source before offering it. This has not been reviewed.

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

- `frame-src https:` is broader than the Global Ops tab needs. It lets the app embed any https page. Narrow it if Global Ops is not needed. The Browser tab does not use a frame.
- The Browser tab needs no CSP change. Its requests and images are same-origin (`connect-src 'self'`, `img-src 'self'`). The proxied HTML is rendered as React elements, not as a frame.
- `connect-src` lists the AI providers because the browser calls them directly. Removing a provider here makes that provider's requests fail.
- If you add a tile or API host, add it to the matching directive.

## Data handling

- No server-side database, object store, or session store is used.
- The workspace (cases, entities, incidents, relationships, signals, watch rules, settings, and the audit log) is stored in **cookies** named `aegis_ws_*`. There are no accounts and no password data. The site has a 16,000-byte Cookie header budget, including all of its cookies.
- AI API keys are in **sessionStorage** and are cleared when the tab closes. The Browser tab's first-use consent (`aegis_browser_consent`) is there too.
- Browser tab bookmarks (up to 20, URLs and titles only) are in **cookies** (`aegis_bm`), inside the same 16,000-byte budget. An older `aegis_browser_bookmarks` copy in localStorage is moved once.
- Cookies are sent with every request to the site, including static files, `/osiris/api/*` calls, and `/browse` calls. Neither function forwards them upstream.
- Cookies are set `SameSite=Strict`, with `Secure` on https, and last one year. They are not `HttpOnly`, so any script running on the site can read them.
- Data is per browser. Clearing cookies deletes the workspace. Nothing is backed up server-side.
- There is no authentication. Access is whatever the browser profile allows, and the deployed URL is public. See the README's [Access and clearance](../README.md#access-and-clearance) and Known limitations before using the deployment for anything sensitive.

## Troubleshooting

- **Build fails with `tsc` errors:** `npm run build` runs `tsc -b` on `src/` first. Fix the reported files, or check that the Node version is 22+.
- **`/osiris/...` returns 404 HTML:** `_routes.json` must be in the published output. `public/_routes.json` is copied into `dist/`. Confirm it exists there.
- **`/osiris/api/weather` returns 504:** the NASA EONET feed is large and can be slow. The function gives up after 10 seconds. The Live Feeds panel shows a per-layer "failed" with Retry, and the rest of the app keeps working.
- **`/osiris/...` returns 500 `misconfigured`:** `OSIRIS_URL` is set but is not a valid http(s) base URL, has a query, fragment, or credentials, or points at this Pages site.
- **`/osiris/...` returns 501 `not_configured`:** the route needs a self-hosted Osiris. Set `OSIRIS_URL`.
- **Map tiles or search blocked in the browser console:** a CSP violation. Add the host to `public/_headers`.
- **Storage banner: "Cookie storage is full":** the workspace exceeds the budget. Export a backup from Settings > Backup and restore, then delete old cases or audit entries. Audit entries are also trimmed automatically.
- **Global Ops frame is blank:** the site refuses to be framed. Use the "Open in new tab" link.
- **`/browse` returns 404 HTML:** `_routes.json` must include `/browse*`, and the file must be in `dist/`. Without it, the SPA fallback in `_redirects` answers.
- **Browser tab says "could not be reached" or 429:** the site did not answer within 10 seconds, or the per-isolate rate limit was hit. Wait a minute and try again.
