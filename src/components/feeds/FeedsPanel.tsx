import React, { useId, useState } from 'react'
import { ALL_LAYERS, LAYER_META } from '../../osiris/config'
import { IDLE_FEED_HANDLE, type FeedLayerHandle, type OsirisHealth } from '../../osiris/hooks'
import type { FeedLayerId } from '../../osiris/types'

export interface FeedsPanelProps {
  enabled: Record<FeedLayerId, boolean>
  feeds: Partial<Record<FeedLayerId, FeedLayerHandle>>
  onToggle: (layer: FeedLayerId, on: boolean) => void
  health: OsirisHealth
}

const HEALTH_LABEL: Record<OsirisHealth['status'], string> = {
  checking: 'checking',
  up: 'online',
  down: 'unreachable',
}

const HEALTH_COLOR: Record<OsirisHealth['status'], string> = {
  checking: '#94a3b8',
  up: '#34d399',
  down: '#ef4444',
}

const SPIN_CSS = '@keyframes feeds-spin{to{transform:rotate(360deg)}}'

/** Collapsible overlay with per-layer toggles, counts, errors and upstream health. */
export const FeedsPanel: React.FC<FeedsPanelProps> = ({ enabled, feeds, onToggle, health }) => {
  const [open, setOpen] = useState(true)
  const bodyId = useId()

  const enabledLayers = ALL_LAYERS.filter((layer) => enabled[layer])
  const stamps = enabledLayers
    .map((layer) => feeds[layer]?.fetchedAt)
    .filter((s): s is string => typeof s === 'string')
    .sort()
  const latest = stamps[stamps.length - 1]
  const asOf = enabledLayers.length === 0
    ? 'Enable a layer to load live data'
    : latest
      ? `As of ${new Date(latest).toLocaleTimeString()}`
      : 'Loading...'

  return (
    <section
      aria-label="Live feeds"
      className="premium-panel"
      style={{
        position: 'absolute',
        top: '16px',
        left: '16px',
        zIndex: 1000,
        width: open ? '250px' : 'auto',
        maxWidth: 'calc(100% - 140px)',
        padding: '10px',
        fontSize: '12px',
      }}
    >
      <style>{SPIN_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
        <button
          type="button"
          className="premium-button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((o) => !o)}
          style={{ padding: '4px 8px', fontSize: '11px' }}
        >
          {open ? 'Hide' : 'Show'} live feeds ({enabledLayers.length})
        </button>
        <span
          role="status"
          title={health.checkedAt ? `Last checked ${new Date(health.checkedAt).toLocaleTimeString()}` : undefined}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' }}
        >
          <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: HEALTH_COLOR[health.status] }} />
          Osiris {HEALTH_LABEL[health.status]}
        </span>
      </div>

      {open && (
        <div id={bodyId} style={{ marginTop: '10px' }}>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {ALL_LAYERS.map((layer) => (
              <FeedRow
                key={layer}
                layer={layer}
                on={enabled[layer]}
                handle={feeds[layer] ?? IDLE_FEED_HANDLE}
                onToggle={onToggle}
              />
            ))}
          </ul>
          <div style={{ marginTop: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', fontSize: '10px', color: 'var(--text-secondary)' }}>
            <span>{asOf}</span>
            <button
              type="button"
              className="premium-button"
              onClick={health.recheck}
              style={{ padding: '2px 6px', fontSize: '10px' }}
            >
              Recheck
            </button>
          </div>
        </div>
      )}
    </section>
  )
}

interface FeedRowProps {
  layer: FeedLayerId
  on: boolean
  handle: FeedLayerHandle
  onToggle: (layer: FeedLayerId, on: boolean) => void
}

function FeedRow({ layer, on, handle, onToggle }: FeedRowProps) {
  const meta = LAYER_META[layer]
  const inputId = `feed-toggle-${layer}`
  return (
    <li style={{ display: 'flex', alignItems: 'center', gap: '8px', minHeight: '22px' }}>
      <label htmlFor={inputId} style={{ display: 'flex', alignItems: 'center', gap: '6px', flex: 1, minWidth: 0, cursor: 'pointer' }}>
        <input
          id={inputId}
          type="checkbox"
          checked={on}
          onChange={(e) => onToggle(layer, e.target.checked)}
        />
        <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: '50%', background: meta.color, flexShrink: 0 }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{meta.label}</span>
      </label>

      {on && (
        <span style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
          {handle.loading && (
            <span
              role="img"
              aria-label={`Loading ${meta.label}`}
              style={{
                display: 'inline-block',
                width: 10,
                height: 10,
                border: '2px solid var(--border-color, #334155)',
                borderTopColor: 'var(--text-primary, #e2e8f0)',
                borderRadius: '50%',
                animation: 'feeds-spin 0.8s linear infinite',
              }}
            />
          )}
          {handle.error ? (
            <>
              <span style={{ color: '#f87171' }} title={handle.error}>failed</span>
              <button
                type="button"
                className="premium-button"
                onClick={handle.retry}
                aria-label={`Retry ${meta.label}`}
                style={{ padding: '1px 6px', fontSize: '10px' }}
              >
                Retry
              </button>
            </>
          ) : (
            <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-primary)' }}>
              {handle.items.length}
            </span>
          )}
        </span>
      )}
    </li>
  )
}
