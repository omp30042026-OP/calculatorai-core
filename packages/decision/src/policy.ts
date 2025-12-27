import type { Decision } from "./decision.js";
import type { DecisionEvent } from "./events.js";

export type PolicyViolation = {
  code: string;
  message: string;
  meta?: Record<string, unknown> | null;
};

export type PolicyResult = { ok: true } | { ok: false; violations: PolicyViolation[] };

export type DecisionPolicy = (ctx: { decision: Decision; event: DecisionEvent }) => PolicyResult;

/**
 * Require certain meta keys to be present (and non-empty) before allowing VALIDATE.
 * This keeps the state machine pure and puts business rules in policies.
 */
export function requireMetaKeysBeforeValidate(
  requiredKeys: string[],
  opts: { allowEmptyString?: boolean } = {}
): DecisionPolicy {
  const allowEmptyString = opts.allowEmptyString ?? false;

  return ({ decision, event }) => {
    if (event.type !== "VALIDATE") return { ok: true };

    const meta = (decision.meta ?? {}) as Record<string, unknown>;
    const missing: string[] = [];

    for (const k of requiredKeys) {
      const v = meta[k];

      if (v == null) {
        missing.push(k);
        continue;
      }

      if (typeof v === "string") {
        const trimmed = v.trim();
        if (!allowEmptyString && trimmed.length === 0) missing.push(k);
        continue;
      }

      // If array -> must have items
      if (Array.isArray(v) && v.length === 0) {
        missing.push(k);
        continue;
      }
    }

    if (missing.length > 0) {
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
    }

    return { ok: true };
  };
}

/**
 * Default policies for the engine.
 * You can expand this over time (e.g., approvals, risk thresholds, etc.)
 */
export function defaultPolicies(): DecisionPolicy[] {
  return [
    // V2 core: required fields before VALIDATE
    requireMetaKeysBeforeValidate(["title", "owner_id"]),
  ];
}
