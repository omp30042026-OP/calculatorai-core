export type DecisionState =
  | "DRAFT"
  | "VALIDATED"
  | "SIMULATED"
  | "EXPLAINED"
  | "APPROVED"
  | "REJECTED";

/**
 * IMPORTANT:
 * Keep this as "DecisionEventType" (NOT DecisionEvent),
 * because "DecisionEvent" is defined in events.ts and would conflict.
 */
export type DecisionEventType = "VALIDATE" | "SIMULATE" | "EXPLAIN" | "APPROVE" | "REJECT";

export function transitionDecisionState(state: DecisionState, event: DecisionEventType): DecisionState {
  switch (event) {
    case "VALIDATE":
      return state === "DRAFT" ? "VALIDATED" : state;

    case "SIMULATE":
      return state === "VALIDATED" ? "SIMULATED" : state;

    case "EXPLAIN":
      return state === "SIMULATED" ? "EXPLAINED" : state;

    case "APPROVE":
      return state === "EXPLAINED" ? "APPROVED" : state;

    case "REJECT":
      return "REJECTED";

    default:
      return state;
  }
}

