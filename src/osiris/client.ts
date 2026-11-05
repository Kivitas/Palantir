import {
  CACHE_TTL_MS,
  LAYER_META,
  OSINT_ENDPOINTS,
  OSIRIS_BASE,
  REQUEST_TIMEOUT_MS,
  type OsintKind,
} from './config'
import type {
  BBox,
  FeedItem,
  FeedLayerId,
  FeedResult,
  FetchLayerOptions,
  OsintResult,
} from './types'

// TODO(osiris): response shapes are UNVERIFIED against the pinned Osiris release.
// The normalizers below accept several plausible shapes (GeoJSON FeatureCollection,
// bare arrays, {data: []}, OpenSky-style state arrays) and silently drop anything
// they cannot map. Check real responses from /api/<endpoint> and tighten once confirmed.
// bbox is sent as minLon,minLat,maxLon,maxLat (also unverified).

type Rec = Record<string, unknown>

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)

function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const part of path.split('.')) {
    if (!isRec(cur)) return undefined
    cur = cur[part]
  }
  return cur
}

/** First non-empty value among dotted paths. */
function pick(obj: unknown, paths: readonly string[]): unknown {
  for (const p of paths) {
    const v = getPath(obj, p)
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

function toNum(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

function toStr(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return undefined
}

function toSeverity(v: unknown): number | string | undefined {
  const n = toNum(v)
  if (n !== undefined) return n
  return toStr(v)
}

function toIsoTime(v: unknown): string | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Values below 1e11 are treated as epoch seconds, otherwise milliseconds.
    const d = new Date(v < 1e11 ? v * 1000 : v)
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
  }
  if (typeof v === 'string' && v.trim()) {
    const d = new Date(v)
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
  }
  return undefined
}

function toHttpUrl(v: unknown): string | undefined {
  const s = toStr(v)
  if (!s) return undefined
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined
  } catch {
    return undefined
  }
}

function validLat(v: number | undefined): number | undefined {
  return v !== undefined && v >= -90 && v <= 90 ? v : undefined
}

function validLon(v: number | undefined): number | undefined {
  return v !== undefined && v >= -180 && v <= 180 ? v : undefined
}

/** Pull the record list out of whatever envelope Osiris returns. */
function extractRecords(json: unknown, depth = 0): unknown[] {
  if (Array.isArray(json)) return json
  if (!isRec(json) || depth > 1) return []
  const containers = ['features', 'data', 'items', 'results', 'events', 'articles', 'states', 'records', 'entries']
  for (const key of containers) {
    const v = json[key]
    if (Array.isArray(v)) return v
  }
  for (const key of ['data', 'result']) {
    const inner = json[key]
    if (isRec(inner)) {
      const found = extractRecords(inner, depth + 1)
      if (found.length > 0) return found
    }
  }
  return []
}

/** OpenSky state vector: [icao24, callsign, origin, time_pos, last_contact, lon, lat, ...]. */
function arrayRecordToItem(layer: FeedLayerId, arr: unknown[], index: number): FeedItem | null {
  if (layer !== 'flights' || arr.length < 7) return null
  const icao = toStr(arr[0])
  const callsign = toStr(arr[1])
  return {
    id: `${layer}:${icao ?? index}`,
    layer,
    title: callsign ?? icao ?? 'Aircraft',
    lat: validLat(toNum(arr[6])),
    lon: validLon(toNum(arr[5])),
    time: toIsoTime(arr[4] ?? arr[3]),
    raw: arr,
  }
}

function recordToItem(layer: FeedLayerId, rec: unknown, index: number): FeedItem | null {
  if (Array.isArray(rec)) return arrayRecordToItem(layer, rec, index)
  if (!isRec(rec)) return null

  let lon: number | undefined
  let lat: number | undefined
  const geom = rec.geometry
  if (isRec(geom) && Array.isArray(geom.coordinates)) {
    lon = toNum(geom.coordinates[0])
    lat = toNum(geom.coordinates[1])
  }
  lat ??= toNum(pick(rec, ['lat', 'latitude', 'properties.lat', 'properties.latitude']))
  lon ??= toNum(pick(rec, ['lon', 'lng', 'longitude', 'properties.lon', 'properties.longitude']))

  const id = toStr(pick(rec, ['id', 'properties.id', 'uuid', 'guid', 'eventId', 'url'])) ?? String(index)
  const title =
    toStr(pick(rec, ['title', 'name', 'headline', 'place', 'properties.title', 'properties.place', 'properties.name'])) ??
    `${LAYER_META[layer].label} ${id}`

  const item: FeedItem = {
    id: `${layer}:${id}`,
    layer,
    title,
    lat: validLat(lat),
    lon: validLon(lon),
    time: toIsoTime(pick(rec, ['time', 'timestamp', 'date', 'updated', 'published', 'properties.time'])),
    url: toHttpUrl(pick(rec, ['url', 'link', 'sourceUrl', 'properties.url'])),
    severity: toSeverity(pick(rec, ['severity', 'magnitude', 'mag', 'properties.mag', 'confidence', 'priority', 'level'])),
    raw: rec,
  }
  return item
}

/** Map any plausible Osiris layer payload to FeedItem[]. Never throws. */
export function normalizeFeed(layer: FeedLayerId, json: unknown): FeedItem[] {
  try {
    const out: FeedItem[] = []
    extractRecords(json).forEach((rec, i) => {
      try {
        const item = recordToItem(layer, rec, i)
        if (item) out.push(item)
      } catch {
        // Skip a malformed record; keep the rest.
      }
    })
    return out
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Transport: timeout, caller abort, JSON parse, never throws.

type Outcome = { ok: true; json: unknown } | { ok: false; error: string }

function buildUrl(path: string, params?: Record<string, string>): string {
  const qs = params ? new URLSearchParams(params).toString() : ''
  return `${OSIRIS_BASE}${path}${qs ? `?${qs}` : ''}`
}

async function getJson(path: string, params: Record<string, string> | undefined, signal?: AbortSignal): Promise<Outcome> {
  if (signal?.aborted) return { ok: false, error: 'aborted' }

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, REQUEST_TIMEOUT_MS)
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const res = await fetch(buildUrl(path, params), {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const json: unknown = await res.json()
    return { ok: true, json }
  } catch (err) {
    if (timedOut) return { ok: false, error: `timeout after ${REQUEST_TIMEOUT_MS} ms` }
    if (signal?.aborted) return { ok: false, error: 'aborted' }
    return { ok: false, error: err instanceof Error ? err.message : 'network error' }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

// ---------------------------------------------------------------------------
// Feed cache: keyed by layer + (rounded) bbox, TTL CACHE_TTL_MS.

interface CacheEntry {
  expires: number
  result: FeedResult
}

const cache = new Map<string, CacheEntry>()
const CACHE_MAX_ENTRIES = 200

/**
 * Rounds a bbox to a fixed precision (~11 m at 4 decimals). The SAME rounded box is used for the
 * cache key and for the request, so two requests that share a key always ask for the same area.
 * (Rounding only the key let distinct views collapse onto one cached result.)
 */
const BBOX_DECIMALS = 4
function roundBBox(bbox: BBox): BBox {
  const r = (n: number) => Number(n.toFixed(BBOX_DECIMALS))
  return { minLat: r(bbox.minLat), minLon: r(bbox.minLon), maxLat: r(bbox.maxLat), maxLon: r(bbox.maxLon) }
}

function cacheKey(layer: FeedLayerId, bbox?: BBox): string {
  if (!bbox) return `${layer}|*`
  const b = roundBBox(bbox)
  return `${layer}|${[b.minLat, b.minLon, b.maxLat, b.maxLon].join(',')}`
}

function pruneCache(now: number): void {
  if (cache.size <= CACHE_MAX_ENTRIES) return
  for (const [k, v] of cache) {
    if (v.expires <= now) cache.delete(k)
  }
}

// ---------------------------------------------------------------------------

async function fetchLayer(layer: FeedLayerId, opts: FetchLayerOptions = {}): Promise<FeedResult> {
  const now = Date.now()
  const key = cacheKey(layer, opts.bbox)
  const hit = cache.get(key)
  if (hit && hit.expires > now) return hit.result

  const bbox = opts.bbox ? roundBBox(opts.bbox) : undefined
  const params = bbox
    ? { bbox: [bbox.minLon, bbox.minLat, bbox.maxLon, bbox.maxLat].map((n) => n.toString()).join(',') }
    : undefined

  const outcome = await getJson(`/api/${LAYER_META[layer].endpoint}`, params, opts.signal)
  const fetchedAt = new Date().toISOString()

  if (!outcome.ok) return { layer, items: [], error: outcome.error, fetchedAt }

  const result: FeedResult = { layer, items: normalizeFeed(layer, outcome.json), fetchedAt }
  cache.set(key, { expires: now + CACHE_TTL_MS, result })
  pruneCache(now)
  return result
}

/** Lightweight reachability check. Never throws. */
async function health(): Promise<boolean> {
  try {
    const outcome = await getJson('/api/earthquakes', { limit: '1' })
    return outcome.ok
  } catch {
    return false
  }
}

async function osintLookup(
  kind: OsintKind,
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<OsintResult> {
  const fetchedAt = () => new Date().toISOString()
  const empty = Object.values(params).some((v) => v.length === 0)
  if (empty) return { ok: false, data: null, error: 'empty query', fetchedAt: fetchedAt() }

  // TODO(osiris): confirm query parameter names and HTTP method for each OSINT route.
  const outcome = await getJson(`/api/${OSINT_ENDPOINTS[kind]}`, params, signal)
  if (!outcome.ok) return { ok: false, data: null, error: outcome.error, fetchedAt: fetchedAt() }
  return { ok: true, data: outcome.json, fetchedAt: fetchedAt() }
}

export const osirisClient = {
  fetchLayer,
  health,
  osintSanctions: (name: string, signal?: AbortSignal) =>
    osintLookup('sanctions', { name: name.trim() }, signal),
  osintWallet: (address: string, signal?: AbortSignal) =>
    osintLookup('crypto', { address: address.trim() }, signal),
  osintWhois: (domain: string, signal?: AbortSignal) =>
    osintLookup('whois', { domain: domain.trim() }, signal),
  osintIp: (ip: string, signal?: AbortSignal) =>
    osintLookup('ip', { ip: ip.trim() }, signal),
}
