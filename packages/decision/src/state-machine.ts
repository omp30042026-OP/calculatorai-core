export type DecisionState =
  | "DRAFT"
  | "VALIDATED"
  | "SIMULATED"
  | "EXPLAINED"
  | "APPROVED"
  | "REJECTED";

export type DecisionEvent =
  | { type: "VALIDATE" }
  | { type: "SIMULATE" }
  | { type: "EXPLAIN" }
  | { type: "APPROVE" }
  | { type: "REJECT" }
  | { type: "RESET" };

export function nextDecisionState(state: DecisionState, event: DecisionEvent): DecisionState {
  switch (event.type) {
    case "RESET":
      return "DRAFT";
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
