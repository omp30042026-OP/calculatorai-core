// packages/decision/src/state-machine.ts

import type { DecisionState } from "./decision.js";

export type DecisionEventType =
  | "VALIDATE"
  | "SIMULATE"
  | "EXPLAIN"
  | "APPROVE"
  | "REJECT"
  | "ATTACH_ARTIFACTS"
  | "SIGN"; // ✅ Feature 16

export function transitionDecisionState(
  current: DecisionState,
  eventType: DecisionEventType
): DecisionState {
  // ✅ Events that should NOT change state
  if (eventType === "ATTACH_ARTIFACTS" || eventType === "SIGN") return current;

  switch (current) {
    case "DRAFT": {
      if (eventType === "VALIDATE") return "VALIDATED";
      return current;
    }

    case "VALIDATED": {
      if (eventType === "SIMULATE") return "SIMULATED";
      if (eventType === "EXPLAIN") return "EXPLAINED";
      if (eventType === "APPROVE") return "APPROVED";
      if (eventType === "REJECT") return "REJECTED";
      return current;
    }

    case "SIMULATED": {
      if (eventType === "EXPLAIN") return "EXPLAINED";
      if (eventType === "APPROVE") return "APPROVED";
      if (eventType === "REJECT") return "REJECTED";
      return current;
    }

    case "EXPLAINED": {
      if (eventType === "APPROVE") return "APPROVED";
      if (eventType === "REJECT") return "REJECTED";
      return current;
    }

    case "APPROVED":
    case "REJECTED":
      return current;

    default:
      return current;
  }
}

