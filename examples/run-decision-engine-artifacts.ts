import { createDecisionV2, applyDecisionEvent } from "../packages/decision/src/engine.js";

let d = createDecisionV2({
  decision_id: "dec_artifacts",
  meta: { title: "Artifacts Demo", owner_id: "user_1" },
  artifacts: {},
});

const steps = [
  { type: "VALIDATE", actor_id: "user_1" } as const,
  { type: "SIMULATE", actor_id: "user_1", simulation_snapshot_id: "snap_001" } as const,
  { type: "EXPLAIN", actor_id: "user_1", explain_tree_id: "tree_001" } as const,
];

for (const e of steps) {
  const r = applyDecisionEvent(d, e);
  if (!r.ok) throw new Error(JSON.stringify(r, null, 2));
  d = r.decision;
}

console.log(JSON.stringify({ state: d.state, artifacts: d.artifacts }, null, 2));

