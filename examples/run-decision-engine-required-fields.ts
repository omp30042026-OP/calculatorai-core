import { createDecisionV2, applyDecisionEvent } from "../packages/decision/src/engine.js";

function main() {
  let d = createDecisionV2({ decision_id: "dec_req" });

  // Should fail (meta missing title + owner_id)
  console.log(applyDecisionEvent(d, { type: "VALIDATE", actor_id: "user_1" } as any));

  // Add required meta then validate
  d = { ...d, meta: { ...(d.meta ?? {}), title: "Promo Plan", owner_id: "user_1" } };

  console.log(applyDecisionEvent(d, { type: "VALIDATE", actor_id: "user_1" } as any));
}

main();

