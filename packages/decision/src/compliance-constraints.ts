// packages/decision/src/compliance-constraints.ts
import type { Decision } from "./decision.js";
import type { DecisionEvent } from "./events.js";
import type { PolicyViolation } from "./policy.js";

export type ComplianceSeverity = "INFO" | "WARN" | "BLOCK";

export type ComplianceContext = {
  jurisdiction?: string; // "US", "EU", "JP", etc.
  org_id?: string;
  policy_version?: string;
  now_iso?: string; // optional override for deterministic testing
};

export type ComplianceRule =
  | {
      type: "DISALLOW_EVENT_TYPES";
      event_types: string[];
      severity?: ComplianceSeverity;
      code?: string;
      message?: string;
    }
  | {
      type: "REQUIRE_EVENT_META_KEYS";
      event_types: string[];
      keys: string[];
      severity?: ComplianceSeverity;
      code?: string;
      message?: string;
    }
  | {
      type: "REQUIRE_DECISION_PATHS";
      // dot-paths into decision (e.g. "risk.owner_id", "meta.owner_id")
      paths: string[];
      severity?: ComplianceSeverity;
      code?: string;
      message?: string;
    }
  | {
      type: "THRESHOLD_BLOCK";
      // dot-path numeric field in decision, e.g. "risk.score"
      path: string;
      gte: number;
      // optional: apply only for these events (defaults to all)
      event_types?: string[];
      severity?: ComplianceSeverity; // usually BLOCK
      code?: string;
      message?: string;
    }
  | {
      type: "ALLOWLIST_ACTORS";
      // only these actors can perform event_types
      event_types: string[];
      allowed_actor_ids: string[];
      severity?: ComplianceSeverity;
      code?: string;
      message?: string;
    };

export type CompliancePolicy = {
  enabled?: boolean; // default true
  rules: ComplianceRule[];
};

function sev(rule: { severity?: ComplianceSeverity }, fallback: ComplianceSeverity) {
  return rule.severity ?? fallback;
}

function safeObj(v: unknown): Record<string, any> | null {
  return v && typeof v === "object" ? (v as any) : null;
}

function getAtPath(root: any, path: string): any {
  if (!root || typeof root !== "object") return undefined;
  const parts = path.split(".").filter(Boolean);
  let cur: any = root;
  for (const p of parts) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

function eventType(e: DecisionEvent): string {
  return (e as any)?.type ?? "UNKNOWN";
}

function actorId(e: DecisionEvent): string | null {
  const a = (e as any)?.actor_id;
  return typeof a === "string" ? a : null;
}

function eventMeta(e: DecisionEvent): Record<string, any> | null {
  return safeObj((e as any)?.meta);
}

export function evaluateComplianceConstraints(input: {
  policy: CompliancePolicy;
  decision: Decision;
  event: DecisionEvent;
  ctx?: ComplianceContext;
}): { ok: true } | { ok: false; violations: PolicyViolation[] } {
  const enabled = input.policy.enabled ?? true;
  if (!enabled) return { ok: true };

  const dAny = input.decision as any;
  const eAny = input.event as any;
  const et = eventType(input.event);

  const violations: PolicyViolation[] = [];

  for (const rule of input.policy.rules ?? []) {
    switch (rule.type) {
      case "DISALLOW_EVENT_TYPES": {
        if (rule.event_types.includes(et)) {
          violations.push({
            code: rule.code ?? "COMPLIANCE_EVENT_DISALLOWED",
            severity: sev(rule, "BLOCK"),
            message:
              rule.message ??
              `Compliance: event type ${et} is disallowed by policy.`,
          });
        }
        break;
      }

        case "REQUIRE_EVENT_META_KEYS": {
            if (!rule.event_types.includes(et)) break;

            const m = eventMeta(input.event) ?? {};
            const missing: string[] = [];

            for (const k of rule.keys) {
              if (typeof m[k] === "undefined" || m[k] === null || m[k] === "") {
                missing.push(k);
              }
            }

            if (missing.length) {
              violations.push({
                code: rule.code ?? "COMPLIANCE_META_REQUIRED",
                severity: sev(rule, "BLOCK"),
                message:
                    rule.message ??
                    `Compliance: event ${et} requires meta keys: ${missing.join(", ")}.`,
             });
            }

            break;
        }

      case "REQUIRE_DECISION_PATHS": {
        for (const p of rule.paths) {
          const v = getAtPath(dAny, p);
          const missing =
            typeof v === "undefined" || v === null || v === "";
          if (missing) {
            violations.push({
              code: rule.code ?? "COMPLIANCE_DECISION_DATA_REQUIRED",
              severity: sev(rule, "BLOCK"),
              message:
                rule.message ??
                `Compliance: decision is missing required field ${p}.`,
            });
          }
        }
        break;
      }

      case "THRESHOLD_BLOCK": {
        if (rule.event_types && !rule.event_types.includes(et)) break;
        const v = getAtPath(dAny, rule.path);
        const num = typeof v === "number" && Number.isFinite(v) ? v : null;
        if (num !== null && num >= rule.gte) {
          violations.push({
            code: rule.code ?? "COMPLIANCE_THRESHOLD_BLOCK",
            severity: sev(rule, "BLOCK"),
            message:
              rule.message ??
              `Compliance: ${rule.path}=${num} is >= ${rule.gte}; blocking ${et}.`,
          });
        }
        break;
      }

      case "ALLOWLIST_ACTORS": {
        if (!rule.event_types.includes(et)) break;
        const aid = actorId(input.event);
        if (!aid || !rule.allowed_actor_ids.includes(aid)) {
          violations.push({
            code: rule.code ?? "COMPLIANCE_ACTOR_NOT_ALLOWED",
            severity: sev(rule, "BLOCK"),
            message:
              rule.message ??
              `Compliance: actor is not allowed to perform ${et}.`,
          });
        }
        break;
      }

      default: {
        // unreachable
        break;
      }
    }
  }

  if (violations.length) return { ok: false, violations };
  return { ok: true };
}



















