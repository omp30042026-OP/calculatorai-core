import { createDecisionV2 } from "../packages/decision/src/decision.js";
import { forkDecision } from "../packages/decision/src/engine.js";

function run() {
  const parent = createDecisionV2({
    decision_id: "dec_parent",
    meta: { title: "Promo Plan", owner_id: "user_1" },
    artifacts: { margin_snapshot_id: "m_001", extra: { note: "baseline" } },
    version: 1,
  });

  const child = forkDecision(parent, {
    decision_id: "dec_child_v2",
    meta: { title: "Promo Plan (What-if A)" }, // override/merge
    artifacts: { explain_tree_id: "tree_001", extra: { variant: "A" } },
  });

  console.log(
    JSON.stringify(
      {
        parent: {
          decision_id: parent.decision_id,
          version: parent.version,
          state: parent.state,
          parent_decision_id: parent.parent_decision_id ?? null,
          meta: parent.meta,
          artifacts: parent.artifacts,
          history_len: parent.history.length,
        },
        child: {
          decision_id: child.decision_id,
          version: child.version,
          state: child.state,
          parent_decision_id: child.parent_decision_id ?? null,
          meta: child.meta,
          artifacts: child.artifacts,
          history_len: child.history.length,
        },
      },
      null,
      2
    )
  );
}

run();

