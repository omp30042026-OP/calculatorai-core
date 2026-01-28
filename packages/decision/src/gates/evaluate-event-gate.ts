// packages/decision/src/gates/evaluate-event-gate.ts
import { computeWorkflowStatus, defaultWorkflowTemplates } from "../workflow-engine.js";

export type GateViolation = {
  code: string;
  severity: "BLOCK" | "WARN" | "INFO";
  message: string;
  details?: any;
};

export type GateFailureKind = "STATE_MACHINE" | "POLICY" | "RBAC" | "WORKFLOW";

export type GateReport = {
  ok: boolean;
  failed_gate?: GateFailureKind;

  decision_id: string;
  event_type: string;
  state_before?: string;

  state_machine?: {
    allowed: boolean;
    from_state?: string;
    reason?: string;
  };

  policy?: {
    ok: boolean;
    violation_codes?: string[];
    raw?: any;
  };

  rbac?: {
    ok: boolean;
    required_roles?: string[];
    actor_id?: string;
    found_roles?: string[];
  };

  workflow?: {
    ok: boolean;
    workflow_id?: string;
    satisfied_steps?: Record<string, boolean>;
    is_complete?: boolean;
    raw?: any;
  };
};

export type EvaluateEventGateResult =
  | {
      ok: true;
      violations: [];
      consequence_preview?: any;
      gate_report: GateReport;
    }
  | {
      ok: false;
      violations: GateViolation[];
      consequence_preview?: any;
      gate_report: GateReport;
    };

// Optional hooks so we can integrate with whatever you already have without brittle imports.
// Feature 21/22/23 will just add more hooks/sections.
export type EvaluateEventGateHooks = {
  // State-machine check hook (optional)
  isEventAllowedFromState?: (args: {
    state_before: string;
    event_type: string;
    decision: any;
  }) => { allowed: boolean; reason?: string };

  // Policy check hook (optional)
  evaluatePolicyForEvent?: (args: {
    decision_id: string;
    decision: any;
    event: any;
    store: any;
  }) => { ok: boolean; violations?: Array<{ code?: string }>; raw?: any };

  // RBAC required roles hook (optional). If not provided we use DB-based default.
  getRequiredRolesForEvent?: (event_type: string) => string[] | null;

  // RBAC role check hook (optional). If not provided we query decision_roles from sqlite db.
  hasAnyRole?: (args: {
    decision_id: string;
    actor_id: string;
    required_roles: string[];
    store: any;
  }) => Promise<{ ok: boolean; found_roles?: string[] }>;
};

function uniqUpper(xs: string[]): string[] {
  return Array.from(new Set(xs.map((x) => String(x).toUpperCase())));
}

async function defaultHasAnyRoleViaSqlite(params: {
  decision_id: string;
  actor_id: string;
  required_roles: string[];
  store: any;
}): Promise<{ ok: boolean; found_roles: string[] }> {
  const { decision_id, actor_id, required_roles, store } = params;
  const db: any = (store as any)?.db;
  if (!db) {
    // If we cannot access DB, fail closed for safety on finalize events.
    return { ok: false, found_roles: [] };
  }

  // decision_roles(decision_id, actor_id, role, created_at)
  const rows: Array<{ role: string }> = db
    .prepare(`SELECT role FROM decision_roles WHERE decision_id = ? AND actor_id = ?`)
    .all(decision_id, actor_id);

  const found = uniqUpper(rows.map((r) => r.role));
  const required = uniqUpper(required_roles);

  const ok = required.some((rr) => found.includes(rr));
  return { ok, found_roles: found };
}

export async function evaluateEventGate(params: {
  decision_id: string;
  decision: any | null;
  event: any;
  store: any;
  internal_bypass_enterprise_gates: boolean;
  hooks?: EvaluateEventGateHooks;
}): Promise<EvaluateEventGateResult> {
  const { decision_id, decision, event, store, internal_bypass_enterprise_gates } = params;
  const hooks = params.hooks ?? {};

  const event_type = String(event?.type ?? "");
  const state_before = decision?.state ? String(decision.state) : undefined;

  const gate_report: GateReport = {
    ok: true,
    decision_id,
    event_type,
    state_before,
  };

  // Enterprise bypass -> allow, but still return a report
  if (internal_bypass_enterprise_gates) {
    return { ok: true, violations: [], gate_report };
  }

  // If decision doesn't exist yet, do not block here
  if (!decision) {
    return { ok: true, violations: [], gate_report };
  }

  // -----------------------------
  // (A) State-machine gate (optional hook)
  // -----------------------------
  if (hooks.isEventAllowedFromState && state_before) {
    const sm = hooks.isEventAllowedFromState({
      state_before,
      event_type,
      decision,
    });
    gate_report.state_machine = {
      allowed: !!sm.allowed,
      from_state: state_before,
      reason: sm.reason,
    };
    if (!sm.allowed) {
      gate_report.ok = false;
      gate_report.failed_gate = "STATE_MACHINE";
      return {
        ok: false,
        violations: [
          {
            code: "INVALID_TRANSITION",
            severity: "BLOCK",
            message: `Event ${event_type} is not valid from state ${state_before}.`,
            details: { state_before, event_type, reason: sm.reason ?? null },
          },
        ],
        consequence_preview: {
          predicted_next_state: state_before ?? null,
          delta_summary: [],
          warnings: [],
        },
        gate_report,
      };
    }
  }

  // -----------------------------
  // (B) Policy gate (optional hook)
  // -----------------------------
  if (hooks.evaluatePolicyForEvent) {
    const pr = hooks.evaluatePolicyForEvent({ decision_id, decision, event, store });
    const violation_codes = (pr.violations ?? [])
      .map((v) => v?.code)
      .filter(Boolean) as string[];

    gate_report.policy = {
      ok: !!pr.ok,
      violation_codes,
      raw: pr.raw ?? null,
    };

    if (!pr.ok) {
      gate_report.ok = false;
      gate_report.failed_gate = "POLICY";
      return {
        ok: false,
        violations: [
          {
            code: "POLICY_VIOLATION",
            severity: "BLOCK",
            message: `Policy blocked ${event_type}.`,
            details: { violation_codes, raw: pr.raw ?? null },
          },
        ],
        consequence_preview: {
          predicted_next_state: state_before ?? null,
          delta_summary: [],
          warnings: [],
        },
        gate_report,
      };
    }
  }

  // -----------------------------
  // (C) RBAC gate (default: sqlite decision_roles)
  // -----------------------------
  const actor_id = String(event?.actor_id ?? "");

  const defaultRequiredRoles =
    event_type === "APPROVE" || event_type === "REJECT" || event_type === "PUBLISH"
      ? ["APPROVER", "ADMIN"]
      : null;

  const required_roles = hooks.getRequiredRolesForEvent
    ? hooks.getRequiredRolesForEvent(event_type)
    : defaultRequiredRoles;

  if (required_roles && required_roles.length) {
    const hasAnyRole = hooks.hasAnyRole
      ? await hooks.hasAnyRole({ decision_id, actor_id, required_roles, store })
      : await defaultHasAnyRoleViaSqlite({ decision_id, actor_id, required_roles, store });

    gate_report.rbac = {
      ok: !!hasAnyRole.ok,
      required_roles: uniqUpper(required_roles),
      actor_id,
      found_roles: hasAnyRole.found_roles ?? [],
    };

    if (!hasAnyRole.ok) {
      gate_report.ok = false;
      gate_report.failed_gate = "RBAC";
      return {
        ok: false,
        violations: [
          {
            code: "RBAC_ROLE_REQUIRED",
            severity: "BLOCK",
            message: `Actor ${actor_id} lacks role required for ${event_type}.`,
            details: { required_roles: uniqUpper(required_roles), actor_id },
          },
        ],
        consequence_preview: {
          predicted_next_state: state_before ?? null,
          delta_summary: [],
          warnings: [],
        },
        gate_report,
      };
    }
  }

  // -----------------------------
  // (D) Workflow gate (already working)
  // -----------------------------
  const template = defaultWorkflowTemplates()[0]!;
  const workflowStatus = computeWorkflowStatus({
    template,
    decision,
    pending_event_type: event_type || null,
  });

  gate_report.workflow = {
    ok: !!workflowStatus.is_complete,
    workflow_id: template.workflow_id,
    satisfied_steps: workflowStatus.satisfied_steps,
    is_complete: workflowStatus.is_complete,
    raw: workflowStatus,
  };

  const enforceOn = new Set(["APPROVE", "REJECT"]);
  if (enforceOn.has(event_type) && !workflowStatus.is_complete) {
    gate_report.ok = false;
    gate_report.failed_gate = "WORKFLOW";
    return {
      ok: false,
      violations: [
        {
          code: "WORKFLOW_INCOMPLETE",
          severity: "BLOCK",
          message: `Workflow not complete for ${event_type}`,
          details: { workflow_id: template.workflow_id, status: workflowStatus },
        },
      ],
      consequence_preview: {
        predicted_next_state: state_before ?? null,
        delta_summary: [],
        warnings: [],
      },
      gate_report,
    };
  }

  return { ok: true, violations: [], gate_report };
}

