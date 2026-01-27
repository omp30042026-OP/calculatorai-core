// packages/decision/src/policy.ts
import type { Decision } from "./decision.js";
import type { DecisionEvent } from "./events.js";
import { ensureExecutionArtifacts, evaluateExecution } from "./obligations.js";

export type PolicySeverity = "WARN" | "BLOCK";

export type PolicyViolation = {
  code: string;
  severity: "INFO" | "WARN" | "BLOCK";
  message: string;

  // ✅ allow structured evidence (audit-friendly)
  details?: Record<string, unknown>;
};

export type PolicyResult =
  | { ok: true }
  | { ok: false; violations: PolicyViolation[] };

export type DecisionPolicy = (ctx: {
  decision: Decision;
  event: DecisionEvent;
}) => PolicyResult;

export function defaultPolicies(): DecisionPolicy[] {
  return [
    requireMetaOnValidatePolicy(),

    // ✅ Feature 18: safety net (agent can’t finalize)
    agentCannotFinalizePolicy(),

    // ✅ Feature 13.4/13.5
    slaEnforcementPolicy({ block_on: "APPROVE" }), // recommended: block at approval time
  ];
}

/**
 * V2: Only requires fields in decision.meta (NOT artifacts).
 * Required keys (example): title, owner_id
 */
function requireMetaOnValidatePolicy(): DecisionPolicy {
  return ({ decision, event }) => {
    if (event.type !== "VALIDATE") return { ok: true };

    const meta = (decision.meta ?? {}) as Record<string, unknown>;
    const missing: string[] = [];

    if (typeof meta.title !== "string" || meta.title.trim().length === 0)
      missing.push("title");
    if (typeof meta.owner_id !== "string" || meta.owner_id.trim().length === 0)
      missing.push("owner_id");

    if (missing.length === 0) return { ok: true };

    return {
      ok: false,
      violations: [
        {
          code: "MISSING_REQUIRED_FIELDS",
          severity: "BLOCK",
          message: `Cannot VALIDATE: missing required meta fields: ${missing.join(", ")}.`,
          details: { missing },
        },
      ],
    };
  };
}

/**
 * ✅ Feature 13.4 SLA enforcement + 13.5 automatic violations
 *
 * - Always computes breaches (based on now + due_at + grace)
 * - Recommended behavior: only BLOCK on APPROVE (so users can keep adding evidence)
 * - You can change to block_on: "ANY_EVENT" if you want hard enforcement always.
 */
export function slaEnforcementPolicy(opts?: {
  block_on?: "APPROVE" | "ANY_EVENT";
}): DecisionPolicy {
  const blockOn = opts?.block_on ?? "APPROVE";

  return ({ decision, event }) => {
    const artifactsAny: any = decision.artifacts ?? {};
    const exec = ensureExecutionArtifacts(artifactsAny);

    // no obligations -> no SLA enforcement
    if (!exec.obligations || exec.obligations.length === 0) return { ok: true };

    const nowIso = decision.updated_at ?? new Date().toISOString();
    const { breached } = evaluateExecution(exec, nowIso);

    if (!breached.length) return { ok: true };

    // automatic violations list
    const violations: PolicyViolation[] = breached.map((o) => ({
      code: "OBLIGATION_BREACHED",
      severity: (o.severity ?? "WARN") as any,
      message: `Obligation breached: ${o.title} (${o.obligation_id}).`,
      details: {
        obligation_id: o.obligation_id,
        title: o.title,
        due_at: o.due_at ?? null,
        grace_seconds: o.grace_seconds ?? 0,
        status: o.status,
        owner_id: o.owner_id ?? null,
      },
    }));

    // Decide whether to block this event
    const shouldBlock =
      blockOn === "ANY_EVENT" ||
      (blockOn === "APPROVE" && event.type === "APPROVE");

    if (!shouldBlock) {
      // If not blocking, downgrade BLOCK severity to WARN so it doesn't stop workflow.
      const softened = violations.map((v) =>
        v.severity === "BLOCK" ? { ...v, severity: "WARN" as const } : v
      );
      return { ok: false, violations: softened };
    }

    return { ok: false, violations };
  };
}

/**
 * ✅ Feature 18: Autonomous agents can NEVER finalize (APPROVE/REJECT)
 * This is a defense-in-depth safety net even if RBAC/trust-boundary is bypassed.
 */
function agentCannotFinalizePolicy(): DecisionPolicy {
  return ({ event }) => {
    const actor_type = (event as any)?.actor_type;

    // Only care about agents
    if (actor_type !== "agent") return { ok: true };

    // Block finalization
    if (event.type === "APPROVE" || event.type === "REJECT") {
      return {
        ok: false,
        violations: [
          {
            code: "AGENT_CANNOT_FINALIZE",
            severity: "BLOCK",
            message: `Agent cannot ${event.type}. Requires human gate.`,
            details: {
              actor_id: (event as any)?.actor_id ?? null,
              actor_type,
              event_type: event.type,
            },
          },
        ],
      };
    }

    return { ok: true };
  };
}



