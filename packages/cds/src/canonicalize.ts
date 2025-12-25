import type { ParsedDecision } from "./validate.js";

/**
 * Canonicalize a parsed decision for deterministic downstream computation.
 * - Sorts arrays by stable IDs
 * - Normalizes currency casing
 * - Trims string IDs/titles (no semantic changes)
 *
 * NOTE: We do NOT "fix" missing data here. Only normalize representation.
 */
export function canonicalizeDecision(d: ParsedDecision): ParsedDecision {
  const sorted = {
    ...d,
    currency: d.currency.toUpperCase(),
    decision_id: d.decision_id.trim(),
    title: d.title.trim(),
    baseline: canonicalizeBaseline(d.baseline),
    change_set: [...d.change_set].sort(byId("change_id")),
    assumptions: [...d.assumptions].sort(byId("assumption_id")),
  };

  return sorted;
}

function canonicalizeBaseline(b: ParsedDecision["baseline"]): ParsedDecision["baseline"] {
  return {
    ...b,
    entities: [...b.entities].sort(byId("entity_id")),
    items: [...b.items].sort(byId("item_id")),
    relationships: [...b.relationships].sort(byId("relationship_id")),
    observations: [...b.observations].sort(byId("obs_id")),
  };
}

function byId<K extends string>(key: K) {
  return (a: Record<K, string>, b: Record<K, string>) =>
    a[key].localeCompare(b[key]);
}


