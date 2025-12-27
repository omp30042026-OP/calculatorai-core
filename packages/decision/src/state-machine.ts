export type DecisionState =
  | "DRAFT"
  | "VALIDATED"
  | "SIMULATED"
  | "EXPLAINED"
  | "APPROVED"
  | "REJECTED";

export type DecisionEventType =
  | "VALIDATE"
  | "SIMULATE"
  | "EXPLAIN"
  | "APPROVE"
  | "REJECT";

/**
 * Pure transition function.
 * - If invalid, returns same state (engine treats it as INVALID_TRANSITION).
 * - REJECT is handled by engine as terminal "REJECTED".
 */
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

