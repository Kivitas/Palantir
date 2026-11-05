import { useCallback, useEffect, useMemo, useState } from 'react'
import { osirisClient } from './client'
import { LAYER_META } from './config'
import type { BBox, FeedItem, FeedLayerId } from './types'

/** Feed data for one layer. Ephemeral: never written to case data. */
export interface FeedLayerState {
  items: FeedItem[]
  loading: boolean
  error: string | null
  fetchedAt: string | null
}

export interface FeedLayerHandle extends FeedLayerState {
  /** Re-run the fetch now (used by the panel's retry button). */
  retry: () => void
}

const NO_ITEMS: FeedItem[] = []
const IDLE: FeedLayerState = { items: NO_ITEMS, loading: false, error: null, fetchedAt: null }
const noop = () => {}

/** Handle for a layer that has not reported yet. Stable identity. */
export const IDLE_FEED_HANDLE: FeedLayerHandle = { ...IDLE, retry: noop }

/** Round to 2 dp (about 1 km) so tiny pans do not trigger refetches. */
function bboxToKey(b: BBox | null | undefined): string {
  if (!b) return ''
  return [b.minLat, b.minLon, b.maxLat, b.maxLon].map((n) => n.toFixed(2)).join(',')
}

function keyToBbox(key: string): BBox | undefined {
  if (!key) return undefined
  const p = key.split(',').map(Number)
  return { minLat: p[0] ?? 0, minLon: p[1] ?? 0, maxLat: p[2] ?? 0, maxLon: p[3] ?? 0 }
}

/**
 * Fetches one Osiris feed layer while enabled, for the given viewport.
 * Refreshes on LAYER_META[layer].defaultRefreshMs, aborts on disable or unmount.
 * On a failed refresh the previous items are kept and `error` is set.
 */
export function useFeedLayer(
  layer: FeedLayerId,
  enabled: boolean,
  bbox: BBox | null | undefined,
): FeedLayerHandle {
  const [state, setState] = useState<FeedLayerState>(IDLE)
  const [reloadKey, setReloadKey] = useState(0)
  const bboxKey = bboxToKey(bbox)

  useEffect(() => {
    if (!enabled) {
      setState(IDLE)
      return
    }

    const controller = new AbortController()
    const requestBbox = keyToBbox(bboxKey)

    const run = async () => {
      setState((prev) => ({ ...prev, loading: true }))
      const result = await osirisClient.fetchLayer(layer, { bbox: requestBbox, signal: controller.signal })
      if (controller.signal.aborted) return
      setState((prev) => ({
        items: result.error ? prev.items : result.items,
        loading: false,
        error: result.error ?? null,
        fetchedAt: result.fetchedAt,
      }))
    }

    void run()
    const timer = window.setInterval(() => {
      void run()
    }, LAYER_META[layer].defaultRefreshMs)

    return () => {
      controller.abort()
      window.clearInterval(timer)
    }
  }, [layer, enabled, bboxKey, reloadKey])

  const retry = useCallback(() => setReloadKey((k) => k + 1), [])
  return useMemo(() => ({ ...state, retry }), [state, retry])
}

export type OsirisStatus = 'checking' | 'up' | 'down'

export interface OsirisHealth {
  status: OsirisStatus
  checkedAt: string | null
  recheck: () => void
}

/** Polls Osiris reachability. `recheck` forces an immediate probe. */
export function useOsirisHealth(intervalMs = 60_000): OsirisHealth {
  const [status, setStatus] = useState<OsirisStatus>('checking')
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    const check = async () => {
      const ok = await osirisClient.health()
      if (cancelled) return
      setStatus(ok ? 'up' : 'down')
      setCheckedAt(new Date().toISOString())
    }
    void check()
    const timer = window.setInterval(() => {
      void check()
    }, intervalMs)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [intervalMs, tick])

  const recheck = useCallback(() => setTick((t) => t + 1), [])
  return { status, checkedAt, recheck }
}
