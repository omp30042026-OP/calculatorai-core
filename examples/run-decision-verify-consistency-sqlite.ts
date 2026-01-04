import { SqliteDecisionStore } from "../packages/decision/src/sqlite-store.js";
import { applyEventWithStore } from "../packages/decision/src/store-engine.js";
import { verifySnapshotConsistency } from "../packages/decision/src/store-verify-consistency.js";

async function main() {
  const store = new SqliteDecisionStore(":memory:");
  const decision_id = "dec_consistency_001";
  const snapshotPolicy = { every_n_events: 1 };

  await applyEventWithStore(store, {
    decision_id,
    event: { type: "VALIDATE", actor_id: "system" },
    snapshotStore: store,
    snapshotPolicy,
  });

  const snap1 = await store.getLatestSnapshot(decision_id);

  await applyEventWithStore(store, {
    decision_id,
    event: { type: "SIMULATE", actor_id: "system" },
    snapshotStore: store,
    snapshotPolicy,
  });

  const snap2 = await store.getLatestSnapshot(decision_id);

  if (!snap1 || !snap2) throw new Error("Snapshots missing");

  const result = await verifySnapshotConsistency(store, snap1, snap2);
  console.log(result);
}

main();

