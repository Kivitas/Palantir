// Types for the Osiris live-feed integration. Feed items are ephemeral and
// are kept separate from case data (see REVIEW_AND_OSIRIS_PLAN.md section 5).

export const FEED_LAYER_IDS = [
  'earthquakes',
  'flights',
  'fires',
  'weather',
  'gdelt',
  'news',
  'satellites',
] as const

export type FeedLayerId = (typeof FEED_LAYER_IDS)[number]

export interface BBox {
  minLat: number
  minLon: number
  maxLat: number
  maxLon: number
}

export interface FeedItem {
  /** Stable id, prefixed with the layer id (e.g. "fires:12345"). */
  id: string
  layer: FeedLayerId
  title: string
  lat?: number
  lon?: number
  /** ISO 8601 timestamp. */
  time?: string
  /** http(s) source link only. */
  url?: string
  /** Magnitude / confidence / priority, whatever the layer provides. */
  severity?: number | string
  /** Original upstream record, untouched. */
  raw: unknown
}

export interface FeedResult {
  layer: FeedLayerId
  items: FeedItem[]
  error?: string
  fetchedAt: string
}

export interface FetchLayerOptions {
  bbox?: BBox
  signal?: AbortSignal
}

export interface OsintResult {
  ok: boolean
  /** Raw upstream JSON on success; null on failure. */
  data: unknown
  error?: string
  fetchedAt: string
}
