import { store, type SignalInput } from '../store'
import type { Case, Incident, SeverityLevel, WatchRule } from '../types'
import { osirisClient } from './client'
import { LAYER_META } from './config'
import type { FeedItem, FeedLayerId } from './types'

/** Fixed text: rule matches are deterministic and involve no model output. */
export const RULE_AI_ASSESSMENT = 'Rule match (no AI)'

const EARTH_RADIUS_KM = 6371
const MIN_ENTITY_NAME_LENGTH = 3

/** A rule match ready to be stored as a signal. */
export interface RuleCandidate extends SignalInput {
  ruleId: string
}

export interface WatchRunSummary {
  /** Enabled rules that were evaluated. */
  rules: number
  /** Distinct feed layers fetched for those rules. */
  layers: number
  /** Feed items examined across layers that fetched successfully. */
  examined: number
  /** Rule matches before de-duplication against stored signals. */
  matched: number
  added: number
  duplicates: number
  /** Per-layer fetch failures. A layer in here contributed no items. */
  errors: Array<{ layer: FeedLayerId; error: string }>
  /** Run-level problem (unknown case, no enabled rules). */
  error?: string
}

/** Great-circle distance in km. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)))
}

/** Numeric value of a feed severity, or undefined when it is not a number. */
function numericSeverity(v: FeedItem['severity']): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

/** Incident coordinates are stored as strings. Keeps only those that parse to valid lat/lon. */
function incidentPoints(incidents: Incident[]): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const i of incidents) {
    const latText = String(i.lat).trim()
    const lonText = String(i.lon).trim()
    if (!latText || !lonText) continue
    const lat = Number(latText)
    const lon = Number(lonText)
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      out.push([lat, lon])
    }
  }
  return out
}

/**
 * Returns the reasons a feed item satisfies a rule (all criteria must hold), or null if it does
 * not match. A rule with no criteria matches every item on its layer.
 */
function matchReasons(
  rule: WatchRule,
  item: FeedItem,
  points: Array<[number, number]>,
  entityNames: string[],
): string[] | null {
  const reasons: string[] = []

  if (rule.minSeverity !== undefined) {
    const n = numericSeverity(item.severity)
    if (n === undefined || n < rule.minSeverity) return null
    reasons.push(`severity ${n} >= ${rule.minSeverity}`)
  }

  if (rule.keyword) {
    const kw = rule.keyword.toLowerCase()
    const title = item.title.toLowerCase()
    // Match the title directly, or a case entity whose name contains the keyword and appears in the title.
    const hit = title.includes(kw) || entityNames.some((name) => name.includes(kw) && title.includes(name))
    if (!hit) return null
    reasons.push(`keyword "${rule.keyword}"`)
  }

  if (rule.withinIncidentRadiusKm !== undefined) {
    if (item.lat === undefined || item.lon === undefined || points.length === 0) return null
    let nearest = Infinity
    for (const [lat, lon] of points) {
      nearest = Math.min(nearest, haversineKm(item.lat, item.lon, lat, lon))
    }
    if (nearest > rule.withinIncidentRadiusKm) return null
    reasons.push(`${Math.round(nearest)} km from an incident`)
  }

  return reasons
}

/**
 * Pure. Evaluates enabled rules against feed items and returns candidate signals, one per item
 * (first matching rule wins). Severity is HIGH when the rule has a severity threshold, otherwise
 * MEDIUM. The rule is the only source of the verdict; no AI is involved.
 */
export function evaluateRules(
  rules: readonly WatchRule[],
  feedItems: readonly FeedItem[],
  caseData: Pick<Case, 'entities' | 'incidents'>,
): RuleCandidate[] {
  const enabled = rules.filter((r) => r.enabled)
  if (enabled.length === 0 || feedItems.length === 0) return []

  const points = incidentPoints(caseData.incidents)
  const entityNames = caseData.entities
    .map((e) => e.name.trim().toLowerCase())
    .filter((n) => n.length >= MIN_ENTITY_NAME_LENGTH)

  const seen = new Set<string>()
  const out: RuleCandidate[] = []
  for (const item of feedItems) {
    if (seen.has(item.id)) continue
    for (const rule of enabled) {
      if (rule.layer !== item.layer) continue
      const reasons = matchReasons(rule, item, points, entityNames)
      if (!reasons) continue
      seen.add(item.id)
      const when = item.time ? `, feed time ${item.time}` : ''
      out.push({
        ruleId: rule.id,
        source_id: item.id,
        title: item.title,
        description: `${LAYER_META[item.layer].label}: ${reasons.join('; ')}${when}`,
        severity: (rule.minSeverity !== undefined ? 'HIGH' : 'MEDIUM') as SeverityLevel,
        ai_assessment: RULE_AI_ASSESSMENT,
      })
      break
    }
  }
  return out
}

/**
 * Fetches each enabled rule's layer once, evaluates the rules, and stores new matches with
 * store.addSignal. Never throws: fetch failures are returned in `errors`.
 */
export async function runWatchRules(caseId: string): Promise<WatchRunSummary> {
  const summary: WatchRunSummary = {
    rules: 0,
    layers: 0,
    examined: 0,
    matched: 0,
    added: 0,
    duplicates: 0,
    errors: [],
  }

  const initial = store.getCase(caseId)
  if (!initial) return { ...summary, error: 'No such case.' }
  const enabled = (initial.watch_rules ?? []).filter((r) => r.enabled)
  if (enabled.length === 0) return { ...summary, error: 'No enabled watch rules.' }

  const layers = [...new Set(enabled.map((r) => r.layer))]
  summary.rules = enabled.length
  summary.layers = layers.length

  const results = await Promise.all(layers.map((layer) => osirisClient.fetchLayer(layer)))
  const items: FeedItem[] = []
  for (const r of results) {
    if (r.error) summary.errors.push({ layer: r.layer, error: r.error })
    else items.push(...r.items)
  }
  summary.examined = items.length

  // Re-read the case: rules may have changed while the feeds were loading.
  const current = store.getCase(caseId)
  if (!current) return { ...summary, error: 'Case was removed during the run.' }
  const candidates = evaluateRules(current.watch_rules ?? [], items, current)
  summary.matched = candidates.length

  for (const candidate of candidates) {
    if (store.addSignal(caseId, candidate)) summary.added++
    else summary.duplicates++
  }

  if (summary.added > 0) {
    store.logAction('WATCH_RUN', `Watch rules raised ${summary.added} signal(s) in case "${current.name}"`)
  }
  return summary
}
