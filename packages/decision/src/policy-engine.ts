// packages/decision/src/policy-engine.ts
export type Actor = { actor_id: string; actor_type: string; roles?: string[] };

export type PolicyContext = {
  decision_id: string;
  decision?: any;
  actor: Actor;
  event: any;
  now: string;
};

export type PolicyResult =
  | { ok: true }
  | { ok: false; code: string; message: string; details?: any };

export type PolicyEngine = {
  authorize(ctx: PolicyContext): PolicyResult;
};

// Simple RBAC + default deny for privileged events
const PRIVILEGED = new Set(["APPROVE", "REJECT", "PUBLISH", "COMMIT_COUNTERFACTUAL"]);

function hasRole(actor: Actor, role: string) {
  const roles = (actor.roles ?? []).map((r) => String(r).toLowerCase());
  return roles.includes(String(role).toLowerCase());
}

export function createDefaultPolicyEngine(params?: {
  // map event types -> allowed roles
  allow?: Record<string, string[]>;
  // if true, unknown events are allowed
  allowByDefault?: boolean;
}): PolicyEngine {
  const allow = params?.allow ?? {
    APPROVE: ["approver", "admin"],
    REJECT: ["approver", "admin"],
    PUBLISH: ["publisher", "admin"],
    COMMIT_COUNTERFACTUAL: ["admin"],

    // ✅ Feature 18 (optional RBAC)
    AGENT_PROPOSE: ["agent", "admin"],
    AGENT_TRIGGER_OBLIGATION: ["agent", "admin"],

  };
  const allowByDefault = params?.allowByDefault ?? true;

  return {
    authorize(ctx) {
      const type = String(ctx.event?.type ?? "");

      // system actor can always do internal operations
      if (ctx.actor.actor_type === "system") return { ok: true };


      // ✅ Feature 18: agents can never execute privileged events
      if (ctx.actor.actor_type === "agent") {
        if (PRIVILEGED.has(type)) {
          return {
            ok: false,
            code: "AGENT_PRIVILEGED_DENIED",
            message: `Agent cannot perform privileged event ${type}. Requires human gate.`,
            details: { event_type: type },
          };
        }

        // optionally: you can restrict agents to only agent events.
        // For now we allow non-privileged events (default behavior).
      }




      // non-privileged events: allow by default (you can tighten later)
      if (!PRIVILEGED.has(type)) {
        return allowByDefault ? { ok: true } : { ok: false, code: "POLICY_DENY_DEFAULT", message: "Denied by default" };
      }

      const roles = allow[type] ?? [];
      const ok = roles.some((r) => hasRole(ctx.actor, r));

      if (!ok) {
        return {
          ok: false,
          code: "RBAC_ROLE_REQUIRED",
          message: `Actor not authorized for ${type}`,
          details: { required_roles: roles, actor_roles: ctx.actor.roles ?? [] },
        };
      }

      return { ok: true };
    },
  };
}