/**
 * Osiris same-origin gateway for Cloudflare Pages.
 *
 * Handles GET/HEAD/OPTIONS on /osiris/api/<route>. The browser only ever talks to
 * this function (same origin), never to Osiris or a third-party feed directly.
 *
 * Modes, chosen by the OSIRIS_URL environment variable (set in the Pages dashboard
 * or in wrangler.toml for local runs; optional):
 *   - OSIRIS_URL set:   proxy an allowlisted route to that self-hosted Osiris base URL.
 *   - OSIRIS_URL unset: serve keyless built-in fallbacks for a few public feeds
 *                       (earthquakes via USGS, weather via NASA EONET); other routes
 *                       return 501 JSON.
 *
 * Safety rules:
 *   - Only routes in the allowlists below are reachable. Never an open proxy.
 *   - Upstream URLs are fixed by code or by OSIRIS_URL; client input never picks a host.
 *   - Only the Accept header is sent upstream: no cookies, no Authorization, no client headers.
 *   - Redirects from upstream are not followed.
 *   - 10 s timeout and a size cap on upstream bodies.
 *   - Same-origin CORS only: no Access-Control-Allow-Origin is sent to other origins.
 *   - Errors are JSON and do not echo upstream bodies or stack traces.
 */
import type { PagesFunction } from '@cloudflare/workers-types'

interface Env {
  /** Optional. Base URL of a self-hosted Osiris, e.g. https://osiris.example.com (no path, query or credentials). */
  OSIRIS_URL?: string
}

type JsonRecord = Record<string, unknown>

const UPSTREAM_TIMEOUT_MS = 10_000
const MAX_UPSTREAM_BYTES = 16 * 1024 * 1024 // capped EONET query (30 days, 500 events) is well under this
const MAX_QUERY_PARAMS = 10
const MAX_QUERY_VALUE_LENGTH = 256
const MAX_FALLBACK_FEATURES = 500
const CACHE_OK = 'public, s-maxage=60'
const ALLOWED_METHODS = 'GET, HEAD, OPTIONS'

const USGS_EARTHQUAKES_URL = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson'
const NASA_EONET_EVENTS_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=30&limit=500'

/** Routes (path after /osiris/api/) this function will ever touch. Matches the client's feed and OSINT endpoints. */
const PROXY_ROUTES: ReadonlySet<string> = new Set([
  'earthquakes',
  'flights',
  'fires',
  'weather',
  'gdelt',
  'news',
  'satellites',
  'osint/sanctions',
  'osint/crypto',
  'osint/whois',
  'osint/ip',
])

/** Routes that have a keyless built-in fallback when OSIRIS_URL is not set. */
const FALLBACK_ROUTES: ReadonlySet<string> = new Set(['earthquakes', 'weather'])

const QUERY_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/
/** True if the value contains a C0 control character or DEL (same set as /[\u0000-\u001f\u007f]/). */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// Entry point

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context
  const url = new URL(request.url)
  const method = request.method.toUpperCase()

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: baseHeaders(request, url, { Allow: ALLOWED_METHODS }) })
  }
  if (method !== 'GET' && method !== 'HEAD') {
    return errorResponse(request, url, new HttpError(405, 'method_not_allowed', 'Only GET, HEAD and OPTIONS are supported.'), {
      Allow: ALLOWED_METHODS,
    })
  }

  try {
    const route = parseRoute(url.pathname)
    if (route === null || !PROXY_ROUTES.has(route)) {
      throw new HttpError(404, 'not_found', 'Unknown Osiris route.')
    }

    const upstream = parseUpstream(env.OSIRIS_URL, url)
    const query = sanitizeQuery(url.searchParams)

    let response: Response
    if (upstream) {
      response = await proxyToOsiris(upstream, route, query)
    } else if (FALLBACK_ROUTES.has(route)) {
      response = await serveFallback(route)
    } else {
      throw new HttpError(
        501,
        'not_configured',
        'This feed needs a self-hosted Osiris instance. Set the OSIRIS_URL environment variable to enable it.',
      )
    }

    return finish(request, url, method, response)
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(request, url, err)
    return errorResponse(request, url, new HttpError(500, 'internal_error', 'Unexpected error.'))
  }
}

// ---------------------------------------------------------------------------
// Routing and configuration

/** "/osiris/api/earthquakes" -> "earthquakes"; anything else -> null. */
function parseRoute(pathname: string): string | null {
  const match = /^\/osiris\/api\/(.+?)\/?$/.exec(pathname)
  return match ? (match[1] ?? null) : null
}

/**
 * Returns the validated upstream base URL, null when OSIRIS_URL is unset, or throws
 * a 500 when it is set but unusable (never silently falls back in that case).
 */
function parseUpstream(raw: string | undefined, requestUrl: URL): URL | null {
  const value = raw?.trim()
  if (!value) return null

  let base: URL
  try {
    base = new URL(value)
  } catch {
    throw misconfigured()
  }
  const ok =
    (base.protocol === 'https:' || base.protocol === 'http:') &&
    !base.username &&
    !base.password &&
    !base.search &&
    !base.hash &&
    base.origin !== requestUrl.origin // never loop back into this Pages project
  if (!ok) throw misconfigured()
  return base
}

function misconfigured(): HttpError {
  return new HttpError(500, 'misconfigured', 'OSIRIS_URL is set but is not a valid http(s) base URL.')
}

/** Keep a small set of well-formed query parameters; drop everything else. */
function sanitizeQuery(params: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams()
  let count = 0
  for (const [key, value] of params) {
    if (count >= MAX_QUERY_PARAMS) break
    if (!QUERY_KEY_RE.test(key)) continue
    if (value.length > MAX_QUERY_VALUE_LENGTH || hasControlChars(value)) continue
    out.append(key, value)
    count += 1
  }
  return out
}

// ---------------------------------------------------------------------------
// Proxy mode

async function proxyToOsiris(base: URL, route: string, query: URLSearchParams): Promise<Response> {
  const basePath = base.pathname.replace(/\/+$/, '')
  const target = new URL(`${base.origin}${basePath}/api/${route}`)
  target.search = query.toString()

  const upstream = await fetchUpstream(target.toString(), 'application/json')
  if (!upstream.ok) {
    throw new HttpError(502, 'upstream_error', `Osiris responded with HTTP ${upstream.status}.`)
  }
  const text = upstream.text
  try {
    JSON.parse(text)
  } catch {
    throw new HttpError(502, 'upstream_invalid_json', 'Osiris returned a non-JSON response.')
  }
  return new Response(text, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } })
}

// ---------------------------------------------------------------------------
// Keyless fallbacks (used only when OSIRIS_URL is unset)

async function serveFallback(route: string): Promise<Response> {
  if (route === 'earthquakes') {
    const data = await fetchFixedJson(USGS_EARTHQUAKES_URL)
    if (!isRecord(data) || !Array.isArray(data.features)) {
      throw new HttpError(502, 'upstream_invalid_shape', 'Unexpected earthquake feed format.')
    }
    return jsonOk(data)
  }

  if (route === 'weather') {
    const data = await fetchFixedJson(NASA_EONET_EVENTS_URL)
    return jsonOk(eonetToFeatureCollection(data))
  }

  throw new HttpError(501, 'not_implemented', 'No built-in fallback for this route.')
}

/** Reduce NASA EONET events to a GeoJSON FeatureCollection of point geometries. */
function eonetToFeatureCollection(data: unknown): JsonRecord {
  const events = isRecord(data) && Array.isArray(data.events) ? data.events : []
  const features: JsonRecord[] = []

  for (const event of events) {
    if (!isRecord(event)) continue
    const id = typeof event.id === 'string' ? event.id : undefined
    const title = typeof event.title === 'string' ? event.title : undefined
    const link = httpUrl(event.link)
    const category = firstCategoryTitle(event.categories)
    const geometries = Array.isArray(event.geometry) ? event.geometry : []

    for (const geometry of geometries) {
      if (!isRecord(geometry) || geometry.type !== 'Point' || !Array.isArray(geometry.coordinates)) continue
      const lon = Number(geometry.coordinates[0])
      const lat = Number(geometry.coordinates[1])
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) continue
      const time = typeof geometry.date === 'string' ? geometry.date : undefined

      features.push({
        type: 'Feature',
        id,
        title,
        url: link,
        time,
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: { id, title, url: link, time, category, source: 'NASA EONET' },
      })
      if (features.length >= MAX_FALLBACK_FEATURES) {
        return { type: 'FeatureCollection', source: 'NASA EONET', features }
      }
    }
  }

  return { type: 'FeatureCollection', source: 'NASA EONET', features }
}

function firstCategoryTitle(categories: unknown): string | undefined {
  if (!Array.isArray(categories)) return undefined
  const first = categories[0]
  return isRecord(first) && typeof first.title === 'string' ? first.title : undefined
}

async function fetchFixedJson(target: string): Promise<unknown> {
  const upstream = await fetchUpstream(target, 'application/json')
  if (!upstream.ok) {
    throw new HttpError(502, 'upstream_error', `Upstream feed responded with HTTP ${upstream.status}.`)
  }
  try {
    return JSON.parse(upstream.text) as unknown
  } catch {
    throw new HttpError(502, 'upstream_invalid_json', 'Upstream feed returned non-JSON.')
  }
}

// ---------------------------------------------------------------------------
// Upstream transport

interface UpstreamResult {
  ok: boolean
  status: number
  text: string
}

/**
 * Single GET with a fixed header set (Accept only), a timeout, no redirect following
 * and a body size cap. Never forwards anything from the client.
 */
async function fetchUpstream(target: string, accept: string): Promise<UpstreamResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS)
  try {
    const res = await fetch(target, {
      method: 'GET',
      headers: { Accept: accept },
      redirect: 'manual',
      signal: controller.signal,
    })
    if (!res.ok) return { ok: false, status: res.status, text: '' }
    const text = await readCapped(res, MAX_UPSTREAM_BYTES)
    return { ok: true, status: res.status, text }
  } catch (err) {
    if (err instanceof HttpError) throw err
    if (controller.signal.aborted) {
      throw new HttpError(504, 'upstream_timeout', 'Upstream request timed out.')
    }
    throw new HttpError(502, 'upstream_unavailable', 'Upstream request failed.')
  } finally {
    clearTimeout(timer)
  }
}

async function readCapped(res: Response, limit: number): Promise<string> {
  const declared = Number(res.headers.get('Content-Length') ?? '0')
  if (declared > limit) {
    await res.body?.cancel()
    throw new HttpError(502, 'upstream_too_large', 'Upstream response is too large.')
  }
  if (!res.body) return ''

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let received = 0
  let out = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    received += value.byteLength
    if (received > limit) {
      await reader.cancel()
      throw new HttpError(502, 'upstream_too_large', 'Upstream response is too large.')
    }
    out += decoder.decode(value, { stream: true })
  }
  return out + decoder.decode()
}

// ---------------------------------------------------------------------------
// Responses

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const u = new URL(value)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined
  } catch {
    return undefined
  }
}

/** Same-origin only: reflect Origin back only when it equals this function's own origin. */
function baseHeaders(request: Request, url: URL, extra: Record<string, string> = {}): Headers {
  const headers = new Headers({
    'X-Content-Type-Options': 'nosniff',
    'Cross-Origin-Resource-Policy': 'same-origin',
    Vary: 'Origin',
    ...extra,
  })
  const origin = request.headers.get('Origin')
  if (origin && origin === url.origin) {
    headers.set('Access-Control-Allow-Origin', origin)
  }
  return headers
}

/** Apply cache and content headers to a successful response; HEAD gets headers only. */
function finish(request: Request, url: URL, method: string, response: Response): Response {
  const headers = baseHeaders(request, url)
  headers.set('Content-Type', response.headers.get('Content-Type') ?? 'application/json; charset=utf-8')
  headers.set('Cache-Control', CACHE_OK)
  const body = method === 'HEAD' ? null : response.body
  return new Response(body, { status: response.status, headers })
}

function jsonOk(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

function errorResponse(request: Request, url: URL, err: HttpError, extra: Record<string, string> = {}): Response {
  const headers = baseHeaders(request, url, { ...extra, 'Cache-Control': 'no-store' })
  headers.set('Content-Type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify({ error: err.code, message: err.message, status: err.status }), {
    status: err.status,
    headers,
  })
}
