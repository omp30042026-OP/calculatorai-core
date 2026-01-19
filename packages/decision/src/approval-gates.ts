// packages/decision/src/approval-gates.ts
import type { Decision } from "./decision.js";
import type { DecisionEvent } from "./events.js";
import type { PolicyViolation } from "./policy.js";

export type GateDecisionContext = {
  actor_roles?: string[]; // resolved externally (RBAC/SSO/etc)
};

export type ApprovalGatePolicy = {
  enabled?: boolean;

  // Gate APPROVE/REJECT behind simulation/artifacts
  require_simulation_before_approve?: boolean;
  require_artifacts_before_approve?: boolean;

  // Role-based gates
  approve_requires_any_role?: string[]; // e.g. ["admin","manager"]
  reject_requires_any_role?: string[];

  // Threshold gates (generic)
  // If decision has a numeric risk score >= threshold, require role
  risk_score_threshold?: number; // e.g. 0.8
  risk_score_requires_role?: string; // e.g. "senior_reviewer"

  // Optional: allowlist certain actors (break-glass)
  allow_actor_ids?: string[];
};

function safeString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function safeNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function getState(decision: any): string | null {
  return safeString(decision?.state) ?? safeString(decision?.decision_state) ?? null;
}

function hasArtifacts(decision: any): boolean {
  const a = decision?.artifacts ?? decision?.decision?.artifacts;
  if (!a) return false;
  if (Array.isArray(a)) return a.length > 0;
  if (typeof a === "object") return Object.keys(a).length > 0;
  return false;
}

function getRiskScore(decision: any): number | null {
  return (
    safeNumber(decision?.risk?.score) ??
    safeNumber(decision?.risk_score) ??
    safeNumber(decision?.accountability?.risk_score) ??
    safeNumber(decision?.decision?.risk?.score)
  );
}

function hasAnyRole(actor_roles: string[] | undefined, required: string[] | undefined): boolean {
  if (!required || required.length === 0) return true;
  const set = new Set((actor_roles ?? []).map((r) => r.toLowerCase()));
  return required.some((r) => set.has(r.toLowerCase()));
}

export function evaluateApprovalGates(input: {
  policy?: ApprovalGatePolicy;
  decision: Decision;
  event: DecisionEvent;
  ctx?: GateDecisionContext;
}): { ok: true } | { ok: false; violations: PolicyViolation[] } {
  const policy = input.policy;
  if (!policy || policy.enabled === false) return { ok: true };

  const decisionAny = input.decision as any;
  const actor_id = (input.event as any)?.actor_id as string | undefined;
  const actor_roles = input.ctx?.actor_roles ?? [];

  // break-glass allowlist
  if (actor_id && policy.allow_actor_ids?.includes(actor_id)) return { ok: true };

  const violations: PolicyViolation[] = [];
  const state = getState(decisionAny);
  const risk = getRiskScore(decisionAny);

  // Only gate certain event types
  if (input.event.type === "APPROVE") {
    if (policy.require_simulation_before_approve === true) {
      if (state !== "SIMULATED") {
        violations.push({
          code: "GATE_APPROVE_REQUIRES_SIMULATION",
          severity: "BLOCK",
          message: "Policy gate: APPROVE requires prior SIMULATE.",
          details: { state },
        } as any);
      }
    }

    if (policy.require_artifacts_before_approve === true) {
      if (!hasArtifacts(decisionAny)) {
        violations.push({
          code: "GATE_APPROVE_REQUIRES_ARTIFACTS",
          severity: "BLOCK",
          message: "Policy gate: APPROVE requires supporting artifacts.",
        } as any);
      }
    }

    if (!hasAnyRole(actor_roles, policy.approve_requires_any_role)) {
      violations.push({
        code: "GATE_APPROVE_REQUIRES_ROLE",
        severity: "BLOCK",
        message: "Policy gate: actor lacks required role(s) to APPROVE.",
        details: { required: policy.approve_requires_any_role ?? [], actor_roles },
      } as any);
    }

    if (
      policy.risk_score_threshold != null &&
      policy.risk_score_requires_role &&
      risk != null &&
      risk >= policy.risk_score_threshold
    ) {
      const need = policy.risk_score_requires_role;
      const has = (actor_roles ?? []).some((r) => r.toLowerCase() === need.toLowerCase());
      if (!has) {
        violations.push({
          code: "GATE_HIGH_RISK_REQUIRES_ROLE",
          severity: "BLOCK",
          message: "Policy gate: high risk approvals require elevated role.",
          details: { risk, threshold: policy.risk_score_threshold, required_role: need, actor_roles },
        } as any);
      }
    }
  }

  if (input.event.type === "REJECT") {
    if (!hasAnyRole(actor_roles, policy.reject_requires_any_role)) {
      violations.push({
        code: "GATE_REJECT_REQUIRES_ROLE",
        severity: "BLOCK",
        message: "Policy gate: actor lacks required role(s) to REJECT.",
        details: { required: policy.reject_requires_any_role ?? [], actor_roles },
      } as any);
    }
  }

  if (violations.length) return { ok: false, violations };
  return { ok: true };
}

