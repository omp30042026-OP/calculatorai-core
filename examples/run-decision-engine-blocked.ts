import { createDecisionV1, applyDecisionEvent } from "../packages/decision/src/engine.js";

function main() {
  let d = createDecisionV1({ decision_id: "dec_blocked" });

  // invalid: trying to APPROVE from DRAFT
  const r = applyDecisionEvent(d, { type: "APPROVE", actor_id: "user_1" } as any);

  console.log(JSON.stringify(r, null, 2));
}

main();

