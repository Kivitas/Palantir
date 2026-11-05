import type { FeedLayerId } from './osiris/types';

export type ClearanceLevel ='UNCLASSIFIED' | 'SECRET' | 'TOP_SECRET';
export type SeverityLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface Entity {
  id: string;
  type: string; // e.g., 'Person', 'Organization', 'Company', 'Asset', 'Device', 'Card', 'Account', 'Location'
  name: string;
  properties: Record<string, string>;
  clearance: ClearanceLevel;
  created_at: string;
}

export interface Incident {
  id: string;
  title: string;
  description: string;
  lat: string;
  lon: string;
  date: string;
  clock: string;
  severity: SeverityLevel;
  clearance: ClearanceLevel;
  created_at: string;
  flow_x?: number;
  flow_y?: number;
}

export interface Relationship {
  id: string;
  type: string; // e.g., 'OPERATES_WITH', 'LINKS_TO', 'COMMUNICATED_WITH'
  src: string; // ID of source node
  dst: string; // ID of destination node
  confidence: number; // 0.0 to 1.0
  rationale: string;
  clearance: ClearanceLevel;
  created_at: string;
}

export type SignalStatus = 'NEW' | 'ACKNOWLEDGED' | 'ESCALATED' | 'DISMISSED';

export interface Signal {
  id: string;
  source_id: string;
  title: string;
  description: string;
  severity: SeverityLevel;
  status: SignalStatus;
  ai_assessment: string;
  /** Optional; absent means UNCLASSIFIED. Export filters signals by this. */
  clearance?: ClearanceLevel;
  created_at: string;
}

/** A rule that turns matching live-feed items into case signals (see src/osiris/signals.ts). */
export interface WatchRule {
  id: string;
  layer: FeedLayerId;
  /** Numeric feed severity must be >= this value. Items without a numeric severity do not match. */
  minSeverity?: number;
  /** Case-insensitive match against the item title, or against a case entity name found in it. */
  keyword?: string;
  /** Item must lie within this many km of at least one case incident with coordinates. */
  withinIncidentRadiusKm?: number;
  enabled: boolean;
}

export type PropertyType = 'string' | 'number' | 'boolean' | 'date';

export interface OntologyProperty {
  id: string;
  name: string;
  type: PropertyType;
}

export interface OntologyObjectType {
  id: string;
  name: string;
  icon: string;
  color: string;
  properties: OntologyProperty[];
  created_at: string;
}

export interface Case {
  id: string;
  name: string;
  description: string;
  severity_level: SeverityLevel;
  ontology_types: OntologyObjectType[];
  action_types: ActionType[];
  entities: Entity[];
  incidents: Incident[];
  relationships: Relationship[];
  signals: Signal[];
  watch_rules?: WatchRule[];
  created_at: string;
}

export interface AISettings {
  enabled: boolean;
  model: string;
  key_stored: boolean;
  apiKey?: string;
}

export type AIProvider = 'openai' | 'gemini' | 'anthropic' | 'mistral';

export interface Settings {
  theme: 'dark' | 'light';
  ai: Record<AIProvider, AISettings>;
}

export interface AuditLog {
  id: string;
  timestamp: string;
  username: string;
  action: string;
  details: string;
}

export type ActionTypeParameter = {
  id: string;
  name: string;
  type: PropertyType;
};

export interface ActionType {
  id: string;
  name: string;
  description: string;
  target_ontology_id: string; // which object type this applies to
  parameters: ActionTypeParameter[];
  created_at: string;
}

export const CLEARANCE_LEVELS: Record<ClearanceLevel, number> = {
  'UNCLASSIFIED': 0,
  'SECRET': 1,
  'TOP_SECRET': 2,
};

export function hasClearance(userClearance: ClearanceLevel, itemClearance: ClearanceLevel): boolean {
  return CLEARANCE_LEVELS[userClearance] >= CLEARANCE_LEVELS[itemClearance];
}
