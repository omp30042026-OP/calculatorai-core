import { transitionDecisionState } from "./state-machine.js";
import type { Decision } from "./decision.js";
import type { DecisionEvent } from "./events.js";
import type { DecisionPolicy, PolicyViolation } from "./policy.js";
import { defaultPolicies } from "./policy.js";

export type DecisionEngineOptions = {
  policies?: DecisionPolicy[];
  now?: () => string; // ISO timestamp
};

export type CreateDecisionV2Input = {
  decision_id: string;
  meta?: Record<string, unknown>;
  artifacts?: Record<string, unknown>;
};

export type ApplyEventResult =
  | { ok: true; decision: Decision }
  | { ok: false; decision: Decision; violations: PolicyViolation[] };

/**
 * V2 constructor:
 * - meta + artifacts exist and default to {}
 * - history starts empty
 */
export function createDecisionV2(input: CreateDecisionV2Input, opts: DecisionEngineOptions = {}): Decision {
  const now = opts.now ?? (() => new Date().toISOString());
  return {
    decision_id: input.decision_id,
    state: "DRAFT",
    created_at: now(),
    updated_at: now(),
    meta: input.meta ?? {},
    artifacts: input.artifacts ?? {},
    history: [],
  };
}

/**
 * Applies a single event to a decision:
 * - enforces state machine
 * - runs policies
 * - appends audit history
 * - V2: writes artifact pointers when provided on events
 */
export function applyDecisionEvent(
  decision: Decision,
  event: DecisionEvent,
  opts: DecisionEngineOptions = {}
): ApplyEventResult {
  const now = opts.now ?? (() => new Date().toISOString());
  const policies = opts.policies ?? defaultPolicies();

  // 1) State transition (pure)
  const nextState = transitionDecisionState(decision.state, event.type);

  if (nextState === decision.state && event.type !== "REJECT") {
    return {
      ok: false,
      decision,
      violations: [
        {
          code: "INVALID_TRANSITION",
          message: `Event ${event.type} is not valid from state ${decision.state}.`,
        },
      ],
    };
  }

  // 2) Policies
  const violations: PolicyViolation[] = [];
  for (const p of policies) {
    const r = p({ decision, event });
    if (!r.ok) violations.push(...r.violations);
  }
  if (violations.length > 0) return { ok: false, decision, violations };

  // 3) Apply changes + audit
  const nextArtifacts: Record<string, unknown> = { ...(decision.artifacts ?? {}) };

  // V2 artifact hooks
  if (event.type === "SIMULATE") {
    if (event.simulation_snapshot_id) nextArtifacts.simulation_snapshot_id = event.simulation_snapshot_id;
  }
  if (event.type === "EXPLAIN") {
    if (event.explain_tree_id) nextArtifacts.explain_tree_id = event.explain_tree_id;
  }

  const next: Decision = {
    ...decision,
    state: event.type === "REJECT" ? "REJECTED" : nextState,
    updated_at: now(),
    artifacts: nextArtifacts,
    history: [
      ...(Array.isArray(decision.history) ? decision.history : []),
      {
        at: now(),
        type: event.type,
        actor_id: event.actor_id ?? null,
        reason: "reason" in event ? (event.reason ?? null) : null,
        meta: event.meta ?? null,
      },
    ],
  };

  return { ok: true, decision: next };
}


