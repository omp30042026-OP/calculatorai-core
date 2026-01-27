// packages/decision/src/state-machine.ts

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
  | "REJECT"
  | "ATTACH_ARTIFACTS"
  | "SIGN"
  | "INGEST_RECORDS"
  | "LINK_DECISIONS"
  | "ATTEST_EXTERNAL"
  | "ENTER_DISPUTE"
  | "EXIT_DISPUTE"
  // ✅ Feature 13: execution guarantees
  | "ADD_OBLIGATION"
  | "FULFILL_OBLIGATION"
  | "WAIVE_OBLIGATION"
  | "ATTEST_EXECUTION"
  | "SET_RISK"
  | "ADD_BLAST_RADIUS"
  | "ADD_IMPACTED_SYSTEM"
  | "SET_ROLLBACK_PLAN"
  // ✅ Feature 17: Trust Boundary foundation
  | "SET_TRUST_POLICY"
  | "ASSERT_TRUST_ORIGIN"
  // ✅ Feature 18: Autonomous Decision Agents
  | "AGENT_PROPOSE"
  | "AGENT_TRIGGER_OBLIGATION"
  | "SET_AMOUNT";

/**
 * Events that should NOT change DecisionState.
 * (They can still mutate artifacts/history/accountability.)
 */
export type NoStateChangeEventType =
  // diagnostics (no state change)
  | "VALIDATE"
  | "SIMULATE"
  | "EXPLAIN"
  // artifacts / misc
  | "ATTACH_ARTIFACTS"
  | "SIGN"
  | "INGEST_RECORDS"
  | "LINK_DECISIONS"
  | "ATTEST_EXTERNAL"
  | "ENTER_DISPUTE"
  | "EXIT_DISPUTE"
  // ✅ Feature 13
  | "ADD_OBLIGATION"
  | "FULFILL_OBLIGATION"
  | "WAIVE_OBLIGATION"
  | "ATTEST_EXECUTION"
  // ✅ Feature 15 (risk/amount patches)
  | "SET_RISK"
  | "ADD_BLAST_RADIUS"
  | "ADD_IMPACTED_SYSTEM"
  | "SET_ROLLBACK_PLAN"
  | "SET_AMOUNT"
  // ✅ Feature 17
  | "SET_TRUST_POLICY"
  | "ASSERT_TRUST_ORIGIN"
  // ✅ Feature 18
  | "AGENT_PROPOSE"
  | "AGENT_TRIGGER_OBLIGATION";

export function isNoStateChangeEvent(
  t: DecisionEventType
): t is NoStateChangeEventType {
  switch (t) {
    case "VALIDATE":
    case "SIMULATE":
    case "EXPLAIN":
    case "ATTACH_ARTIFACTS":
    case "SIGN":
    case "INGEST_RECORDS":
    case "LINK_DECISIONS":
    case "ATTEST_EXTERNAL":
    case "ENTER_DISPUTE":
    case "EXIT_DISPUTE":
    case "ADD_OBLIGATION":
    case "FULFILL_OBLIGATION":
    case "WAIVE_OBLIGATION":
    case "ATTEST_EXECUTION":
    case "SET_RISK":
    case "ADD_BLAST_RADIUS":
    case "ADD_IMPACTED_SYSTEM":
    case "SET_ROLLBACK_PLAN":
    case "SET_AMOUNT":
    case "SET_TRUST_POLICY":
    case "ASSERT_TRUST_ORIGIN":
    case "AGENT_PROPOSE":
    case "AGENT_TRIGGER_OBLIGATION":
      return true;

    default:
      return false;
  }
}

export function transitionDecisionState(
  state: DecisionState,
  eventType: DecisionEventType
): DecisionState {
  // ✅ anything in this set never changes decision.state
  if (isNoStateChangeEvent(eventType)) return state;

  switch (eventType) {
    case "APPROVE": {
      if (state === "REJECTED") return state;
      return "APPROVED";
    }
    case "REJECT": {
      return "REJECTED";
    }
    default: {
      const _exhaustive: never = eventType;
      return state;
    }
  }
}

