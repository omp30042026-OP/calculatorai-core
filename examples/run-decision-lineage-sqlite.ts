// examples/run-decision-lineage-sqlite.ts
import type { DecisionEngineOptions } from "../packages/decision/src/engine.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";
import { buildForkLineage } from "../packages/decision/src/store-lineage.js";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function makeDeterministicNow(startIso = "2025-01-01T00:00:00.000Z") {
  let t = Date.parse(startIso);
  return () => {
    const iso = new Date(t).toISOString();
    t += 1;
    return iso;
  };
}

async function main() {
  const store = new SqliteDecisionStore(":memory:");
  const now = makeDeterministicNow("2025-01-01T00:00:00.000Z");
  const opts: DecisionEngineOptions = { now };

  const rootId = "dec_root_lineage_001";
  const forkA = "dec_fork_A_001";
  const forkB = "dec_fork_B_001";

  // root create
  const r1 = await applyEventWithStore(
    store,
    {
      decision_id: rootId,
      metaIfCreate: { title: "Root", owner_id: "system", source: "lineage-demo" },
      event: { type: "VALIDATE", actor_id: "system" },
      idempotency_key: "root-validate-1",
    },
    opts
  );
  assert(r1.ok, "root validate failed");

  // Create fork A (we just create a new decision_id with meta pointing to parent)
  const r2 = await applyEventWithStore(
    store,
    {
      decision_id: forkA,
      metaIfCreate: {
        title: "Fork A",
        owner_id: "system",
        source: "lineage-demo",
        parent_decision_id: rootId, // 👈 lineage key
      },
      event: { type: "VALIDATE", actor_id: "system" },
      idempotency_key: "forkA-validate-1",
    },
    opts
  );
  assert(r2.ok, "forkA validate failed");

  // Create fork B off fork A
  const r3 = await applyEventWithStore(
    store,
    {
      decision_id: forkB,
      metaIfCreate: {
        title: "Fork B",
        owner_id: "system",
        source: "lineage-demo",
        parent_decision_id: forkA, // 👈 lineage key
      },
      event: { type: "VALIDATE", actor_id: "system" },
      idempotency_key: "forkB-validate-1",
    },
    opts
  );
  assert(r3.ok, "forkB validate failed");

  const lineage = await buildForkLineage(store, {
    root_decision_id: rootId,
    candidate_decision_ids: [rootId, forkA, forkB],
  });
  assert(lineage.ok, "lineage failed");

  console.log(JSON.stringify(lineage.lineage, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

