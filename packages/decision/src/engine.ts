import { transitionDecisionState } from "./state-machine.js";
import type { Decision } from "./decision.js";
import type { DecisionEvent } from "./events.js";
import type { DecisionPolicy, PolicyViolation } from "./policy.js";
import { defaultPolicies } from "./policy.js";

/**
 * Engine options
 */
export type DecisionEngineOptions = {
  policies?: DecisionPolicy[];
  now?: () => string; // ISO timestamp generator
};

/**
 * Result of applying an event
 */
export type ApplyEventResult =
  | { ok: true; decision: Decision }
  | { ok: false; decision: Decision; violations: PolicyViolation[] };

/**
 * Create a new Decision (v1)
 * This is the ONLY way a decision should be instantiated.
 */
export function createDecisionV1(input: {
  decision_id: string;
  meta?: Record<string, unknown>;
  created_at?: string;
}): Decision {
  const now = new Date().toISOString();

  return {
    decision_id: input.decision_id,
    state: "DRAFT",
    created_at: input.created_at ?? now,
    updated_at: input.created_at ?? now,
    meta: input.meta ?? {},
    history: [],
  };
}


/**
 * Apply a decision event with:
 * - deterministic state transition
 * - policy enforcement
 * - full audit history
 */
export function applyDecisionEvent(
  decision: Decision,
  event: DecisionEvent,
  opts: DecisionEngineOptions = {}
): ApplyEventResult {
  const now = opts.now ?? (() => new Date().toISOString());
  const policies = opts.policies ?? defaultPolicies();

  // 1) Compute next state (pure FSM)
  const nextState = transitionDecisionState(decision.state, event.type);

  // Invalid transition → hard failure (except REJECT which is terminal)
  if (nextState === decision.state && event.type !== "REJECT") {
    const violations: PolicyViolation[] = [
      {
        code: "INVALID_TRANSITION",
        message: `Event ${event.type} is not valid from state ${decision.state}.`,
      },
    ];
    return { ok: false, decision, violations };
  }

  // 2) Run policies
  const violations: PolicyViolation[] = [];
  for (const policy of policies) {
    const result = policy({ decision, event });
    if (!result.ok) violations.push(...result.violations);
  }

  if (violations.length > 0) {
    return { ok: false, decision, violations };
  }

  // 3) Apply transition + append audit entry
  const next: Decision = {
    ...decision,
    state: event.type === "REJECT" ? "REJECTED" : nextState,
    updated_at: now(),
    history: [
      ...(decision.history ?? []),
      {
        at: now(),
        type: event.type,
        actor_id: event.actor_id ?? null,
        reason: "reason" in event ? event.reason ?? null : null,
        meta: event.meta ?? null,
      },
    ],
  };

  return { ok: true, decision: next };
}


