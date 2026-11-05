/**
 * Browser proxy for Cloudflare Pages: a reader-view fetcher for third-party pages.
 *
 *   GET /browse?url=<http(s) URL>          text/html  -> JSON { finalUrl, title, html, status }
 *                                          other type -> JSON { type, size, url, status }
 *   GET /browse?asset=1&url=<http(s) URL>  raster image (png, jpeg, gif, webp, avif) -> image bytes
 *
 * Why this exists: proxied pages must never run on the app's origin, where the app keeps user
 * data in cookies. Nothing from the target is ever executed or injected as markup here or in the
 * browser: the HTML returned is sanitised (below) and BrowserTab then rebuilds it as React
 * elements from an allowlist.
 *
 * Safety rules:
 *   - Target URLs are checked by src/browser/ssrfGuard.ts, for the initial URL and every redirect hop.
 *   - Redirects are followed by hand (redirect: 'manual'), at most 5 hops, each re-checked.
 *   - No cookies, Authorization or client headers go upstream. The User-Agent is fixed.
 *   - GET only. 10 s total timeout. 2 MB body cap for HTML, 3 MB for images.
 *   - HTML is sanitised with HTMLRewriter: active and embedding elements are removed, every
 *     attribute outside a small allowlist is dropped, links become data-aegis-href, and images
 *     are rewritten to this function's ?asset=1 mode.
 *   - Rate limit per client IP: 30 page requests per minute, 240 image requests per minute.
 *     This is best-effort: each isolate keeps its own counter.
 *   - Errors are JSON with fixed messages. Upstream bodies and stack traces are never echoed.
 */
import type { PagesFunction } from '@cloudflare/workers-types'
import { checkTargetUrl, MAX_URL_LENGTH } from '../../src/browser/ssrfGuard'

const USER_AGENT = 'AegisNexusBrowser/1.0'
const TIMEOUT_MS = 10_000
const MAX_HTML_BYTES = 2 * 1024 * 1024
const MAX_ASSET_BYTES = 3 * 1024 * 1024
const MAX_REDIRECTS = 5
const MAX_IMAGES_PER_PAGE = 60
const MAX_TITLE_LENGTH = 200
const PAGE_PER_MINUTE = 30
const ASSET_PER_MINUTE = 240
const RATE_WINDOW_MS = 60_000

const PAGE_ACCEPT = 'text/html;q=1,*/*;q=0.5'
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,image/avif;q=1,*/*;q=0.1'
const REDIRECT_CODES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308])
const RASTER_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
])

/** Attributes that survive sanitisation. Everything else (style, class, id, on*, srcset...) is dropped. */
const ALLOWED_ATTRS: ReadonlySet<string> = new Set(['title', 'alt', 'lang', 'dir', 'colspan', 'rowspan', 'datetime'])

/** Elements removed together with their content. */
const REMOVE_TAGS: ReadonlySet<string> = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'param', 'portal',
  'noscript', 'template', 'svg', 'math', 'video', 'audio', 'source', 'track', 'canvas',
  'form', 'input', 'button', 'select', 'textarea', 'option',
  'link', 'meta', 'base',
])

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'private, no-store',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
}

const HTML_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox"
const IMAGE_CSP = "default-src 'none'; sandbox"

class ProxyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly reason?: string,
  ) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// Entry point

export const onRequest: PagesFunction = async ({ request }) => {
  const url = new URL(request.url)
  if (request.method !== 'GET') {
    return errorResponse(405, 'method_not_allowed', 'Only GET is supported.', { Allow: 'GET' })
  }

  const isAsset = url.searchParams.get('asset') === '1'
  const limited = !allowRequest(`${isAsset ? 'asset' : 'page'}:${clientKey(request)}`, isAsset ? ASSET_PER_MINUTE : PAGE_PER_MINUTE)
  if (limited) {
    return errorResponse(429, 'rate_limited', 'Too many requests. Wait a minute and try again.', { 'Retry-After': '60' })
  }

  const raw = url.searchParams.get('url')
  if (raw === null || raw.length > MAX_URL_LENGTH) {
    return errorResponse(400, 'missing_url', 'Provide an http or https address in the url parameter.')
  }
  const check = checkTargetUrl(raw, { selfOrigin: url.origin })
  if (!check.ok) {
    return errorResponse(400, 'blocked_url', 'That address is not allowed through the browser proxy.', undefined, check.reason)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return isAsset
      ? await serveAsset(check.url, url.origin, controller.signal)
      : await servePage(check.url, url.origin, controller.signal)
  } catch (err) {
    if (err instanceof ProxyError) {
      return errorResponse(err.status, err.code, err.message, undefined, err.reason)
    }
    if (controller.signal.aborted) {
      return errorResponse(504, 'upstream_timeout', 'The site took too long to respond.')
    }
    return errorResponse(502, 'upstream_unavailable', 'The site could not be reached.')
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Pages and assets

async function servePage(target: URL, selfOrigin: string, signal: AbortSignal): Promise<Response> {
  const { response, finalUrl } = await fetchFollowingRedirects(target, selfOrigin, signal, PAGE_ACCEPT)
  const type = mediaType(response.headers.get('Content-Type'))

  if (type !== 'text/html') {
    // Not rendered. Report metadata only; the body is never read.
    const declared = Number(response.headers.get('Content-Length'))
    await response.body?.cancel()
    return jsonResponse(200, {
      type: type || 'unknown',
      size: Number.isFinite(declared) && declared >= 0 ? declared : null,
      url: finalUrl.href,
      status: response.status,
    })
  }

  const bytes = await readCapped(response, MAX_HTML_BYTES)
  const source = decodeText(bytes, charsetOf(response.headers.get('Content-Type')))
  const { html, title } = await sanitizeHtml(source, finalUrl)
  return jsonResponse(200, { finalUrl: finalUrl.href, title, html, status: response.status }, { 'Content-Security-Policy': HTML_CSP })
}

async function serveAsset(target: URL, selfOrigin: string, signal: AbortSignal): Promise<Response> {
  const { response } = await fetchFollowingRedirects(target, selfOrigin, signal, IMAGE_ACCEPT)
  const type = mediaType(response.headers.get('Content-Type'))
  if (!RASTER_TYPES.has(type)) {
    await response.body?.cancel()
    throw new ProxyError(415, 'not_an_image', 'That address is not a supported image.')
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new ProxyError(502, 'upstream_error', 'The image is not available.')
  }
  const bytes = await readCapped(response, MAX_ASSET_BYTES)
  return new Response(bytes, {
    status: 200,
    headers: {
      ...SECURITY_HEADERS,
      'Content-Type': type,
      'Content-Length': String(bytes.byteLength),
      'Content-Security-Policy': IMAGE_CSP,
    },
  })
}

// ---------------------------------------------------------------------------
// Upstream fetch

/**
 * Fetches a URL without following redirects. Each Location is resolved against the current
 * hop and checked again before the next request, so a redirect cannot reach a blocked address.
 */
async function fetchFollowingRedirects(
  start: URL,
  selfOrigin: string,
  signal: AbortSignal,
  accept: string,
): Promise<{ response: Response; finalUrl: URL }> {
  let current = start
  for (let hop = 0; ; hop++) {
    const response = await fetch(current.href, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT, Accept: accept },
      signal,
    })
    if (!REDIRECT_CODES.has(response.status)) return { response, finalUrl: current }

    await response.body?.cancel()
    if (hop >= MAX_REDIRECTS) {
      throw new ProxyError(508, 'too_many_redirects', 'The site redirected too many times.')
    }
    const location = response.headers.get('Location')
    if (!location) throw new ProxyError(502, 'bad_redirect', 'The site sent a redirect with no destination.')
    const next = checkTargetUrl(location, { base: current, selfOrigin })
    if (!next.ok) {
      throw new ProxyError(400, 'blocked_redirect', 'A redirect pointed to an address that is not allowed.', next.reason)
    }
    current = next.url
  }
}

/** Reads a body into memory, refusing anything over the cap (checked by header and while streaming). */
async function readCapped(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('Content-Length'))
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel()
    throw new ProxyError(502, 'too_large', 'The response is too large to show.')
  }
  if (!response.body) return new Uint8Array(0)

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done || !value) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      throw new ProxyError(502, 'too_large', 'The response is too large to show.')
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

// ---------------------------------------------------------------------------
// HTML sanitisation (HTMLRewriter runs on the response stream)

async function sanitizeHtml(source: string, base: URL): Promise<{ html: string; title: string }> {
  let rawTitle = ''
  let images = 0

  const rewriter = new HTMLRewriter()
    .on('title', {
      text(chunk) {
        if (rawTitle.length < MAX_TITLE_LENGTH * 2) rawTitle += chunk.text
      },
    })
    .on('*', {
      element(el) {
        const tag = el.tagName.toLowerCase()
        if (REMOVE_TAGS.has(tag)) {
          el.remove()
          return
        }

        // Read what is needed before attributes are stripped.
        const href = tag === 'a' ? resolveHttp(el.getAttribute('href'), base) : null
        const imageSource = tag === 'img' ? resolveHttp(el.getAttribute('src'), base) : null

        const names = [...el.attributes].map((attr) => attr[0] ?? '')
        for (const name of names) {
          if (name && !ALLOWED_ATTRS.has(name)) el.removeAttribute(name)
        }

        if (tag === 'a') {
          if (href) el.setAttribute('data-aegis-href', href)
        } else if (tag === 'img') {
          images += 1
          if (!imageSource || images > MAX_IMAGES_PER_PAGE) {
            el.remove()
            return
          }
          el.setAttribute('src', assetPath(imageSource))
        }
      },
    })

  const transformed = rewriter.transform(
    new Response(source, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
  )
  const html = await transformed.text()
  return { html, title: cleanTitle(rawTitle) }
}

/** Resolves a reference against the page URL. Only http(s) results are returned. */
function resolveHttp(value: string | null, base: URL): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return null
  try {
    const resolved = new URL(trimmed, base)
    return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.href : null
  } catch {
    return null
  }
}

function assetPath(target: string): string {
  return `/browse?asset=1&url=${encodeURIComponent(target)}`
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** Collapses whitespace and decodes the common entities in the raw <title> text. */
function cleanTitle(raw: string): string {
  const decoded = raw.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
  return decoded.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH)
}

// ---------------------------------------------------------------------------
// Helpers

function mediaType(header: string | null): string {
  return header?.split(';')[0]?.trim().toLowerCase() ?? ''
}

function charsetOf(header: string | null): string | null {
  const match = /charset=["']?([^;"'\s]+)/i.exec(header ?? '')
  return match?.[1] ?? null
}

function decodeText(bytes: Uint8Array, charset: string | null): string {
  try {
    return new TextDecoder(charset ?? 'utf-8').decode(bytes)
  } catch {
    // Unknown charset label: fall back to UTF-8, which never throws in non-fatal mode.
    return new TextDecoder('utf-8').decode(bytes)
  }
}

/** Best-effort fixed-window counter. Resets when the isolate restarts. */
const buckets = new Map<string, { count: number; resetAt: number }>()

function allowRequest(key: string, limit: number, now = Date.now()): boolean {
  if (buckets.size > 10_000) {
    for (const [k, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(k)
    }
    if (buckets.size > 10_000) buckets.clear()
  }
  const bucket = buckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS })
    return true
  }
  if (bucket.count >= limit) return false
  bucket.count += 1
  return true
}

function clientKey(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'unknown'
}

function jsonResponse(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, ...extra, 'Content-Type': 'application/json; charset=utf-8' },
  })
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  extra: Record<string, string> = {},
  reason?: string,
): Response {
  const body: Record<string, unknown> = { error: code, message, status }
  if (reason) body.reason = reason
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, ...extra, 'Content-Type': 'application/json; charset=utf-8' },
  })
}
