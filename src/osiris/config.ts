import { FEED_LAYER_IDS, type FeedLayerId } from './types'

/**
 * Same-origin prefix for Osiris. In dev, Vite proxies it (vite.config.ts);
 * in Docker, nginx proxies it to the osiris service with the prefix stripped.
 */
export const OSIRIS_BASE = '/osiris'

/** Hard timeout for any single Osiris request. */
export const REQUEST_TIMEOUT_MS = 8_000

/** In-memory cache lifetime for feed layers. */
export const CACHE_TTL_MS = 60_000

export interface LayerMeta {
  id: FeedLayerId
  label: string
  color: string
  /** Path segment under /api/ on Osiris. */
  endpoint: string
  /** Suggested polling interval for this layer. */
  defaultRefreshMs: number
}

export const LAYER_META: Record<FeedLayerId, LayerMeta> = {
  earthquakes: { id: 'earthquakes', label: 'Earthquakes', color: '#f59e0b', endpoint: 'earthquakes', defaultRefreshMs: 120_000 },
  flights: { id: 'flights', label: 'Flights', color: '#38bdf8', endpoint: 'flights', defaultRefreshMs: 60_000 },
  fires: { id: 'fires', label: 'Fires', color: '#ef4444', endpoint: 'fires', defaultRefreshMs: 600_000 },
  weather: { id: 'weather', label: 'Weather', color: '#a78bfa', endpoint: 'weather', defaultRefreshMs: 600_000 },
  gdelt: { id: 'gdelt', label: 'GDELT events', color: '#f472b6', endpoint: 'gdelt', defaultRefreshMs: 300_000 },
  news: { id: 'news', label: 'News', color: '#34d399', endpoint: 'news', defaultRefreshMs: 300_000 },
  satellites: { id: 'satellites', label: 'Satellites', color: '#facc15', endpoint: 'satellites', defaultRefreshMs: 600_000 },
}

export const ALL_LAYERS: readonly FeedLayerId[] = FEED_LAYER_IDS

/** OSINT enrichment endpoints, relative to /api/. */
export const OSINT_ENDPOINTS = {
  sanctions: 'osint/sanctions',
  crypto: 'osint/crypto',
  whois: 'osint/whois',
  ip: 'osint/ip',
} as const

export type OsintKind = keyof typeof OSINT_ENDPOINTS
