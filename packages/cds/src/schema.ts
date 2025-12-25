// Canonical Decision Schema v1 (CDS v1)
// Types only. No functions.

export type ISO8601 = string;
export type CurrencyCode = string;

/* ----------------------------- Decision ----------------------------- */

export interface Decision {
  decision_id: string;
  title: string;
  decision_time: ISO8601;

  horizon: {
    start: ISO8601;
    end: ISO8601;
  };

  currency: CurrencyCode;

  baseline: BaselineState;
  change_set: ChangeSet[];

  assumptions: Assumption[];

  policy: PolicyContext;
  provenance: Provenance;
}

/* --------------------------- Baseline State -------------------------- */

export interface BaselineState {
  entities: Entity[];
  items: Item[];
  relationships: Relationship[];
  observations: Observation[];
}

/* ------------------------------ Entities ----------------------------- */

export type EntityType =
  | "VENDOR"
  | "CUSTOMER"
  | "LOCATION"
  | "BUSINESS_UNIT"
  | "OTHER";

export interface Entity {
  entity_id: string;
  entity_type: EntityType;
  name?: string;
  attributes?: Record<string, string | number | boolean>;
}

/* -------------------------------- Items ------------------------------ */

export type ItemType = "SKU" | "SERVICE" | "RESOURCE" | "OTHER";

export interface Item {
  item_id: string;
  item_type: ItemType;
  name?: string;
  uom?: string; // unit of measure: "each", "hour", "GB", etc.
  attributes?: Record<string, string | number | boolean>;
}

/* ---------------------------- Relationships --------------------------- */

export type RelationshipType = "SUPPLIES" | "SELLS" | "USES" | "OWNS" | "OTHER";

export interface Relationship {
  relationship_id: string;
  entity_id: string;
  item_id: string;
  relationship_type: RelationshipType;
  terms?: Terms;
}

export interface Terms {
  payment_terms_days?: number;
  lead_time_days?: number;
  notes?: string;
}

/* ---------------------------- Observations --------------------------- */

export type Metric =
  | "UNIT_PRICE"
  | "UNIT_COST"
  | "VOLUME"
  | "REVENUE"
  | "DISCOUNT_RATE"
  | "LEAD_TIME_DAYS"
  | "DEFECT_RATE"
  | "STOCKOUT_RATE"
  | "CAPACITY";

export interface Observation {
  obs_id: string;

  metric: Metric;
  value: number;
  unit?: string;

  time: ISO8601;

  dims: DimensionSet;

  quality: DataQuality;
  source?: SourceRef;
}

export interface DimensionSet {
  entity_id?: string;
  item_id?: string;
  relationship_id?: string;

  location_id?: string;
  business_unit_id?: string;

  // Adapter may add stable dimension keys here, but MUST remain strings (no nested objects).
  // Examples: { channel: "online" } or { region: "us-west" }
  extra?: Record<string, string>;
}

export interface DataQuality {
  // 0..1 where 1 = complete and current; deterministic engines can ignore this,
  // but explainability will surface it.
  completeness?: number;

  // Staleness in days relative to decision_time (adapter-provided).
  staleness_days?: number;

  source_system?: string; // e.g., "pos", "erp", "billing"
  notes?: string;
}

export interface SourceRef {
  source_id?: string;
  source_system?: string;
  source_record_id?: string;
}

/* ------------------------------ Changes ------------------------------ */

export type ChangeType =
  | "PRICE_CHANGE"
  | "COST_CHANGE"
  | "VOLUME_CHANGE"
  | "MIX_SHIFT"
  | "TERM_CHANGE"
  | "AVAILABILITY_CHANGE";

export interface ChangeSet {
  change_id: string;
  type: ChangeType;

  target: TargetRef;

  effective: {
    start: ISO8601;
    end?: ISO8601;
  };

  delta: Delta;

  constraints?: Constraint[];
  notes?: string;
}

export type TargetScope = "ENTITY" | "ITEM" | "RELATIONSHIP" | "OBSERVATION_DIM";

export interface TargetRef {
  scope: TargetScope;

  entity_id?: string;
  item_id?: string;
  relationship_id?: string;

  dims?: DimensionSet;
}

export type Delta =
  | { kind: "ABSOLUTE"; new_value: number }
  | { kind: "RELATIVE"; multiplier: number }
  | { kind: "ADD"; amount: number }
  | { kind: "SET_CATEGORY"; value: string };

/* --------------------------- Assumptions ---------------------------- */

export interface Assumption {
  assumption_id: string;
  statement: string;
  applies_to: TargetRef;
  value?: string | number | boolean;
  justification?: string;
}

/* --------------------------- Constraints ---------------------------- */

export type ConstraintSeverity = "HARD" | "SOFT";

export interface Constraint {
  constraint_id: string;
  expr: string; // stored as string in v1; evaluated later by policy/sim
  severity: ConstraintSeverity;
  notes?: string;
}

/* ------------------------------ Policy ------------------------------ */

export type AuditLevel = "FULL" | "STANDARD";

export interface PolicyContext {
  read_only: true;

  allow_pii?: boolean;

  require_human_review: true;

  audit_level?: AuditLevel;
}

/* ---------------------------- Provenance ---------------------------- */

export type CreatedBy = "HUMAN" | "ADAPTER";

export interface Provenance {
  created_by: CreatedBy;
  adapter_id?: string;
  source_systems?: string[];
  created_at: ISO8601;
}
