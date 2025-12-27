import type { Decision } from "./decision.js";
import type { DecisionEvent } from "./events.js";

export type PolicyViolation = {
  code: string;
  message: string;
};

export type PolicyResult =
  | { ok: true }
  | { ok: false; violations: PolicyViolation[] };

export type DecisionPolicy = (args: {
  decision: Decision;
  event: DecisionEvent;
}) => PolicyResult;

export function ok(): PolicyResult {
  return { ok: true };
}

export function fail(...violations: PolicyViolation[]): PolicyResult {
  return { ok: false, violations };
}

/**
 * v1 default policies: deterministic + minimal, but enterprise-grade.
 */
export function defaultPolicies(): DecisionPolicy[] {
  return [policyCannotApproveWithoutExplain(), policyCannotSimulateWithoutValidate()];
}

export function policyCannotApproveWithoutExplain(): DecisionPolicy {
  return ({ decision, event }) => {
    if (event.type !== "APPROVE") return ok();
    if (decision.state !== "EXPLAINED") {
      return fail({
        code: "APPROVE_REQUIRES_EXPLAINED",
        message: `Cannot APPROVE unless state is EXPLAINED. Current: ${decision.state}`,
      });
    }
    return ok();
  };
}

export function policyCannotSimulateWithoutValidate(): DecisionPolicy {
  return ({ decision, event }) => {
    if (event.type !== "SIMULATE") return ok();
    if (decision.state !== "VALIDATED") {
      return fail({
        code: "SIMULATE_REQUIRES_VALIDATED",
        message: `Cannot SIMULATE unless state is VALIDATED. Current: ${decision.state}`,
      });
    }
    return ok();
  };
}

