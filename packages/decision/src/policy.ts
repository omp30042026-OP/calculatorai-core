import type { Decision } from "./decision.js";
import type { DecisionEvent } from "./events.js";

export type PolicyViolation = {
  code: string;
  message: string;
  meta?: Record<string, unknown>;
};

export type PolicyResult =
  | { ok: true }
  | { ok: false; violations: PolicyViolation[] };

export type DecisionPolicy = (ctx: { decision: Decision; event: DecisionEvent }) => PolicyResult;

export function defaultPolicies(): DecisionPolicy[] {
  return [requireMetaOnValidatePolicy()];
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

    if (typeof meta.title !== "string" || meta.title.trim().length === 0) missing.push("title");
    if (typeof meta.owner_id !== "string" || meta.owner_id.trim().length === 0) missing.push("owner_id");

    if (missing.length === 0) return { ok: true };

    return {
      ok: false,
      violations: [
        {
          code: "MISSING_REQUIRED_FIELDS",
          message: `Cannot VALIDATE: missing required meta fields: ${missing.join(", ")}.`,
          meta: { missing },
        },
      ],
    };
  };
}

