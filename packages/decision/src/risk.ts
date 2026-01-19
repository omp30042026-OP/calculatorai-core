// packages/decision/src/risk.ts
import type { Decision, DecisionRisk } from "./decision";

export function normalizeRisk(input: any): DecisionRisk {
  const r = input && typeof input === "object" ? input : {};

  const blast_radius = Array.isArray(r.blast_radius) ? r.blast_radius : [];
  const impacted_systems = Array.isArray(r.impacted_systems) ? r.impacted_systems : [];
  const links = Array.isArray(r.links) ? r.links : [];

  return {
    owner_id: typeof r.owner_id === "string" ? r.owner_id : null,
    severity:
      typeof r.severity === "string" &&
      ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(r.severity)
        ? r.severity
        : null,
    blast_radius: blast_radius.filter((x: any) => typeof x === "string"),
    impacted_systems: impacted_systems.filter((x: any) => typeof x === "string"),

    rollback_plan_id: typeof r.rollback_plan_id === "string" ? r.rollback_plan_id : null,
    rollback_owner_id: typeof r.rollback_owner_id === "string" ? r.rollback_owner_id : null,

    notes: typeof r.notes === "string" ? r.notes : null,
    links: links.filter((x: any) => typeof x === "string"),
  } as any;
}

export function setDecisionRisk(decision: Decision, patch: Partial<DecisionRisk>): Decision {
  const nextRisk = normalizeRisk({ ...(decision.risk ?? {}), ...(patch ?? {}) });
  return { ...decision, risk: nextRisk };
}