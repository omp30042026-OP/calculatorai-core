import { createDecisionV2, applyDecisionEvent } from "../packages/decision/src/engine.js";

let d = createDecisionV2({
  decision_id: "dec_req",
  meta: {}, // missing title/owner_id
});

console.log(applyDecisionEvent(d, { type: "VALIDATE", actor_id: "user_1" } as const));

d = createDecisionV2({
  decision_id: "dec_req",
  meta: { title: "Promo Plan", owner_id: "user_1" },
});

console.log(applyDecisionEvent(d, { type: "VALIDATE", actor_id: "user_1" } as const));

