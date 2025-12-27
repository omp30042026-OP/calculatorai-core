import { createDecisionV2, applyDecisionEvent } from "../packages/decision/src/engine.js";

const d = createDecisionV2({
  decision_id: "dec_blocked",
  meta: { title: "Blocked", owner_id: "user_1" },
});

const r = applyDecisionEvent(d, { type: "APPROVE", actor_id: "user_1" } as const);
console.log(JSON.stringify(r, null, 2));

