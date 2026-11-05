import { useEffect } from 'react'
import { useFeedLayer, type FeedLayerHandle } from '../../osiris/hooks'
import type { BBox, FeedLayerId } from '../../osiris/types'

interface FeedLayerProbeProps {
  layer: FeedLayerId
  enabled: boolean
  bbox: BBox | null
  onChange: (layer: FeedLayerId, handle: FeedLayerHandle) => void
}

/** Renders nothing. Runs one feed hook so the parent can read every layer's state. */
export function FeedLayerProbe({ layer, enabled, bbox, onChange }: FeedLayerProbeProps) {
  const handle = useFeedLayer(layer, enabled, bbox)
  useEffect(() => {
    onChange(layer, handle)
  }, [layer, handle, onChange])
  return null
}
