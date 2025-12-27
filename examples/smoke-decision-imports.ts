import {
  createDecisionV2,
  applyDecisionEvent,
  replayDecision,
  DecisionSchema,
  DecisionEventSchema,
  transitionDecisionState,
} from "../packages/decision/src/index.js";

console.log("ok", typeof createDecisionV2, typeof applyDecisionEvent, typeof replayDecision, typeof transitionDecisionState);
console.log("schemas", !!DecisionSchema, !!DecisionEventSchema);
