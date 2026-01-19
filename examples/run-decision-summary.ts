import { createDecisionV2, applyDecisionEvent } from "../packages/decision/src/engine.js";
import { getDecisionSummary } from "../packages/decision/src/observability.js";

function makeDeterministicNow(start = 1_700_000_000_000) {
  let t = start;
  return () => new Date(t++).toISOString();
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function main() {
  const now = makeDeterministicNow();
  let d = createDecisionV2({ decision_id: "dec_sum_1", meta: { owner_id: "user_1", title: "Summary Test" }, artifacts: {} }, now);

  for (const e of [
    { type: "VALIDATE", actor_id: "user_1" },
    { type: "ATTACH_ARTIFACTS", actor_id: "user_1", artifacts: { margin_snapshot_id: "m_001" } },
    { type: "EXPLAIN", actor_id: "user_1" },
  ] as any[]) {
    const r = applyDecisionEvent(d as any, e as any, { now });
    assert(r.ok, JSON.stringify(r, null, 2));
    d = r.decision;
  }

  console.log(JSON.stringify(getDecisionSummary(d as any), null, 2));
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});

