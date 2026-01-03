import { transitionDecisionState } from "./state-machine.js";
import type { Decision } from "./decision.js";
import { createDecisionV2 } from "./decision.js";
import type { DecisionEvent } from "./events.js";
import type { DecisionPolicy, PolicyViolation } from "./policy.js";
import { defaultPolicies } from "./policy.js";

// ✅ Feature 14: Accountability hook
import { applyAccountability } from "./accountability.js";

export type DecisionEngineOptions = {
  policies?: DecisionPolicy[];
  now?: () => string; // ISO timestamp
};

export type ApplyEventResult =
  | { ok: true; decision: Decision; warnings: PolicyViolation[] }
  | { ok: false; decision: Decision; violations: PolicyViolation[] };

function isLockedState(s: Decision["state"]): boolean {
  return s === "APPROVED" || s === "REJECTED";
}

export function applyDecisionEvent(
  decision: Decision,
  event: DecisionEvent,
  opts: DecisionEngineOptions = {}
): ApplyEventResult {
  const now = opts.now ?? (() => new Date().toISOString());
  const policies = opts.policies ?? defaultPolicies();

  // 0) Locking: once approved/rejected, no more mutation
  if (isLockedState(decision.state)) {
    return {
      ok: false,
      decision,
      violations: [
        {
          code: "LOCKED_DECISION",
          severity: "BLOCK",
          message: `Decision is locked in state ${decision.state}; cannot apply ${event.type}.`,
        },
      ],
    };
  }

  // 1) Artifact attachment does not change state
  const isArtifactOnly = event.type === "ATTACH_ARTIFACTS";

  // 2) Compute next state unless artifact-only
  const nextState = isArtifactOnly
    ? decision.state
    : transitionDecisionState(decision.state, event.type);

  // Allow idempotent "same-state" replays/retries.
    // This is important for snapshot delta replay and safe retries.
    const IDEMPOTENT_SAME_STATE = new Set(["VALIDATE", "SIMULATE", "EXPLAIN"]);

    if (
    !isArtifactOnly &&
    nextState === decision.state &&
    event.type !== "REJECT" &&
    !IDEMPOTENT_SAME_STATE.has(event.type as string)
    ) {
    return {
        ok: false,
        decision,
        violations: [
        {
            code: "INVALID_TRANSITION",
            severity: "BLOCK",
            message: `Event ${event.type} is not valid from state ${decision.state}.`,
        },
        ],
    };
    }

  // 3) Run policies (BLOCK stops; WARN passes through)
  const warnings: PolicyViolation[] = [];
  const violations: PolicyViolation[] = [];

  for (const p of policies) {
    const r = p({ decision, event });
    if (!r.ok) {
      for (const v of r.violations) {
        if (v.severity === "WARN") warnings.push(v);
        else violations.push(v);
      }
    }
  }

  if (violations.length > 0) {
    return { ok: false, decision, violations };
  }

  // 4) Apply transition + audit event
  const nextBase: Decision = {
    ...decision,
    state: event.type === "REJECT" ? "REJECTED" : nextState,
    updated_at: now(),
    artifacts:
      event.type === "ATTACH_ARTIFACTS"
        ? {
            ...(decision.artifacts ?? {}),
            ...(event.artifacts ?? {}),
            extra: {
              ...((decision.artifacts as any)?.extra ?? {}),
              ...((event.artifacts as any)?.extra ?? {}),
            },
          }
        : decision.artifacts,
    history: [
      ...(decision.history ?? []),
      {
        at: now(),
        type: event.type,
        actor_id: event.actor_id ?? null,
        reason: "reason" in event ? (event.reason ?? null) : null,
        meta: event.meta ?? null,
      },
    ],
  };

  // ✅ Feature 14: update accountability AFTER building next state
  const next = applyAccountability(nextBase, event);

  return { ok: true, decision: next, warnings };
}

/**
 * Deterministic replay:
 * - Same starting decision + same events => same resulting decision (given deterministic `now`)
 */
export function replayDecision(
  start: Decision,
  events: DecisionEvent[],
  opts: DecisionEngineOptions = {}
): ApplyEventResult {
  let cur: Decision = start;
  let allWarnings: PolicyViolation[] = [];

  for (const e of events) {
    const r = applyDecisionEvent(cur, e, opts);
    if (!r.ok) return r;
    cur = r.decision;
    allWarnings = [...allWarnings, ...r.warnings];
  }

  return { ok: true, decision: cur, warnings: allWarnings };
}

// -------------------------
// V4: Forking / What-if
// -------------------------
export type ForkDecisionInput = {
  decision_id: string; // required id for the new fork
  meta?: Record<string, unknown>; // optional override (merged)
  artifacts?: Decision["artifacts"]; // optional override (merged)
};

/**
 * forkDecision:
 * - parent must NOT be REJECTED
 * - fork always starts at DRAFT
 * - version increments
 * - parent_decision_id is set
 * - copies meta/artifacts (merge overrides)
 * - history resets to []
 */
export function forkDecision(
  parent: Decision,
  input: ForkDecisionInput,
  opts: DecisionEngineOptions = {}
): Decision {
  if (parent.state === "REJECTED") {
    throw new Error(`Cannot fork a REJECTED decision (${parent.decision_id}).`);
  }

  const now = opts.now ?? (() => new Date().toISOString());

  const mergedMeta: Record<string, unknown> = {
    ...(parent.meta ?? {}),
    ...(input.meta ?? {}),
  };

  const mergedArtifacts: Decision["artifacts"] = {
    ...(parent.artifacts ?? {}),
    ...(input.artifacts ?? {}),
    extra: {
      ...(((parent.artifacts as any)?.extra ?? {}) as Record<string, unknown>),
      ...((((input.artifacts as any)?.extra ?? {}) as Record<string, unknown>)),
    },
  };

  // createDecisionV2 already initializes accountability from meta.owner_id (if present)
  return createDecisionV2(
    {
      decision_id: input.decision_id,
      parent_decision_id: parent.decision_id,
      version: (parent.version ?? 1) + 1,
      meta: mergedMeta,
      artifacts: mergedArtifacts as any,
    },
    now
  );
}

// Convenience creator for v2 users
export { createDecisionV2 };

