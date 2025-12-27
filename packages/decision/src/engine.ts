import { transitionDecisionState } from "./state-machine.js";
import type { Decision } from "./decision.js";
import type { DecisionEvent } from "./events.js";
import type { DecisionPolicy, PolicyViolation } from "./policy.js";
import { defaultPolicies } from "./policy.js";

export type DecisionEngineOptions = {
  policies?: DecisionPolicy[];
  now?: () => string; // ISO timestamp
};

export type ApplyEventResult =
  | { ok: true; decision: Decision }
  | { ok: false; decision: Decision; violations: PolicyViolation[] };

export function applyDecisionEvent(
  decision: Decision,
  event: DecisionEvent,
  opts: DecisionEngineOptions = {}
): ApplyEventResult {
  const now = opts.now ?? (() => new Date().toISOString());
  const policies = opts.policies ?? defaultPolicies();

  // 1) Compute next state (pure transition)
  const nextState = transitionDecisionState(decision.state, event.type);

  // If transition is a no-op, treat it as a policy violation (strict deterministic behavior)
  if (nextState === decision.state && event.type !== "REJECT") {
    const violations: PolicyViolation[] = [
      {
        code: "INVALID_TRANSITION",
        message: `Event ${event.type} is not valid from state ${decision.state}.`,
      },
    ];
    return { ok: false, decision, violations };
  }

  // 2) Run policies (against the current decision + proposed event)
  const violations: PolicyViolation[] = [];
  for (const p of policies) {
    const r = p({ decision, event });
    if (!r.ok) violations.push(...r.violations);
  }

  if (violations.length > 0) {
    return { ok: false, decision, violations };
  }

  // 3) Apply transition + append audit event
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

