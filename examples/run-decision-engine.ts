import { createDecisionV1, applyDecisionEvent } from "../packages/decision/src/engine.js";

function main() {
  let d = createDecisionV1({ decision_id: "dec_1" });

  const events = [
    { type: "VALIDATE", actor_id: "user_1" },
    { type: "SIMULATE", actor_id: "user_1" },
    { type: "EXPLAIN", actor_id: "user_1" },
    { type: "APPROVE", actor_id: "user_1" },
  ] as const;

  for (const e of events) {
    const r = applyDecisionEvent(d, e as any);
    if (!r.ok) {
      console.log("❌ blocked", e.type, r.violations);
      return;
    }
    d = r.decision;
  }

  console.log("✅ final decision:", JSON.stringify(d, null, 2));
}

main();

