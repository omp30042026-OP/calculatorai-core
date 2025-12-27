export type DecisionState =
  | "DRAFT"
  | "PARSED"
  | "VALIDATED"
  | "SIMULATED"
  | "EXPLAINED"
  | "APPROVED"
  | "REJECTED";

export type DecisionEvent =
  | "PARSE"
  | "VALIDATE"
  | "SIMULATE"
  | "EXPLAIN"
  | "APPROVE"
  | "REJECT";

export function transition(state: DecisionState, event: DecisionEvent): DecisionState {
  switch (event) {
    case "PARSE":
      return state === "DRAFT" ? "PARSED" : state;
    case "VALIDATE":
      return state === "PARSED" ? "VALIDATED" : state;
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
