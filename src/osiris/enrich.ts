import { store } from '../store'
import type { Entity } from '../types'
import type { ConfirmFn } from '../ui/confirmContext'
import { osirisClient } from './client'
import type { OsintResult } from './types'

/**
 * Enrichment actions: look up an entity in external OSINT sources through Osiris and
 * store a compact result on the entity. Every call here is an external request.
 */

export type EnrichKind = 'sanctions' | 'wallet' | 'whois' | 'ip'

export interface EnrichResult {
  ok: boolean
  summary: string
  data?: unknown
  error?: string
}

export const ENRICH_KINDS: readonly EnrichKind[] = ['sanctions', 'wallet', 'whois', 'ip']

export const ENRICH_LABELS: Record<EnrichKind, string> = {
  sanctions: 'Sanctions check',
  wallet: 'Wallet lookup',
  whois: 'WHOIS lookup',
  ip: 'IP lookup',
}

/** Summary used when the user declines the classified-object confirmation. */
export const CANCELLED_SUMMARY = 'Cancelled'

/** Property values are written into a cookie-backed store, so keep them short. */
const MAX_PROPERTY_CHARS = 190

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)

const today = () => new Date().toISOString().slice(0, 10)

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

const propertyKey = (kind: EnrichKind) => `osint_${kind}`

// ---------------------------------------------------------------------------
// Input selection

type Input = { ok: true; value: string } | { ok: false; error: string }

/** Matches a property key for each kind (case-insensitive). Sanctions uses the entity name. */
const KEY_PATTERN: Record<Exclude<EnrichKind, 'sanctions'>, (key: string) => boolean> = {
  wallet: (k) => !/^ip/i.test(k) && /wallet|address/i.test(k),
  whois: (k) => /domain/i.test(k),
  ip: (k) => /^(ip|ipv4|ipv6|ip[_\s-]?address)$/i.test(k.trim()),
}

function normalizeInput(kind: EnrichKind, raw: string): string | undefined {
  const v = raw.trim()
  if (!v) return undefined
  switch (kind) {
    case 'whois': {
      const host = (v.toLowerCase().replace(/^[a-z]+:\/\//, '').split(/[/?#:]/)[0] ?? '')
      return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : undefined
    }
    case 'ip': {
      const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(v)
      if (v4) return v4.slice(1).every((o) => Number(o) <= 255) ? v : undefined
      return /^[0-9a-f]*:[0-9a-f:.]+$/i.test(v) ? v : undefined
    }
    case 'wallet':
      return /^[A-Za-z0-9]{20,120}$/.test(v) ? v : undefined
    default:
      return v
  }
}

function findInput(entity: Entity, kind: EnrichKind): Input {
  if (kind === 'sanctions') {
    const name = entity.name.trim()
    return name ? { ok: true, value: name } : { ok: false, error: 'The entity has no name to check.' }
  }
  const hint = kind === 'wallet' ? "'wallet' or 'address'" : kind === 'whois' ? "'domain'" : "'ip'"
  for (const [key, raw] of Object.entries(entity.properties)) {
    if (!KEY_PATTERN[kind](key)) continue
    const value = normalizeInput(kind, String(raw ?? ''))
    if (value) return { ok: true, value }
  }
  return {
    ok: false,
    error: `No valid ${ENRICH_LABELS[kind].toLowerCase().replace(' lookup', '')} input found. Add a property with a key like ${hint} and a valid value.`,
  }
}

// ---------------------------------------------------------------------------
// Result summaries (response shapes are unverified, so these stay tolerant)

function countHits(data: unknown): number | undefined {
  if (Array.isArray(data)) return data.length
  if (!isRec(data)) return undefined
  for (const key of ['hits', 'matches', 'results', 'data', 'entries', 'records']) {
    const v = data[key]
    if (Array.isArray(v)) return v.length
  }
  for (const key of ['hits', 'total', 'count', 'matchCount']) {
    const v = data[key]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

/** First few scalar fields of a response, as "key: value; key: value". */
function scalarPreview(data: unknown): string {
  if (Array.isArray(data)) return `${data.length} records`
  if (!isRec(data)) return data === null || data === undefined ? 'empty response' : String(data)
  const parts: string[] = []
  for (const [k, v] of Object.entries(data)) {
    if (parts.length >= 4) break
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') parts.push(`${k}: ${v}`)
  }
  return parts.length > 0 ? parts.join('; ') : `${Object.keys(data).length} fields`
}

function summarize(kind: EnrichKind, data: unknown): string {
  const date = today()
  if (kind === 'sanctions') {
    const hits = countHits(data)
    if (hits === undefined) return `Response not recognised (checked ${date})`
    if (hits === 0) return `No match (checked ${date})`
    return `MATCH: ${hits} hit${hits === 1 ? '' : 's'} (checked ${date})`
  }
  return `${scalarPreview(data)} (checked ${date})`
}

// ---------------------------------------------------------------------------

const call: Record<EnrichKind, (input: string) => Promise<OsintResult>> = {
  sanctions: (v) => osirisClient.osintSanctions(v),
  wallet: (v) => osirisClient.osintWallet(v),
  whois: (v) => osirisClient.osintWhois(v),
  ip: (v) => osirisClient.osintIp(v),
}

function audit(entity: Entity, kind: EnrichKind, outcome: string, classified: boolean): void {
  // Classified objects: the audit trail records the id only, not the name.
  const subject = classified ? `${entity.type} ${entity.id}` : `${entity.type} ${entity.name} (${entity.id})`
  store.logAction('ENRICH', clip(`${ENRICH_LABELS[kind]} on ${subject}: ${outcome}`, 400))
}

/**
 * Runs one enrichment lookup for an entity. Stores a compact result in
 * entity.properties.osint_<kind> on success and logs an ENRICH audit entry.
 * Classified entities are refused unless the caller passes allowClassified
 * (the UI does that only after a confirm dialog). Never throws.
 */
export async function enrichEntity(
  entity: Entity,
  kind: EnrichKind,
  opts: { allowClassified?: boolean } = {},
): Promise<EnrichResult> {
  const label = ENRICH_LABELS[kind]
  const classified = entity.clearance !== 'UNCLASSIFIED'

  if (classified && !opts.allowClassified) {
    const error = `${entity.clearance} objects are not sent to Osiris. Enrichment makes external requests, so classified data stays local unless you confirm the override.`
    audit(entity, kind, `blocked (${entity.clearance})`, true)
    return { ok: false, summary: 'Blocked', error }
  }

  const input = findInput(entity, kind)
  if (!input.ok) {
    audit(entity, kind, 'no valid input', classified)
    return { ok: false, summary: 'No input', error: input.error }
  }

  let outcome: OsintResult
  try {
    outcome = await call[kind](input.value)
  } catch (err) {
    outcome = { ok: false, data: null, error: err instanceof Error ? err.message : 'lookup failed', fetchedAt: new Date().toISOString() }
  }

  if (!outcome.ok) {
    const error = outcome.error ?? 'lookup failed'
    audit(entity, kind, `failed (${error})`, classified)
    return { ok: false, summary: `${label} failed`, error }
  }

  // The user may have switched cases while the request was in flight.
  const stillInCase = store.getActiveCase()?.entities.includes(entity) ?? false
  if (!stillInCase) {
    return { ok: false, summary: 'Not saved', error: 'The object is no longer in the active case. Result not saved.' }
  }

  const summary = summarize(kind, outcome.data)
  entity.properties[propertyKey(kind)] = clip(summary, MAX_PROPERTY_CHARS)
  store.save()
  audit(entity, kind, summary, classified)
  return { ok: true, summary, data: outcome.data }
}

/**
 * UI wrapper: classified entities need an explicit confirm first. Declining returns
 * a not-ok result with summary CANCELLED_SUMMARY and sends nothing.
 */
export async function enrichWithConfirm(entity: Entity, kind: EnrichKind, confirm: ConfirmFn): Promise<EnrichResult> {
  if (entity.clearance === 'UNCLASSIFIED') return enrichEntity(entity, kind)

  const ok = await confirm({
    title: `Send ${entity.clearance} object externally?`,
    message: `${ENRICH_LABELS[kind]} sends this object's input to external services through Osiris. The object is ${entity.clearance}. Continue only if your handling rules allow it.`,
    confirmLabel: 'Send anyway',
    tone: 'danger',
  })
  if (!ok) {
    audit(entity, kind, 'cancelled at confirm', true)
    return { ok: false, summary: CANCELLED_SUMMARY, error: 'Cancelled. The classified object was not sent.' }
  }
  return enrichEntity(entity, kind, { allowClassified: true })
}
